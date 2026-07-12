import { describe, expect, test } from "bun:test"
import {
  CURRENT_PLAN_EMPTY_MESSAGE,
  type GraphView,
  countByStatus,
  deterministicPosition,
  filterByLevel,
  normalizeWorkflow,
  reconcileSelection,
} from "./graph-helpers"

describe("countByStatus", () => {
  test("keeps internal tool names out of beginner guidance", () => {
    expect(CURRENT_PLAN_EMPTY_MESSAGE).toBe(
      "No Current Plan nodes yet. Describe your goal in Graph Vibe to create a plan.",
    )
    expect(CURRENT_PLAN_EMPTY_MESSAGE).not.toContain("graph_plan_admit")
  })

  test("counts nodes grouped by status", () => {
    const nodes = [
      { id: "a", status: "pending" },
      { id: "b", status: "pending" },
      { id: "c", status: "verified" },
    ] as GraphView["nodes"]

    expect(countByStatus(nodes)).toEqual({ pending: 2, verified: 1 })
  })

  test("returns empty object for empty array", () => {
    expect(countByStatus([])).toEqual({})
  })
})

describe("workflow cockpit helpers", () => {
  const workflow = {
    mode: "module" as const,
    revision: 4,
    phase: "building" as const,
    checkpoint: {
      status: "approved" as const,
      kind: "module" as const,
      scopeNodeID: "m1",
      scopeName: "UI",
      reason: null,
    },
    currentTask: null,
    progress: { total: 2, verified: 1, failed: 0, percent: 50 },
    modules: [
      {
        id: "m1",
        name: "UI",
        type: "composite" as const,
        status: "implemented" as const,
        taskIDs: ["b", "a"],
        tasks: [],
      },
    ],
    tasks: [
      {
        id: "b",
        name: "Second",
        order: 2,
        moduleID: "m1",
        moduleName: "UI",
        status: "pending",
        testStatus: "none",
        buildable: false,
        current: false,
        verification: null,
        latestEvidence: null,
      },
      {
        id: "a",
        name: "First",
        order: 1,
        moduleID: "m1",
        moduleName: "UI",
        status: "verified",
        testStatus: "passed",
        buildable: false,
        current: true,
        verification: { criteria: ["Visible result"], diagnostics: [{ name: "test" as const }] },
        latestEvidence: null,
      },
    ],
  }

  test("normalizes stable module and task ordering and repairs current task", () => {
    const view = normalizeWorkflow(workflow)
    expect(view.tasks.map((task) => task.id)).toEqual(["a", "b"])
    expect(view.modules[0]?.tasks.map((task) => task.id)).toEqual(["a", "b"])
    expect(view.currentTask?.id).toBe("a")
    expect(view.modules[0]?.progress).toEqual({ verified: 1, total: 2 })
  })

  test("falls back from removed selection to durable current task then first task", () => {
    const view = normalizeWorkflow(workflow)
    expect(reconcileSelection("removed", view.tasks, view.currentTask?.id)).toBe("a")
    expect(reconcileSelection(null, view.tasks, null)).toBe("a")
    expect(reconcileSelection(null, [], null)).toBeNull()
  })

  test("uses graph identity for deterministic initial positions", () => {
    expect(deterministicPosition("session-1", "task-a", 3)).toEqual(deterministicPosition("session-1", "task-a", 3))
    expect(deterministicPosition("session-1", "task-a", 3)).not.toEqual(deterministicPosition("session-2", "task-a", 3))
  })
})

describe("filterByLevel", () => {
  const data: GraphView = {
    nodes: [
      { id: "1", type: "prd", status: "pending" },
      { id: "2", type: "composite", status: "implemented" },
      { id: "3", type: "atomic", status: "verified" },
      { id: "4", type: "atomic", status: "pending" },
    ] as GraphView["nodes"],
    edges: [
      { id: "e1", sourceID: "1", targetID: "3", relation: "contains" },
      { id: "e2", sourceID: "3", targetID: "4", relation: "blocks" },
    ],
  }

  test("returns full data for 'all'", () => {
    const result = filterByLevel(data, "all")
    expect(result.nodes.length).toBe(4)
    expect(result.edges.length).toBe(2)
  })

  test("filters to prd + composite for L1", () => {
    const result = filterByLevel(data, "L1")
    expect(result.nodes.length).toBe(2)
    expect(result.nodes.every((n) => n.type === "prd" || n.type === "composite")).toBe(true)
    expect(result.edges.length).toBe(0)
  })

  test("filters to atomic for L2", () => {
    const result = filterByLevel(data, "L2")
    expect(result.nodes.length).toBe(2)
    expect(result.nodes.every((n) => n.type === "atomic")).toBe(true)
    expect(result.edges.length).toBe(1)
  })

  test("returns empty for undefined data", () => {
    expect(filterByLevel(undefined, "all")).toEqual({ nodes: [], edges: [] })
  })
})
