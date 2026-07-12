import { describe, expect, test } from "bun:test"
import {
  TASK_DRAFT,
  graphWebAvailable,
  graphWebUrl,
  formatWorkflowStatus,
  GRAPH_MODES,
  continueWorkflow,
  pauseWorkflow,
  startGraphPrompt,
  summarizeCurrentPlan,
} from "../src/graph/workflow"

describe("Graph Workflow", () => {
  test("provides the beginner task draft", () => {
    expect(TASK_DRAFT).toBe("What do you want to build or change?\n\nGoal:\nSuccess criteria:\nConstraints:")
  })

  test("writes and focuses the mounted prompt", () => {
    const calls: string[] = []

    expect(
      startGraphPrompt({
        set: (prompt) => calls.push(prompt.input),
        focus: () => calls.push("focus"),
      }),
    ).toBe(true)
    expect(calls).toEqual([TASK_DRAFT, "focus"])
    expect(startGraphPrompt(undefined)).toBe(false)
  })

  test("summarizes plan and diagnostic states in stable order", () => {
    expect(
      summarizeCurrentPlan([
        { status: "pending", testStatus: "none" },
        { status: "implemented", testStatus: "pending" },
        { status: "verified", testStatus: "passed" },
        { status: "deprecated", testStatus: "failed" },
        { status: "pending", testStatus: "failed" },
      ]),
    ).toEqual({
      total: 5,
      nodes: [
        ["Pending", 2],
        ["Implemented", 1],
        ["Verified", 1],
        ["Deprecated", 1],
      ],
      diagnostics: [
        ["None", 1],
        ["Pending", 1],
        ["Passed", 1],
        ["Failed", 2],
      ],
    })
  })

  test("returns an empty summary", () => {
    expect(summarizeCurrentPlan([]).total).toBe(0)
  })

  test("uses a directory route when Web serves the backend", () => {
    expect(
      graphWebUrl({
        webUrl: "http://localhost:4096",
        serverUrl: "http://localhost:4096",
        directory: "/work/project",
        sessionID: "ses_123",
      }),
    ).toBe("http://localhost:4096/L3dvcmsvcHJvamVjdA/session/ses_123/graph")
  })

  test("uses a server route for a separate Web origin", () => {
    expect(
      graphWebUrl({
        webUrl: "http://localhost:4444",
        serverUrl: "http://127.0.0.1:4096",
        directory: "/work/project",
        sessionID: "ses_123",
      }),
    ).toBe("http://localhost:4444/server/aHR0cDovLzEyNy4wLjAuMTo0MDk2/session/ses_123/graph")
  })

  test("uses the Vite-configured backend for an internal source TUI", () => {
    expect(
      graphWebUrl({
        webUrl: "http://localhost:4444",
        serverUrl: "http://opencode.internal",
        directory: "/work/project",
        sessionID: "ses_123",
        preferDirectoryRoute: true,
      }),
    ).toBe("http://localhost:4444/L3dvcmsvcHJvamVjdA/session/ses_123/graph")
  })

  test("checks Web availability before opening", async () => {
    expect(await graphWebAvailable(undefined, async () => new Response())).toBe(false)
    expect(await graphWebAvailable("http://localhost:4444", async () => new Response(null, { status: 200 }))).toBe(true)
    expect(await graphWebAvailable("http://localhost:4444", async () => new Response(null, { status: 503 }))).toBe(
      false,
    )
    expect(await graphWebAvailable("http://localhost:4444", async () => Promise.reject(new Error("offline")))).toBe(
      false,
    )

    const authorization: string[] = []
    await graphWebAvailable(
      "http://localhost:4444",
      async (_input, init) => {
        authorization.push(new Headers(init?.headers).get("authorization") ?? "")
        return new Response()
      },
      { authorization: "Basic token" },
    )
    expect(authorization).toEqual(["Basic token"])
  })

  test("reports a missing Web endpoint", () => {
    expect(
      graphWebUrl({
        serverUrl: "http://opencode.internal",
        directory: "/work/project",
        sessionID: "ses_123",
      }),
    ).toBeUndefined()
  })
})

describe("Graph collaboration status", () => {
  const workflow = {
    mode: "module" as const,
    revision: 7,
    phase: "checkpoint" as const,
    checkpoint: { status: "pending" as const, kind: "module" as const, reason: "Module verified" },
    currentTask: { id: "task-b", name: "Wire controls", moduleName: "Interaction", current: true },
    progress: { total: 3, verified: 1, failed: 0, percent: 33 },
    modules: [
      {
        id: "module-a",
        name: "Interaction",
        tasks: [
          { id: "task-a", name: "Add state", status: "verified", testStatus: "passed", current: false },
          { id: "task-b", name: "Wire controls", status: "pending", testStatus: "none", current: true },
        ],
      },
    ],
  }

  test("offers three modes with Module recommended by default", () => {
    expect(GRAPH_MODES).toEqual([
      { value: "atomic", label: "Atomic", description: "Pause after every verified task" },
      { value: "module", label: "Module", description: "Pause at module and decision checkpoints", recommended: true },
      { value: "autopilot", label: "Autopilot", description: "Run all tasks unless blocked or paused" },
    ])
  })

  test("formats durable mode, current task, evidence, checkpoint, and next action", () => {
    expect(formatWorkflowStatus(workflow)).toEqual({
      mode: "Module",
      phase: "Checkpoint",
      progress: "1/3 verified (33%)",
      current: "Interaction · Wire controls",
      checkpoint: "Module checkpoint: Module verified",
      nextAction: "Continue to authorize the next module.",
      modules: [
        {
          name: "Interaction",
          progress: "1/2",
          tasks: ["✓ Add state — verified", "→ Wire controls — pending · verification not run"],
        },
      ],
    })
    expect(JSON.stringify(formatWorkflowStatus(workflow))).not.toContain("graph_")
  })

  test("continues and pauses using the freshly fetched durable revision", async () => {
    const revisions: number[] = []
    const client = {
      graph: {
        workflow: async () => ({ data: { revision: 9 } }),
        workflowApprove: async (input: { graphWorkflowApprovePayload?: { expectedRevision: number } }) => {
          revisions.push(input.graphWorkflowApprovePayload!.expectedRevision)
          return { data: { revision: 10 } }
        },
        workflowPause: async (input: { graphWorkflowPausePayload?: { expectedRevision: number } }) => {
          revisions.push(input.graphWorkflowPausePayload!.expectedRevision)
          return { data: { revision: 10 } }
        },
      },
    }
    expect(await continueWorkflow(client, { session: "ses_1", directory: "/work" })).toMatchObject({ ok: true })
    expect(await pauseWorkflow(client, { session: "ses_1", directory: "/work" })).toMatchObject({ ok: true })
    expect(revisions).toEqual([9, 9])
  })

  test("refreshes projection and returns actionable copy after a stale revision", async () => {
    let reads = 0
    const client = {
      graph: {
        workflow: async () => ({ data: { revision: ++reads } }),
        workflowApprove: async () => ({ error: { _tag: "GraphWorkflowRevisionConflict" } }),
      },
    }
    expect(await continueWorkflow(client, { session: "ses_1", directory: "/work" })).toEqual({
      ok: false,
      conflict: true,
      workflow: { revision: 2 },
      message: "The plan changed before approval. Status was refreshed; review it and Continue again.",
    })
  })
})
