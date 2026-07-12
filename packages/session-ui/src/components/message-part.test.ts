import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { graphActivityInfo } from "./graph-activity"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("graphActivityInfo", () => {
  test("maps internal operations to user-facing workflow intent", () => {
    expect(graphActivityInfo("graph_plan_admit", {})).toEqual({ title: "Preparing work plan", phase: "planning" })
    expect(graphActivityInfo("graph_artifact_apply", { nodeName: "Keyboard controls" })).toEqual({
      title: "Applying task changes",
      phase: "implementing",
      summary: "Keyboard controls",
    })
    expect(graphActivityInfo("graph_diagnostics_run", { nodeName: "Keyboard controls" })).toEqual({
      title: "Verifying task",
      phase: "verifying",
      summary: "Keyboard controls",
    })
  })

  test("covers checkpoint, pause, and completion without exposing identifiers", () => {
    const activities = [
      graphActivityInfo("graph_build_gate", { checkpoint: "pending" }),
      graphActivityInfo("graph_workflow_pause", {}),
      graphActivityInfo("graph_promote", { verified: 4, total: 4 }),
    ]
    expect(activities.map((item) => item?.phase)).toEqual(["checkpoint", "paused", "complete"])
    expect(JSON.stringify(activities)).not.toContain("graph_")
  })
})
