/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { ProductMigrationProjection } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { TestTuiContexts } from "./fixture/tui-environment"
import { ThemeProvider } from "../src/context/theme"
import { TuiConfigProvider } from "../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../src/keymap"
import { KVProvider } from "../src/context/kv"
import {
  ProductMigrationView,
  formatMigrationBytes,
  migrationDraftPayload,
  pollMigrationProjection,
  productMigrationGateRequired,
} from "../src/component/dialog-product-migration"
import { Product } from "@opencode-ai/core/product"

const draft: ProductMigrationProjection = {
  status: "draft",
  revision: 3,
  source: { database: "/home/user/.local/share/opencode/opencode.db", databaseBytes: 2_800_000_000, mixedGraph: true, sessionCount: 2 },
  plan: {
    revision: 3,
    sourceFingerprint: "safe-fingerprint",
    categories: [
      { category: "config", available: true, selected: true, estimatedBytes: 1_024 },
      { category: "credentials", available: true, selected: true, estimatedBytes: 2_048 },
      { category: "mcp", available: true, selected: true, estimatedBytes: 4_096 },
      { category: "project", available: true, selected: true, estimatedBytes: 8_192 },
      { category: "session", available: true, selected: false, estimatedBytes: 32_000 },
      { category: "graph", available: true, selected: false, estimatedBytes: 16_000 },
    ],
    sessionsEnabled: false,
    projects: [
      {
        id: "project-a",
        path: "/work/flight-control",
        sessionCount: 2,
        estimatedBytes: 48_000,
        current: true,
        sessions: [
          { id: "session-a", title: "Inspect telemetry", updatedAt: 1, estimatedBytes: 12_400, hasGraph: true, selected: false },
          { id: "session-b", title: "Repair actuator", updatedAt: 2, estimatedBytes: 35_600, hasGraph: false, selected: false },
        ],
      },
    ],
    requiredBytes: 15_360,
  },
  items: [],
  validation: null,
  completedItems: 0,
  totalItems: 4,
  canFinalize: false,
}

test("formats human-readable estimates and keeps sessions disabled until explicit opt-in", () => {
  expect(formatMigrationBytes(1_536)).toBe("1.5 KB")
  const payload = migrationDraftPayload(draft, { sessionsEnabled: true })
  expect(payload.expectedRevision).toBe(3)
  expect(payload.sessionsEnabled).toBe(true)
  expect(payload.categories.slice(0, 3)).toEqual([
      { category: "config", selected: true },
      { category: "credentials", selected: true },
      { category: "mcp", selected: true },
  ])
  expect(draft.plan?.sessionsEnabled).toBe(false)
})

test("omits unselected inventory rows from bounded draft mutations", () => {
  const sessions = Array.from({ length: 2_001 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    updatedAt: index,
    estimatedBytes: 1,
    hasGraph: false,
    selected: false,
  }))
  const payload = migrationDraftPayload({
    ...draft,
    plan: { ...draft.plan!, projects: [{ ...draft.plan!.projects[0]!, sessionCount: sessions.length, sessions }] },
  })
  expect(payload.sessions).toEqual([])
})

test("formats typed migration failures without exposing raw details", async () => {
  const module = await import("../src/component/dialog-product-migration")
  const format = (module as unknown as { migrationErrorMessage?: (error: unknown) => string }).migrationErrorMessage
  expect(typeof format).toBe("function")
  expect(format?.({ _tag: "ProductMigrationSourceError", code: "changed", message: "secret path" })).toContain("changed")
  expect(format?.({ _tag: "ProductMigrationValidationFailed", issues: [{ code: "copied_file_hash", message: "secret" }] })).toContain("copied_file_hash")
  expect(format?.({ _tag: "ProductMigrationConflict", message: "sk-live-secret" })).not.toContain("sk-live-secret")
})

test("rejects an older action response after a newer pause projection", async () => {
  const module = await import("../src/component/dialog-product-migration")
  const current = (module as unknown as {
    migrationProjectionIsCurrent?: (candidate: ProductMigrationProjection, current: ProductMigrationProjection) => boolean
  }).migrationProjectionIsCurrent
  expect(typeof current).toBe("function")
  expect(current?.(
    { ...draft, status: "copying", revision: 5 },
    { ...draft, status: "paused", revision: 6 },
  )).toBe(false)
})

test("rejects equal-progress projections that regress an item to pending", async () => {
  const module = await import("../src/component/dialog-product-migration")
  const current = (module as unknown as {
    migrationProjectionIsCurrent: (candidate: ProductMigrationProjection, current: ProductMigrationProjection) => boolean
  }).migrationProjectionIsCurrent
  const item = { itemID: "category:config", category: "config" as const, sourceID: null, targetID: null, selected: true, estimatedBytes: 1, error: null }
  expect(current(
    { ...draft, status: "copying", revision: 6, items: [{ ...item, status: "pending" }] },
    { ...draft, status: "copying", revision: 6, items: [{ ...item, status: "copying" }] },
  )).toBe(false)
})

test("gates Graph Vibe before routing and skips OpenCode", () => {
  expect(productMigrationGateRequired(Product.GraphVibe)).toBe(true)
  expect(productMigrationGateRequired(Product.OpenCode)).toBe(false)
})

test("does not project a poll response after execute stops", async () => {
  let active = true
  const revisions: number[] = []
  await pollMigrationProjection({
    active: () => active,
    get: async () => {
      active = false
      return { ...draft, status: "copying", revision: 4 }
    },
    update: (projection) => revisions.push(Number(projection.revision)),
    wait: async () => {},
  })
  expect(revisions).toEqual([])
})

test("does not replace a newer migration action response with a stale poll", async () => {
  let active = true
  let current: ProductMigrationProjection = { ...draft, status: "paused", revision: 6 }
  const revisions: number[] = []
  await pollMigrationProjection({
    active: () => active,
    current: () => current,
    get: async () => {
      active = false
      return { ...draft, status: "copying", revision: 5 }
    },
    update: (projection) => {
      current = projection
      revisions.push(Number(projection.revision))
    },
    wait: async () => {},
  })
  expect(revisions).toEqual([])
})

test("does not replace newer equal-revision progress and tolerates transient poll errors", async () => {
  let active = true
  let waits = 0
  const current: ProductMigrationProjection = { ...draft, status: "copying", revision: 6, completedItems: 4 }
  const updates: number[] = []
  await pollMigrationProjection({
    active: () => active,
    current: () => current,
    get: async () => ({ ...current, completedItems: 2 }),
    update: (projection) => updates.push(Number(projection.completedItems)),
    wait: async () => {
      waits++
      if (waits === 2) active = false
    },
  })
  expect(updates).toEqual([])

  active = true
  waits = 0
  await expect(pollMigrationProjection({
    active: () => active,
    get: async () => { throw new Error("offline") },
    update: () => {},
    wait: async () => {
      waits++
      if (waits === 2) active = false
    },
  })).resolves.toBeUndefined()
})

test("renders source, default manifest, project/session estimates, and no secret values", async () => {
  const app = await mount(draft)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("TRANSFER CHECKPOINT")
    expect(frame).toContain("Config")
    expect(frame).toContain("Credentials")
    expect(frame).toContain("MCP")
    expect(frame).toContain("Sessions: disabled")
    expect(frame).toContain("flight-control")
    expect(frame).toContain("Inspect telemetry")
    expect(frame).toContain("Updated")
    expect(frame).toContain("Available")
    expect(frame).toContain("12.1 KB")
    expect(frame).not.toContain("sk-live-secret")
    expect(frame).not.toContain("full transcript")
  } finally {
    app.renderer.destroy()
  }
})

test("supports keyboard opt-in, pause/resume, failed retry/skip, and validation", async () => {
  const calls: string[] = []
  const app = await mount(draft, {
    onUpdateDraft: (payload) => calls.push(`sessions:${payload.sessionsEnabled}`),
    onExecute: () => calls.push("execute"),
    onPause: () => calls.push("pause"),
    onValidate: () => calls.push("validate"),
    onRetry: (itemID) => calls.push(`retry:${itemID}`),
    onSkip: (itemID) => calls.push(`skip:${itemID}`),
  })
  try {
    app.mockInput.pressKey("s")
    app.mockInput.pressKey("x")
    await app.renderOnce()
    expect(calls).toEqual(["sessions:true", "execute"])
  } finally {
    app.renderer.destroy()
  }

  const copying = await mount({ ...draft, status: "copying", completedItems: 2 }, { onPause: () => calls.push("pause") })
  copying.mockInput.pressKey("p")
  await copying.renderOnce()
  copying.renderer.destroy()
  const copied = await mount({ ...draft, status: "copying", completedItems: 4 }, { onValidate: () => calls.push("validate") })
  copied.mockInput.pressKey("v")
  await copied.renderOnce()
  copied.renderer.destroy()
  expect(calls).toEqual(["sessions:true", "execute", "pause", "validate"])

  const failed = { ...draft, status: "failed" as const, items: [{ itemID: "session:session-a", category: "session" as const, sourceID: "secret-source", targetID: null, status: "failed" as const, selected: true, estimatedBytes: 12_400, error: "sk-live-secret full transcript" }] }
  const failedApp = await mount(failed, {
    onRetry: (itemID) => calls.push(`retry:${itemID}`),
    onSkip: (itemID) => calls.push(`skip:${itemID}`),
  })
  try {
    expect(failedApp.captureCharFrame()).toContain("Copy failed")
    expect(failedApp.captureCharFrame()).not.toContain("sk-live-secret")
    failedApp.mockInput.pressKey("r")
    failedApp.mockInput.pressKey("k")
    await failedApp.renderOnce()
    expect(calls.slice(-2)).toEqual(["retry:session:session-a", "skip:session:session-a"])
  } finally {
    failedApp.renderer.destroy()
  }
})

test("offers validation after copying all selected items", async () => {
  const copied = await mount({ ...draft, status: "copying", completedItems: 4, totalItems: 4 })
  try {
    expect(copied.captureCharFrame()).toContain("Copy complete; validation required")
    expect(copied.captureCharFrame()).toContain("v Validate")
    expect(copied.captureCharFrame()).not.toContain("p Pause")
  } finally {
    copied.renderer.destroy()
  }
})

test("selects categories and project sessions entirely from the keyboard", async () => {
  const payloads: Array<ReturnType<typeof migrationDraftPayload>> = []
  const enabled = { ...draft, plan: { ...draft.plan!, sessionsEnabled: true } }
  const app = await mount(enabled, { onUpdateDraft: (payload) => payloads.push(payload) })
  try {
    app.mockInput.pressKey("1")
    app.mockInput.pressKey("a")
    app.mockInput.pressKey("u")
    app.mockInput.pressKey(" ")
    await app.renderOnce()
    expect(payloads[0]?.categories[0]).toEqual({ category: "config", selected: false })
    expect(payloads[1]?.sessions.every((item) => item.selected)).toBe(true)
    expect(payloads[2]?.sessions.every((item) => !item.selected)).toBe(true)
    expect(payloads[3]?.sessions.find((item) => item.sessionID === "session-a")?.selected).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("shows category and named session progress without source identifiers", async () => {
  const app = await mount({
    ...draft,
    status: "copying",
    completedItems: 1,
    items: [
      { itemID: "config", category: "config", sourceID: null, targetID: null, status: "completed", selected: true, estimatedBytes: 1_024, error: null },
      { itemID: "session:secret-source", category: "session", sourceID: "session-a", targetID: null, status: "copying", selected: true, estimatedBytes: 12_400, error: null },
    ],
  })
  try {
    expect(app.captureCharFrame()).toContain("Config: completed")
    expect(app.captureCharFrame()).toContain("Inspect telemetry: copying")
    expect(app.captureCharFrame()).not.toContain("secret-source")
  } finally {
    app.renderer.destroy()
  }
})

test("requires explicit confirmation for finalization and fresh start", async () => {
  const calls: string[] = []
  const ready = { ...draft, status: "ready_to_finalize" as const, canFinalize: true, completedItems: 4 }
  const app = await mount(ready, { onFinalize: () => calls.push("finalize"), onFreshStart: () => calls.push("fresh") })
  try {
    app.mockInput.pressKey("f")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Confirm final import")
    expect(calls).toEqual([])
    app.mockInput.pressKey("y")
    await app.renderOnce()
    expect(calls).toEqual(["finalize"])
  } finally {
    app.renderer.destroy()
  }

  const fresh = await mount({ ...draft, status: "undiscovered", plan: null, source: null }, { onFreshStart: () => calls.push("fresh") })
  try {
    fresh.mockInput.pressKey("z")
    await fresh.renderOnce()
    expect(fresh.captureCharFrame()).toContain("Confirm fresh start")
    fresh.mockInput.pressKey("y")
    await fresh.renderOnce()
    expect(calls.at(-1)).toBe("fresh")
  } finally {
    fresh.renderer.destroy()
  }
})

test("returns a validated migration to selection before finalization", async () => {
  const payloads: Array<ReturnType<typeof migrationDraftPayload>> = []
  const app = await mount({ ...draft, status: "ready_to_finalize", canFinalize: true }, {
    onUpdateDraft: (payload) => payloads.push(payload),
  })
  try {
    app.mockInput.pressKey("b")
    await app.renderOnce()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.expectedRevision).toBe(draft.revision)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps confirmation input modal", async () => {
  const calls: string[] = []
  const app = await mount({ ...draft, status: "ready_to_finalize", canFinalize: true }, {
    onUpdateDraft: () => calls.push("draft"),
    onFinalize: () => calls.push("finalize"),
  })
  try {
    app.mockInput.pressKey("f")
    app.mockInput.pressKey("b")
    await app.renderOnce()
    expect(calls).toEqual([])
    expect(app.captureCharFrame()).toContain("Confirm final import")
  } finally {
    app.renderer.destroy()
  }
})

test("registers mutation keys only while their actions are legal", async () => {
  const calls: string[] = []
  const app = await mount({ ...draft, status: "copying", completedItems: 2 }, {
    onDiscover: () => calls.push("discover"),
    onUpdateDraft: () => calls.push("draft"),
    onExecute: () => calls.push("execute"),
    onPause: () => calls.push("pause"),
    onRetry: () => calls.push("retry"),
    onSkip: () => calls.push("skip"),
    onFinalize: () => calls.push("finalize"),
    onFreshStart: () => calls.push("fresh"),
  })
  try {
    for (const key of ["d", "s", "1", " ", "x", "r", "k", "f", "z", "p", "p"]) app.mockInput.pressKey(key)
    await app.renderOnce()
    expect(calls).toEqual(["pause"])
  } finally {
    app.renderer.destroy()
  }
})

test("shows bounded validation issue codes and allows validation retry", async () => {
  const calls: string[] = []
  const app = await mount({
    ...draft,
    status: "failed",
    validation: { valid: false, issues: [{ code: "copied_file_hash", message: "sk-live-secret full transcript" }] },
  }, { onValidate: () => calls.push("validate") })
  try {
    expect(app.captureCharFrame()).toContain("copied_file_hash")
    expect(app.captureCharFrame()).not.toContain("full transcript")
    app.mockInput.pressKey("v")
    await app.renderOnce()
    expect(calls).toEqual(["validate"])
  } finally {
    app.renderer.destroy()
  }
})

test("shows refreshed stale-revision status and completed unlock state", async () => {
  const conflict = await mount(draft, { conflict: "Migration changed to revision 4. Review the refreshed plan." })
  try {
    expect(conflict.captureCharFrame()).toContain("revision 4")
    expect(conflict.captureCharFrame()).toContain("Review the refreshed plan")
  } finally {
    conflict.renderer.destroy()
  }
  const completed = await mount({ ...draft, status: "completed", completedItems: 4, canFinalize: false })
  try {
    expect(completed.captureCharFrame()).toContain("Migration complete")
    expect(completed.captureCharFrame()).toContain("Graph Vibe is unlocked")
  } finally {
    completed.renderer.destroy()
  }
})

async function mount(
  projection: ProductMigrationProjection,
  actions: Partial<Parameters<typeof ProductMigrationView>[0]> = {},
) {
  await mkdir("/tmp/opencode/state", { recursive: true })
  if (!(await Bun.file("/tmp/opencode/state/kv.json").exists())) await Bun.write("/tmp/opencode/state/kv.json", "{}")
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ProductMigrationView projection={projection} {...actions} />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 50, kittyKeyboard: true })
  await app.renderOnce()
  for (let attempt = 0; attempt < 5 && !app.captureCharFrame().trim(); attempt++) {
    await Bun.sleep(25)
    await app.renderOnce()
  }
  return app
}
