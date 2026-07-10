import { describe, expect, test } from "bun:test"
import {
  TASK_DRAFT,
  graphWebAvailable,
  graphWebUrl,
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
