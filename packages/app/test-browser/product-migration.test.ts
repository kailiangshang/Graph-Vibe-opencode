import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import h from "solid-js/h"
import type { ProductMigrationDraftPayload, ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"
import { ProductMigrationPage, type ProductMigrationController } from "@/pages/product-migration"

Object.assign(globalThis, { React: { createElement: h } })

const secret = "sk-live-never-render-this"
const transcript = "full transcript must stay private"
const draft: ProductMigrationProjection = {
  status: "draft",
  revision: 2,
  source: { database: "/home/user/.local/share/opencode/opencode.db", databaseBytes: 2_800_000_000, mixedGraph: true, sessionCount: 2 },
  plan: {
    revision: 2,
    sourceFingerprint: "fingerprint",
    categories: [
      { category: "config", available: true, selected: true, estimatedBytes: 1_024 },
      { category: "credentials", available: true, selected: true, estimatedBytes: 2_048 },
      { category: "mcp", available: true, selected: true, estimatedBytes: 4_096 },
      { category: "project", available: true, selected: true, estimatedBytes: 8_192 },
      { category: "session", available: true, selected: false, estimatedBytes: 32_000 },
      { category: "graph", available: true, selected: false, estimatedBytes: 16_000 },
    ],
    sessionsEnabled: false,
    projects: [{ id: "project-a", path: "/work/flight-control", sessionCount: 2, estimatedBytes: 48_000, current: true, sessions: [{ id: "session-a", title: "Inspect telemetry", updatedAt: 1, estimatedBytes: 12_400, hasGraph: true, selected: false }, { id: "session-b", title: "Repair actuator", updatedAt: 2, estimatedBytes: 35_600, hasGraph: false, selected: false }] }],
    requiredBytes: 15_360,
  },
  items: [],
  validation: null,
  completedItems: 0,
  totalItems: 4,
  canFinalize: false,
}

test("renders desktop source manifest and project/session master-detail without secrets", () => {
  const app = mount(draft)
  expect(app.root.getAttribute("aria-label")).toBe("Graph Vibe data transfer checkpoint")
  expect(app.root.textContent).toContain("OpenCode source")
  expect(app.root.textContent).toContain("2.6 GB")
  expect(app.root.textContent).toContain("Inspect telemetry")
  expect(app.root.textContent).toContain("Updated")
  expect(app.root.textContent).toContain("Available")
  expect(app.root.textContent).toContain("12.1 KB")
  expect(app.root.textContent).toContain("Sessions are off")
  expect(app.root.textContent).not.toContain(secret)
  expect(app.root.textContent).not.toContain(transcript)
  expect(app.root.querySelector('[data-slot="migration-projects"]')).not.toBeNull()
  expect(app.root.querySelector('[data-slot="migration-sessions"]')).not.toBeNull()
  app.dispose()
})

test("renders lifecycle status regions and failed item controls without raw errors", () => {
  const failed: ProductMigrationProjection = {
    ...draft,
    status: "failed",
    items: [{ itemID: "session:session-a", category: "session", sourceID: secret, targetID: null, status: "failed", selected: true, estimatedBytes: 12_400, error: `${secret} ${transcript}` }],
  }
  const app = mount(failed)
  expect(app.root.querySelector('[role="status"]')?.textContent).toContain("Transfer interrupted")
  expect(app.root.textContent).not.toContain(secret)
  expect(app.root.textContent).not.toContain(transcript)
  expect(app.root.querySelector('[aria-label="Retry failed session item"]')).not.toBeNull()
  expect(app.root.querySelector('[aria-label="Skip failed session item"]')).not.toBeNull()
  app.dispose()

  for (const state of ["copying", "paused", "validating", "ready_to_finalize", "completed"] as const) {
    const current = mount({ ...draft, status: state, canFinalize: state === "ready_to_finalize" })
    expect(current.root.querySelector('[role="status"]')).not.toBeNull()
    current.dispose()
  }
})

test("transitions from active pause control to validation after all copies complete", () => {
  const active = mount({ ...draft, status: "copying", completedItems: 2, totalItems: 4 })
  expect(active.root.querySelector('[data-action="pause"]')).not.toBeNull()
  expect(active.root.querySelector('[data-action="validate"]')).toBeNull()
  active.dispose()

  const copied = mount({ ...draft, status: "copying", completedItems: 4, totalItems: 4 })
  expect(copied.root.querySelector('[role="status"]')?.textContent).toContain("Copy complete; validation required")
  expect(copied.root.querySelector('[data-action="validate"]')).not.toBeNull()
  expect(copied.root.querySelector('[data-action="pause"]')).toBeNull()
  copied.dispose()
})

test("requires dialogs for finalization and fresh start", async () => {
  const calls: string[] = []
  const ready = mount({ ...draft, status: "ready_to_finalize", canFinalize: true }, calls)
  const trigger = ready.root.querySelector<HTMLButtonElement>('[data-action="finalize"]')!
  trigger.focus()
  trigger.click()
  await Bun.sleep(1)
  expect(ready.root.querySelector('[role="dialog"]')?.textContent).toContain("Finalize this import?")
  expect(calls).toEqual([])
  ready.root.querySelector<HTMLButtonElement>('[data-action="cancel-confirmation"]')!.click()
  expect(document.activeElement).toBe(trigger)
  trigger.click()
  await Bun.sleep(1)
  ready.root.querySelector<HTMLButtonElement>('[data-action="confirm-finalize"]')!.click()
  expect(calls).toEqual(["finalize"])
  ready.dispose()

  const fresh = mount({ ...draft, status: "undiscovered", source: null, plan: null }, calls)
  fresh.root.querySelector<HTMLButtonElement>('[data-action="fresh-start"]')!.click()
  await Bun.sleep(1)
  expect(fresh.root.querySelector('[role="dialog"]')?.textContent).toContain("Start without importing?")
  const labelledBy = fresh.root.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")
  expect(fresh.root.querySelector(`#${labelledBy}`)?.textContent).toBe("Start without importing?")
  fresh.root.querySelector<HTMLButtonElement>('[data-action="confirm-fresh-start"]')!.click()
  expect(calls.at(-1)).toBe("freshStart")
  fresh.dispose()
})

test("selects or clears every session in the current project", () => {
  const app = mount({ ...draft, plan: { ...draft.plan!, sessionsEnabled: true } })
  app.root.querySelector<HTMLButtonElement>('[data-action="select-project-sessions"]')!.click()
  expect(app.payloads.at(-1)?.sessions.every((session) => session.selected)).toBe(true)
  app.root.querySelector<HTMLButtonElement>('[data-action="clear-project-sessions"]')!.click()
  expect(app.payloads.at(-1)?.sessions.every((session) => !session.selected)).toBe(true)
  app.dispose()
})

test("shows category and named session progress without source identifiers", () => {
  const app = mount({
    ...draft,
    status: "copying",
    completedItems: 1,
    items: [
      { itemID: "config", category: "config", sourceID: null, targetID: null, status: "completed", selected: true, estimatedBytes: 1_024, error: null },
      { itemID: "session:secret-source", category: "session", sourceID: "session-a", targetID: null, status: "copying", selected: true, estimatedBytes: 12_400, error: null },
    ],
  })
  expect(app.root.textContent).toContain("Configuration: completed")
  expect(app.root.textContent).toContain("Inspect telemetry: copying")
  expect(app.root.textContent).not.toContain("secret-source")
  app.dispose()
})

test("keeps the immutable plan controls inactive after execution starts", () => {
  const app = mount({ ...draft, status: "copying", completedItems: 2 })
  expect([...app.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => input.disabled)).toBe(true)
  expect(app.root.querySelector('[data-action="fresh-start"]')).toBeNull()
  expect(app.root.querySelector('[data-action="finalize"]')).toBeNull()
  app.dispose()
})

test("offers a validated migration a return to selection before finalization", () => {
  const app = mount({ ...draft, status: "ready_to_finalize", canFinalize: true })
  app.root.querySelector<HTMLButtonElement>('[data-action="return-to-draft"]')!.click()
  expect(app.payloads).toHaveLength(1)
  expect(app.payloads[0]?.expectedRevision).toBe(draft.revision)
  app.dispose()
})

test("shows bounded validation issue codes and a legal validation retry", () => {
  const app = mount({
    ...draft,
    status: "failed",
    validation: { valid: false, issues: [{ code: "copied_file_hash", message: transcript }] },
  })
  expect(app.root.textContent).toContain("copied_file_hash")
  expect(app.root.textContent).not.toContain(transcript)
  expect(app.root.querySelector('[data-action="validate"]')).not.toBeNull()
  app.dispose()
})

test("provides mobile step navigation and 44px control targets", async () => {
  const app = mount(draft)
  const steps = [...app.root.querySelectorAll<HTMLButtonElement>('[data-slot="migration-mobile-step"]')]
  expect(steps.map((item) => item.textContent)).toEqual(["Manifest", "Projects", "Sessions", "Review"])
  expect(steps.every((item) => item.className.includes("min-h-11"))).toBe(true)
  steps[2]!.click()
  await Bun.sleep(1)
  expect(app.root.querySelector('[data-mobile-panel="sessions"]')?.getAttribute("data-active")).toBe("true")
  app.dispose()
})

function mount(projection: ProductMigrationProjection, calls: string[] = []) {
  const container = document.createElement("div")
  document.body.append(container)
  const payloads: ProductMigrationDraftPayload[] = []
  const controller: ProductMigrationController = {
    projection: () => projection,
    conflict: () => undefined,
    pending: () => false,
    discover: async () => calls.push("discover"),
    updateDraft: async (payload) => { payloads.push(payload); calls.push("updateDraft") },
    execute: async () => calls.push("execute"),
    pause: async () => calls.push("pause"),
    retry: async () => calls.push("retry"),
    skip: async () => calls.push("skip"),
    validate: async () => calls.push("validate"),
    finalize: async () => calls.push("finalize"),
    freshStart: async () => calls.push("freshStart"),
    refresh: async () => calls.push("refresh"),
  }
  const dispose = render(() => createComponent(ProductMigrationPage, { controller }), container)
  const root = container.querySelector("main")!
  return { root, payloads, dispose: () => { dispose(); container.remove() } }
}
