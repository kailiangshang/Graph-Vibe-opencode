import { describe, expect, test } from "bun:test"
import {
  COCKPIT_REGIONS,
  MOBILE_TABS,
  cockpitActions,
  cockpitViewState,
  enrichWorkflowNodes,
  workflowPhaseStep,
  rollupWorkflowStatus,
  workflowAnnouncement,
} from "./graph-cockpit"

describe("Graph cockpit view state", () => {
  test("distinguishes loading, disconnected, empty, checkpoint, paused, and complete", () => {
    expect(cockpitViewState({ loading: true })).toBe("loading")
    expect(cockpitViewState({ disconnected: true })).toBe("disconnected")
    expect(cockpitViewState({ workflow: { phase: "planning", tasks: [], checkpoint: { status: "none" } } })).toBe(
      "empty",
    )
    expect(
      cockpitViewState({
        workflow: {
          mode: "module",
          phase: "checkpoint",
          tasks: [{}],
          checkpoint: { status: "pending", kind: "module" },
        },
      }),
    ).toBe("checkpoint")
    expect(
      cockpitViewState({
        workflow: {
          mode: "module",
          phase: "checkpoint",
          tasks: [{}],
          checkpoint: { status: "pending", kind: "pause" },
        },
      }),
    ).toBe("paused")
    expect(
      cockpitViewState({
        workflow: { mode: "module", phase: "complete", tasks: [{}], checkpoint: { status: "none" } },
      }),
    ).toBe("complete")
    expect(
      cockpitViewState({ workflow: { mode: null, phase: "planning", tasks: [{}], checkpoint: { status: "none" } } }),
    ).toBe("mode-required")
    expect(
      cockpitViewState({
        workflow: { mode: "module", phase: "failed", tasks: [{}], checkpoint: { status: "none" } },
      }),
    ).toBe("failed")
  })

  test("shows only state-valid actions with independent pending state", () => {
    expect(
      cockpitActions(
        { mode: "module", phase: "checkpoint", checkpoint: { status: "pending", kind: "module" } },
        "continue",
      ),
    ).toEqual({ continue: true, pause: false, mode: true, continuePending: true, pausePending: false })
    expect(
      cockpitActions({ mode: "module", phase: "building", checkpoint: { status: "approved", kind: null } }, "pause"),
    ).toEqual({
      continue: false,
      pause: true,
      mode: true,
      continuePending: false,
      pausePending: true,
    })
    expect(cockpitActions({ mode: null, phase: "planning", checkpoint: { status: "none" } })).toMatchObject({
      continue: false,
      pause: false,
      mode: true,
    })
    expect(cockpitActions({ mode: null, phase: "checkpoint", checkpoint: { status: "pending" } })).toMatchObject({
      continue: false,
      pause: false,
    })
    expect(
      cockpitActions({
        mode: "atomic",
        phase: "building",
        activeOperationKind: null,
        checkpoint: { status: "approved" },
      }),
    ).toMatchObject({ mode: true })
    expect(
      cockpitActions({
        mode: "atomic",
        phase: "building",
        activeOperationKind: "artifact_apply",
        checkpoint: { status: "approved" },
      }),
    ).toMatchObject({ mode: false })
    expect(
      cockpitActions({ mode: "atomic", phase: "checkpoint", checkpoint: { status: "pending", kind: "module" } }),
    ).toMatchObject({ mode: true, continue: true })
  })

  test("announces current task, mode, and progress without internal names", () => {
    const text = workflowAnnouncement({
      mode: "module",
      phase: "building",
      currentTask: { name: "Build inspector", moduleName: "Interface" },
      progress: { verified: 2, total: 5, percent: 40 },
    })
    expect(text).toBe("Module mode. Building Build inspector in Interface. 2 of 5 tasks verified, 40 percent.")
    expect(text).not.toContain("graph_")
  })

  test("maps durable workflow phases to the Plan, Build, Verify product phases", () => {
    expect(workflowPhaseStep("planning")).toBe("Plan")
    expect(workflowPhaseStep("building")).toBe("Build")
    expect(workflowPhaseStep("checkpoint")).toBe("Verify")
    expect(workflowPhaseStep("complete")).toBe("Verify")
  })

  test("renders task, graph, and details instruments with synchronized selection", () => {
    expect(COCKPIT_REGIONS).toEqual(["Task rail", "Workflow graph", "Task details"])
    expect(MOBILE_TABS).toEqual(["tasks", "graph", "details"])
  })

  test("rolls composite and PRD display status up from atomic task verification", () => {
    expect(rollupWorkflowStatus([])).toBe("pending")
    expect(rollupWorkflowStatus([{ status: "pending", testStatus: "none" }])).toBe("pending")
    expect(rollupWorkflowStatus([{ status: "implemented", testStatus: "pending" }])).toBe("implemented")
    expect(rollupWorkflowStatus([{ status: "implemented", testStatus: "failed" }])).toBe("failed")
    expect(
      rollupWorkflowStatus([
        { status: "verified", testStatus: "passed" },
        { status: "verified", testStatus: "passed" },
      ]),
    ).toBe("verified")
  })

  test("enriches one shared node state without hiding failure on the current task", () => {
    const result = enrichWorkflowNodes({
      graph: {
        nodes: [
          {
            id: "task",
            name: "Build rail",
            type: "atomic",
            level: "L2",
            status: "pending",
            testStatus: "none",
            priority: null,
            sessionID: "ses",
          },
        ],
        edges: [],
      },
      workflow: {
        currentTask: { id: "task", name: "Build rail" },
        checkpoint: { status: "approved" },
        tasks: [
          {
            id: "task",
            name: "Build rail",
            status: "implemented",
            testStatus: "failed",
            current: true,
            buildable: false,
            verification: null,
            latestEvidence: null,
          },
        ],
        modules: [],
      },
      selectedNodeID: "task",
    })
    expect(result[0]).toMatchObject({
      current: true,
      selected: true,
      failed: true,
      blocked: true,
      verified: false,
      state: "failed",
      label: "Current · Selected · Failed · Blocked",
    })
  })
})
