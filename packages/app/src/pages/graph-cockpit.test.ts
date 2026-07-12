import { describe, expect, test } from "bun:test"
import { COCKPIT_REGIONS, MOBILE_TABS, cockpitViewState, workflowAnnouncement } from "./graph-cockpit"

describe("Graph cockpit view state", () => {
  test("distinguishes loading, disconnected, empty, checkpoint, paused, and complete", () => {
    expect(cockpitViewState({ loading: true })).toBe("loading")
    expect(cockpitViewState({ disconnected: true })).toBe("disconnected")
    expect(cockpitViewState({ workflow: { phase: "planning", tasks: [], checkpoint: { status: "none" } } })).toBe(
      "empty",
    )
    expect(
      cockpitViewState({
        workflow: { phase: "checkpoint", tasks: [{}], checkpoint: { status: "pending", kind: "module" } },
      }),
    ).toBe("checkpoint")
    expect(
      cockpitViewState({
        workflow: { phase: "checkpoint", tasks: [{}], checkpoint: { status: "pending", kind: "pause" } },
      }),
    ).toBe("paused")
    expect(cockpitViewState({ workflow: { phase: "complete", tasks: [{}], checkpoint: { status: "none" } } })).toBe(
      "complete",
    )
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
})
