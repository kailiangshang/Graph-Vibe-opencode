import { describe, expect, test } from "bun:test"
import {
  CURRENT_PLAN_EMPTY_MESSAGE,
  type GraphView,
  canPublishToMain,
  countByStatus,
  deterministicPosition,
  filterByLevel,
  groupWorkflowTasks,
  normalizeWorkflow,
  publicationScope,
  samePublicationScope,
  reconcileSelection,
  workflowMutationFailure,
  prefersReducedTransparency,
} from "./graph-helpers"

describe("publication scope", () => {
  const input = {
    directory: "/workspace",
    sessionID: "ses-1",
    pathname: "/workspace/session/ses-1/graph",
    revision: 4,
    planSource: "currentPlan" as const,
    sessionTitle: "Reviewed session",
    nodes: [{ id: "node-b" }, { id: "node-a" }],
    edges: [{ id: "edge-b" }, { id: "edge-a" }],
  }

  test("captures stable route, authority, title, counts, and topology identity", () => {
    expect(publicationScope(input)).toEqual({
      directory: "/workspace",
      sessionID: "ses-1",
      pathname: "/workspace/session/ses-1/graph",
      revision: 4,
      planSource: "currentPlan",
      sessionTitle: "Reviewed session",
      nodeCount: 2,
      edgeCount: 2,
      nodeIDs: ["node-a", "node-b"],
      edgeIDs: ["edge-a", "edge-b"],
    })
  })

  test("requires a new review when any captured publication authority changes", () => {
    const reviewed = publicationScope(input)
    expect(samePublicationScope(reviewed, publicationScope(input))).toBe(true)
    for (const changed of [
      { directory: "/other" },
      { sessionID: "ses-2" },
      { pathname: "/other" },
      { revision: 5 },
      { planSource: "version" as const },
      { sessionTitle: "Renamed session" },
      { nodes: [{ id: "node-a" }] },
      { edges: [{ id: "edge-c" }, { id: "edge-a" }] },
    ]) {
      expect(samePublicationScope(reviewed, publicationScope({ ...input, ...changed }))).toBe(false)
    }
  })
})

describe("canPublishToMain", () => {
  test("allows only a non-empty completed live plan", () => {
    expect(canPublishToMain({ phase: "complete", planSource: "currentPlan", nodeCount: 1 })).toBe(true)
  })

  test("rejects every ineligible phase, source, and node-count case", () => {
    expect(canPublishToMain({ phase: "planning", planSource: "currentPlan", nodeCount: 1 })).toBe(false)
    expect(canPublishToMain({ phase: "building", planSource: "currentPlan", nodeCount: 1 })).toBe(false)
    expect(canPublishToMain({ phase: "checkpoint", planSource: "currentPlan", nodeCount: 1 })).toBe(false)
    expect(canPublishToMain({ phase: "failed", planSource: "currentPlan", nodeCount: 1 })).toBe(false)
    expect(canPublishToMain({ phase: "complete", planSource: "version", nodeCount: 1 })).toBe(false)
    expect(canPublishToMain({ phase: "complete", planSource: "currentPlan", nodeCount: 0 })).toBe(false)
    expect(canPublishToMain({ phase: "complete", planSource: "currentPlan", nodeCount: -1 })).toBe(false)
  })
})

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

  test("groups by module identity and includes ungrouped tasks once", () => {
    const tasks = [
      { id: "a", moduleID: "m1", moduleName: "Same" },
      { id: "b", moduleID: "m2", moduleName: "Same" },
      { id: "c", moduleID: null, moduleName: null },
    ]
    expect(
      groupWorkflowTasks(tasks, [
        { id: "m1", name: "Same" },
        { id: "m2", name: "Same" },
      ]),
    ).toEqual([
      { id: "m1", name: "Same", tasks: [tasks[0]] },
      { id: "m2", name: "Same", tasks: [tasks[1]] },
      { id: null, name: "Ungrouped", tasks: [tasks[2]] },
    ])
  })

  test("normalizes module task IDs and removes duplicate task records", () => {
    const task = {
      id: "task-a",
      name: "Repeated name",
      order: 1,
      moduleID: null,
      moduleName: null,
      status: "pending",
      testStatus: "none",
      buildable: true,
      current: false,
      verification: null,
      latestEvidence: null,
    }
    const workflow = normalizeWorkflow({
      mode: "module",
      revision: 1,
      phase: "planning",
      checkpoint: { status: "none", kind: null, scopeNodeID: null, scopeName: null, reason: null },
      currentTask: null,
      progress: { total: 1, verified: 0, failed: 0, percent: 0 },
      tasks: [task, { ...task }],
      modules: [{ id: "module-a", name: "Interface", status: "pending", taskIDs: ["task-a"] }],
    })

    expect(workflow.tasks).toHaveLength(1)
    expect(workflow.modules).toHaveLength(1)
    expect(workflow.modules[0]?.tasks.map((item) => item.id)).toEqual(["task-a"])
    expect(workflow.modules[0]?.tasks[0]?.moduleID).toBe("module-a")
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

describe("workflowMutationFailure", () => {
  test("distinguishes stale revisions from active, invalid, rejected, and network failures", () => {
    expect(workflowMutationFailure("mode", { _tag: "GraphWorkflowRevisionConflict" })).toMatchObject({
      kind: "revision-conflict",
      refresh: true,
    })
    expect(workflowMutationFailure("mode", { _tag: "BadRequest" })).toEqual({
      kind: "active-workflow",
      refresh: false,
      message: "Execution mode cannot change while work is active. Pause the workflow first.",
    })
    expect(workflowMutationFailure("mode", { _tag: "GraphWorkflowActiveOperation" })).toEqual({
      kind: "active-workflow",
      refresh: false,
      message: "Workflow changes are active. Pause or wait for them to finish before changing execution mode.",
    })
    expect(workflowMutationFailure("continue", { _tag: "BadRequest" })).toMatchObject({ kind: "invalid-action" })
    expect(workflowMutationFailure("pause", { _tag: "BadRequest" })).toMatchObject({ kind: "apply-rejected" })
    expect(workflowMutationFailure("continue", new TypeError("fetch failed"))).toMatchObject({ kind: "network" })
    expect(workflowMutationFailure("continue", new Error("socket closed"))).toMatchObject({ kind: "network" })
    expect(workflowMutationFailure("continue", { _tag: "Unexpected" })).toMatchObject({ kind: "rejected" })
  })
})

test("detects the reduced-transparency media preference for deterministic page styling", () => {
  expect(prefersReducedTransparency((query) => ({ matches: query.includes("reduced-transparency") }))).toBe(true)
  expect(prefersReducedTransparency(() => ({ matches: false }))).toBe(false)
})
