import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { graphActivityError, graphActivityInfo, graphPlanCard } from "./graph-activity"

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

  test("uses user-facing titles for graph failures", () => {
    expect(graphActivityInfo("graph_plan_admit", {}, "error")?.title).toBe("Work plan could not be prepared")
    expect(graphActivityInfo("graph_diagnostics_run", {}, "error")?.title).toBe("Task verification failed")
    expect(JSON.stringify(graphActivityInfo("graph_artifact_apply", {}, "error"))).not.toContain("graph_")
    expect(graphActivityInfo("graph_future_operation", {}, "error")?.title).toBe("Graph workflow activity failed")
    expect(graphActivityInfo("graph_future_operation", {})?.title).toBe("Graph workflow activity")
    expect(graphActivityError("graph_artifact_apply failed after graph_build_gate")).toBe(
      "Graph workflow activity failed after Graph workflow activity",
    )
  })

  test("builds a complete plan card from durable projection or admission input", () => {
    const bridge = graphPlanCard({
      nodes: [
        { id: "module", type: "composite", name: "Interface" },
        { id: "task", type: "atomic", name: "Build rail", verification: { criteria: ["Rail is visible"] } },
      ],
      edges: [{ sourceID: "module", targetID: "task", relation: "contains" }],
    })
    expect(bridge).toMatchObject({ modules: [{ name: "Interface", tasks: [{ name: "Build rail" }] }] })

    const durable = graphPlanCard(
      {},
      {
        mode: "module",
        phase: "building",
        currentTask: { id: "task", name: "Build rail", moduleName: "Interface" },
        checkpoint: { status: "approved", kind: "module" },
        modules: [
          {
            id: "module",
            name: "Interface",
            tasks: [{ id: "task", name: "Build rail", verification: { criteria: ["Rail is visible"] } }],
          },
        ],
      },
    )
    expect(durable).toMatchObject({ mode: "Module", currentTask: "Build rail", nextStop: "After the current module" })
  })
})
