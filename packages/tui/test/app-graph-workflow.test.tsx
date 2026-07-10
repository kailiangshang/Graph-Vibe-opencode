import { afterEach, expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

const originalClient = process.env.OPENCODE_CLIENT
const originalGraph = process.env.OPENCODE_ENABLE_GRAPH_MODE

afterEach(() => {
  restore("OPENCODE_CLIENT", originalClient)
  restore("OPENCODE_ENABLE_GRAPH_MODE", originalGraph)
})

test("Graph Vibe registers Graph commands and renders onboarding", async () => {
  process.env.OPENCODE_CLIENT = "graph-vibe"
  process.env.OPENCODE_ENABLE_GRAPH_MODE = "1"
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers")
      return json({ providers: [{ id: "test", name: "Test", models: {} }], default: {} })
    if (url.pathname === "/provider") return json([])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://127.0.0.1:4096",
        webUrl: "http://localhost:4444",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    expect(
      api?.keymap
        .getCommands()
        .map((command) => command.name)
        .filter((name) => name.startsWith("graph.")),
    ).toEqual(["graph.guide", "graph.start", "graph.status", "graph.open"])
    expect(setup.captureCharFrame()).toContain("GRAPH WORKFLOW ACTIVE")
    expect(setup.captureCharFrame()).toContain("Plan → Build → Verify")

    api?.keymap.dispatchCommand("graph.guide")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Completion requires diagnostics to pass.")
    expect(setup.captureCharFrame()).not.toContain("graph_plan_admit")

    api?.keymap.dispatchCommand("help.show")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("/graph-start")
    expect(setup.captureCharFrame()).toContain("Powered by OpenCode")

    api?.keymap.dispatchCommand("opencode.status")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Graph Workflow")
    expect(setup.captureCharFrame()).toContain("Active")

    api?.keymap.dispatchCommand("graph.status")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Start or select a session")

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("OpenCode does not register Graph commands", async () => {
  process.env.OPENCODE_CLIENT = "cli"
  delete process.env.OPENCODE_ENABLE_GRAPH_MODE
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: createFetch().fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    expect(api?.keymap.getCommands().some((command) => command.name.startsWith("graph."))).toBe(false)
    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
