import { describe, expect, test } from "bun:test"
import {
  COCKPIT_REGIONS,
  MOBILE_TABS,
  cockpitActions,
  cockpitViewState,
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
      mode: false,
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
})
