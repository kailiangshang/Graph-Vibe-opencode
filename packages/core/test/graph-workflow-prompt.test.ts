import { describe, expect, test } from "bun:test"
import { GRAPH_WORKFLOW_PROMPT } from "../src/graph/workflow/prompt"

describe("Graph workflow prompt", () => {
  test("requires the complete collaborative plan before implementation", () => {
    expect(GRAPH_WORKFLOW_PROMPT).toContain("present the complete structured task list before implementation")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("current task")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("task-specific verification criteria")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("never show registered Graph tool identifiers to the user")
  })

  test("distinguishes all execution modes and defaults to module checkpoints", () => {
    expect(GRAPH_WORKFLOW_PROMPT).toContain("Atomic mode")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("Module mode")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("recommended default")
    expect(GRAPH_WORKFLOW_PROMPT).toContain("Autopilot mode")
    expect(GRAPH_WORKFLOW_PROMPT).toContain('"implement step by step"')
    expect(GRAPH_WORKFLOW_PROMPT).toContain('"run all tasks without pauses"')
    expect(GRAPH_WORKFLOW_PROMPT).not.toContain("Move to the next pending node")
  })
})
