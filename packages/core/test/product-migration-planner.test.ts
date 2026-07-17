import { expect, test } from "bun:test"
import { ProductMigrationPlanner } from "@opencode-ai/core/product-migration/planner"

test("selects configuration but requires opt-in for session migration", () => {
  const plan = ProductMigrationPlanner.plan(
    {
      sourceFingerprint: "source-1",
      databaseFingerprint: "database-1",
      database: "/source/opencode.db",
      mixedGraph: false,
      databaseBytes: 1000,
      sessionCount: 1,
      expected: {
        configPaths: ["graph-vibe.json"],
        configSources: [],
        auth: { path: "auth.json", sha256: "0".repeat(64) },
        mcpAuth: null,
        dependencies: [],
        credentialIDs: [],
      },
      categories: [
        { category: "config", available: true, estimatedBytes: 100 },
        { category: "credentials", available: true, estimatedBytes: 20 },
        { category: "mcp", available: false, estimatedBytes: 0 },
      ],
      projects: [
        {
          id: "project-1",
          path: "/workspace/current",
          sessionCount: 1,
          estimatedBytes: 880,
          sessions: [{ id: "session-1", title: "Current work", updatedAt: 100, estimatedBytes: 880, hasGraph: false }],
        },
      ],
    },
    { currentProject: "/workspace/current" },
  )

  expect(plan.categories).toEqual([
    { category: "config", selected: true, estimatedBytes: 100 },
    { category: "credentials", selected: true, estimatedBytes: 20 },
    { category: "mcp", selected: false, estimatedBytes: 0 },
  ])
  expect(plan.sessionsEnabled).toBe(false)
  expect(plan.projects[0].current).toBe(true)
  expect(plan.projects[0].sessions[0].selected).toBe(true)
  expect(JSON.stringify(plan)).not.toContain("secret")
})

test("preselects only the 50 most recent sessions when launched below the current project", () => {
  const sessions = Array.from({ length: 51 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    updatedAt: 1_000 - index,
    estimatedBytes: 1,
    hasGraph: false,
  }))
  const plan = ProductMigrationPlanner.plan(
    {
      sourceFingerprint: "source-1",
      databaseFingerprint: "database-1",
      database: "/source/opencode.db",
      mixedGraph: false,
      databaseBytes: 1000,
      sessionCount: sessions.length,
      expected: { configPaths: [], configSources: [], auth: null, mcpAuth: null, dependencies: [], credentialIDs: [] },
      categories: [],
      projects: [{ id: "project-1", path: "/workspace/current", sessionCount: sessions.length, estimatedBytes: 51, sessions }],
    },
    { currentProject: "/workspace/current/packages/app" },
  )

  expect(plan.projects[0].current).toBe(true)
  expect(plan.projects[0].sessions.filter((session) => session.selected)).toHaveLength(50)
  expect(plan.projects[0].sessions.at(-1)?.selected).toBe(false)
})
