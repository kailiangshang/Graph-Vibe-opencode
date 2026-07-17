import { expect, test } from "bun:test"
import type { ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"
import {
  formatMigrationBytes,
  migrationDraftPayload,
  migrationProgress,
  migrationView,
} from "./product-migration"

const projection: ProductMigrationProjection = {
  status: "draft",
  revision: 7,
  source: { database: "/safe/opencode.db", databaseBytes: 2_800_000_000, mixedGraph: false, sessionCount: 1 },
  plan: {
    revision: 7,
    sourceFingerprint: "fingerprint",
    categories: [
      { category: "config", available: true, selected: true, estimatedBytes: 1_000 },
      { category: "credentials", available: true, selected: true, estimatedBytes: 2_000 },
      { category: "mcp", available: true, selected: true, estimatedBytes: 3_000 },
      { category: "session", available: true, selected: false, estimatedBytes: 20_000 },
    ],
    sessionsEnabled: false,
    projects: [{ id: "p1", path: "/work/alpha", current: true, sessionCount: 1, estimatedBytes: 20_000, sessions: [{ id: "s1", title: "Safe title", updatedAt: 0, estimatedBytes: 20_000, hasGraph: true, selected: false }] }],
    requiredBytes: 6_000,
  },
  items: [],
  validation: null,
  completedItems: 0,
  totalItems: 3,
  canFinalize: false,
}

test("derives all screens only from the SDK projection", () => {
  expect(migrationView({ ...projection, status: "undiscovered" })).toBe("discover")
  expect(migrationView(projection)).toBe("selection")
  expect(migrationView({ ...projection, status: "copying" })).toBe("progress")
  expect(migrationView({ ...projection, status: "paused" })).toBe("paused")
  expect(migrationView({ ...projection, status: "failed" })).toBe("failed")
  expect(migrationView({ ...projection, status: "validating" })).toBe("validation")
  expect(migrationView({ ...projection, status: "ready_to_finalize" })).toBe("finalize")
  expect(migrationView({ ...projection, status: "completed" })).toBe("completed")
})

test("builds explicit session opt-in mutations without changing the projection", () => {
  expect(migrationDraftPayload(projection, { sessionsEnabled: true, sessionID: "s1", selected: true })).toEqual({
    expectedRevision: 7,
    categories: projection.plan!.categories.map((item) => ({ category: item.category, selected: item.selected })),
    sessionsEnabled: true,
    sessions: [{ projectID: "p1", sessionID: "s1", selected: true }],
  })
  expect(projection.plan?.sessionsEnabled).toBe(false)
  expect(projection.plan?.projects[0]?.sessions[0]?.selected).toBe(false)
})

test("omits unselected inventory rows from bounded draft mutations", () => {
  const sessions = Array.from({ length: 2_001 }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    updatedAt: index,
    estimatedBytes: 1,
    hasGraph: false,
    selected: false,
  }))
  const payload = migrationDraftPayload({
    ...projection,
    plan: { ...projection.plan!, projects: [{ ...projection.plan!.projects[0]!, sessionCount: sessions.length, sessions }] },
  })
  expect(payload.sessions).toEqual([])
})

test("formats transfer estimates and semantic progress", () => {
  expect(formatMigrationBytes(2_800_000_000)).toBe("2.6 GB")
  expect(migrationProgress({ ...projection, completedItems: 2, totalItems: 3 })).toEqual({ value: 2, max: 3, percent: 67 })
  expect(migrationProgress({ ...projection, completedItems: 0, totalItems: 0 })).toEqual({ value: 0, max: 1, percent: 0 })
})
