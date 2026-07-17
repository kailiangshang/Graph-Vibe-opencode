import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { pollProductMigration, productMigrationResult } from "./server-sync"
import type { ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"

const migration: ProductMigrationProjection = {
  status: "undiscovered",
  revision: 0,
  source: null,
  plan: null,
  items: [],
  validation: null,
  completedItems: 0,
  totalItems: 0,
  canFinalize: false,
}

describe("productMigrationResult", () => {
  test("uses the generated projection as the required migration state", () => {
    expect(productMigrationResult({ data: migration })).toEqual({ kind: "required", projection: migration })
  })

  test("skips onboarding only for the explicit OpenCode unavailable response", () => {
    expect(productMigrationResult({ error: { _tag: "ProductMigrationUnavailable" } })).toEqual({
      kind: "unavailable",
    })
    expect(() => productMigrationResult({ error: new Error("network down") })).toThrow("network down")
  })
})

test("formats typed migration failures without exposing raw details", async () => {
  const module = await import("./server-sync")
  const format = (module as unknown as { productMigrationErrorMessage?: (error: unknown) => string })
    .productMigrationErrorMessage
  expect(typeof format).toBe("function")
  expect(format?.({ _tag: "ProductMigrationInsufficientSpace", requiredBytes: 2048, availableBytes: 1024 })).toContain(
    "2.0 KB required",
  )
  expect(format?.({ _tag: "ProductMigrationValidationFailed", issues: [{ code: "copied_file_hash", message: "secret" }] })).toContain(
    "copied_file_hash",
  )
  expect(format?.({ _tag: "ProductMigrationConflict", message: "sk-live-secret" })).not.toContain("sk-live-secret")
})

test("rejects an older action response after a newer pause projection", async () => {
  const module = await import("./server-sync")
  const current = (module as unknown as {
    productMigrationProjectionIsCurrent?: (candidate: ProductMigrationProjection, current: ProductMigrationProjection) => boolean
  }).productMigrationProjectionIsCurrent
  expect(typeof current).toBe("function")
  expect(current?.(
    { ...migration, status: "copying", revision: 4 },
    { ...migration, status: "paused", revision: 5 },
  )).toBe(false)
})

test("rejects equal-progress projections that regress an item to pending", async () => {
  const module = await import("./server-sync")
  const current = (module as unknown as {
    productMigrationProjectionIsCurrent: (candidate: ProductMigrationProjection, current: ProductMigrationProjection) => boolean
  }).productMigrationProjectionIsCurrent
  const item = { itemID: "category:config", category: "config" as const, sourceID: null, targetID: null, selected: true, estimatedBytes: 1, error: null }
  expect(current(
    { ...migration, status: "copying", revision: 5, items: [{ ...item, status: "pending" }] },
    { ...migration, status: "copying", revision: 5, items: [{ ...item, status: "copying" }] },
  )).toBe(false)
})

test("pollProductMigration ignores a response after execution stops", async () => {
  let active = true
  const revisions: number[] = []
  await pollProductMigration({
    active: () => active,
    get: async () => {
      active = false
      return { ...migration, status: "copying", revision: 1 }
    },
    update: (projection) => revisions.push(Number(projection.revision)),
    wait: async () => {},
  })
  expect(revisions).toEqual([])
})

test("pollProductMigration ignores a projection older than the current action response", async () => {
  let active = true
  let current: ProductMigrationProjection = { ...migration, status: "paused", revision: 5 }
  const revisions: number[] = []
  await pollProductMigration({
    active: () => active,
    current: () => current,
    get: async () => {
      active = false
      return { ...migration, status: "copying", revision: 4 }
    },
    update: (projection) => {
      current = projection
      revisions.push(Number(projection.revision))
    },
    wait: async () => {},
  })
  expect(revisions).toEqual([])
})

test("pollProductMigration ignores equal-revision progress older than the current response", async () => {
  let active = true
  let waits = 0
  const current: ProductMigrationProjection = { ...migration, status: "copying", revision: 5, completedItems: 4 }
  const revisions: number[] = []
  await pollProductMigration({
    active: () => active,
    current: () => current,
    get: async () => ({ ...current, completedItems: 2 }),
    update: (projection) => revisions.push(Number(projection.completedItems)),
    wait: async () => {
      waits++
      if (waits === 2) active = false
    },
  })
  expect(revisions).toEqual([])
})

test("pollProductMigration tolerates a transient checkpoint read failure", async () => {
  let active = true
  let waits = 0
  await expect(
    pollProductMigration({
      active: () => active,
      get: async () => {
        throw new Error("offline")
      },
      update: () => {},
      wait: async () => {
        waits++
        if (waits === 2) active = false
      },
    }),
  ).resolves.toBeUndefined()
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
