/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { TestTuiContexts } from "./fixture/tui-environment"
import type { Workflow } from "../src/graph/workflow"
import { GraphStatusView } from "../src/component/dialog-graph-status"
import { ThemeProvider } from "../src/context/theme"
import { TuiConfigProvider } from "../src/config"
import { KVProvider } from "../src/context/kv"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../src/keymap"

const checkpoint: Workflow = {
  mode: "module",
  revision: 8,
  phase: "checkpoint",
  checkpoint: { status: "pending", kind: "module", reason: "Interface verified" },
  currentTask: { id: "task-b", name: "Wire controls", moduleName: "Interface", current: true },
  progress: { total: 2, verified: 1, failed: 0, percent: 50 },
  modules: [
    {
      id: "module",
      name: "Interface",
      tasks: [
        { id: "task-a", name: "Build rail", status: "verified", testStatus: "passed", current: false },
        { id: "task-b", name: "Wire controls", status: "pending", testStatus: "none", current: true },
      ],
    },
  ],
}

test("status dialog retains refreshed conflict state and requires a second Continue", async () => {
  let continued = 0
  const app = await mount(
    checkpoint,
    "The plan changed from revision 7 to 8.",
    () => continued++,
    () => {},
  )
  try {
    expect(app.captureCharFrame()).toContain("Mode: Module")
    expect(app.captureCharFrame()).toContain("The plan changed from revision 7 to 8.")
    expect(app.captureCharFrame()).toContain("press the action key again")
    expect(app.captureCharFrame()).toContain("c Continue")
    expect(app.captureCharFrame()).not.toContain("p Pause")
    expect(continued).toBe(0)
    app.mockInput.pressKey("c")
    expect(continued).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("status dialog binds Pause only while work is active and hides actions before mode selection", async () => {
  let paused = 0
  const active = { ...checkpoint, phase: "building", checkpoint: { status: "approved" } }
  const app = await mount(
    active,
    undefined,
    () => {},
    () => paused++,
  )
  try {
    expect(app.captureCharFrame()).toContain("p Pause")
    expect(app.captureCharFrame()).not.toContain("c Continue")
    app.mockInput.pressKey("p")
    expect(paused).toBe(1)
  } finally {
    app.renderer.destroy()
  }

  const noMode = await mount(
    { ...active, mode: null, phase: "planning", checkpoint: { status: "none" } },
    undefined,
    () => {},
    () => {},
  )
  try {
    expect(noMode.captureCharFrame()).toContain("Mode: Not selected")
    expect(noMode.captureCharFrame()).not.toContain("c Continue")
    expect(noMode.captureCharFrame()).not.toContain("p Pause")
  } finally {
    noMode.renderer.destroy()
  }
})

test("status dialog disables a pending action and ignores rapid duplicate keys", async () => {
  let continued = 0
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const app = await mount(
    checkpoint,
    undefined,
    () => {
      continued++
      return pending
    },
    () => {},
  )
  try {
    app.mockInput.pressKey("c")
    app.mockInput.pressKey("c")
    await waitFor(() => app.captureCharFrame().includes("Continuing..."), () => app.renderOnce())
    expect(continued).toBe(1)
    expect(app.captureCharFrame()).not.toContain("c Continue")
    resolve()
    await waitFor(() => app.captureCharFrame().includes("c Continue"), () => app.renderOnce())
  } finally {
    app.renderer.destroy()
  }
})

async function mount(workflow: Workflow, conflict: string | undefined, onContinue: () => unknown, onPause: () => unknown) {
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
                <GraphStatusView
                  workflow={workflow}
                  conflict={conflict}
                  onContinue={onContinue}
                  onPause={onPause}
                  onClose={() => {}}
                />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  const mode = workflow.mode ? `Mode: ${workflow.mode[0].toUpperCase()}${workflow.mode.slice(1)}` : "Mode: Not selected"
  await waitFor(() => app.captureCharFrame().includes(mode), () => app.renderOnce())
  return app
}

async function waitFor(check: () => boolean | Promise<boolean>, update: () => void | Promise<void>, timeout = 2000) {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Timed out waiting for Graph status readiness")
    await update()
    await Bun.sleep(5)
  }
}
