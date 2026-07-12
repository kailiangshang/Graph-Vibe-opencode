import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { GraphCanvas } from "@/pages/graph-canvas"
import { GraphCockpit } from "@/pages/graph-cockpit"
import { deterministicPosition } from "@/pages/graph-helpers"

Object.assign(globalThis, { React: { createElement: h } })

const task = {
  id: "task",
  name: "Build rail",
  moduleID: "module",
  moduleName: "UI",
  status: "pending",
  testStatus: "none",
  buildable: true,
  current: true,
  verification: { criteria: ["Rail is visible"], diagnostics: [{ name: "test" }] },
  latestEvidence: null,
}

const workflow = {
  mode: "module" as const,
  revision: 1,
  phase: "checkpoint",
  checkpoint: { status: "pending", kind: "module", reason: "Module verified" },
  currentTask: { id: "task", name: "Build rail", moduleName: "UI" },
  progress: { verified: 0, total: 1, failed: 0, percent: 0 },
  tasks: [task],
  modules: [{ id: "module", name: "UI", progress: { verified: 0, total: 1 }, tasks: [task] }],
}

test("renders valid checkpoint actions and dispatches task selection and locate", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  let continued = 0
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow,
        graph: {
          nodes: [
            {
              id: "task",
              name: "Build rail",
              type: "atomic",
              level: "L2",
              status: "pending",
              testStatus: "none",
              priority: null,
              sessionID: "ses",
            },
          ],
          edges: [],
        },
        selectedNodeID: null,
        onSelectNode: (id) => selected.push(id),
        onContinue: () => continued++,
      }),
    root,
  )
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')]
  expect(tabs.map((tab) => [tab.id, tab.getAttribute("aria-controls")])).toEqual([
    ["graph-tab-tasks", "graph-panel-tasks"],
    ["graph-tab-graph", "graph-panel-graph"],
    ["graph-tab-details", "graph-panel-details"],
  ])
  expect(root.textContent).toContain("Continue")
  expect(root.textContent).not.toContain("Pause")

  root.querySelector<HTMLButtonElement>(".graph-action.primary")!.click()
  expect(continued).toBe(1)
  root.querySelector<HTMLButtonElement>(".graph-task")!.click()
  expect(selected.at(-1)).toBe("task")
  root.querySelector<HTMLButtonElement>(".graph-locate")!.click()
  expect(selected).toEqual(["task", "task"])
  dispose()
  root.remove()
})

test("renders Pause only for an active authorized workflow", () => {
  const root = document.createElement("div")
  document.body.append(root)
  let paused = 0
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow: { ...workflow, phase: "building", checkpoint: { status: "approved", kind: null } },
        graph: { nodes: [], edges: [] },
        selectedNodeID: null,
        onSelectNode: () => {},
        onPause: () => paused++,
      }),
    root,
  )
  expect(root.textContent).toContain("Pause")
  expect(root.textContent).not.toContain("Continue")
  root.querySelector<HTMLButtonElement>(".graph-action.secondary")!.click()
  expect(paused).toBe(1)
  dispose()
  root.remove()
})

test("canvas selects any node, double-click centers it, and empty selection returns to the caller", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  const centered: string[] = []
  const position = deterministicPosition("graph", "prd", 1)
  const dispose = render(
    () =>
      createComponent(GraphCanvas, {
        graphID: "graph",
        data: { nodes: [{ id: "prd", name: "Product goal", type: "prd" }], edges: [] },
        selectedNodeID: null,
        currentNodeID: null,
        onSelectNode: (id) => selected.push(id),
        onCenterNode: (id) => centered.push(id),
      }),
    root,
  )
  const canvas = root.querySelector("canvas")!
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
  })
  canvas.dispatchEvent(new MouseEvent("click", { clientX: position.x, clientY: position.y, bubbles: true }))
  expect(selected.at(-1)).toBe("prd")
  canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: position.x, clientY: position.y, bubbles: true }))
  expect(centered).toEqual(["prd"])
  expect(selected.at(-1)).toBe("prd")
  canvas.dispatchEvent(new MouseEvent("click", { clientX: 999, clientY: 999, bubbles: true }))
  expect(selected.at(-1)).toBeNull()
  dispose()
  root.remove()
})

test("pointer cancel clears panning and releases capture only when held", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  const position = deterministicPosition("pointer", "task", 1)
  const dispose = render(
    () =>
      createComponent(GraphCanvas, {
        graphID: "pointer",
        data: { nodes: [{ id: "task", name: "Task" }], edges: [] },
        selectedNodeID: null,
        currentNodeID: "task",
        onSelectNode: (id) => selected.push(id),
      }),
    root,
  )
  const canvas = root.querySelector("canvas")!
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
  })
  let released = 0
  Object.assign(canvas, {
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => released++,
  })
  canvas.dispatchEvent(pointer("pointerdown", 999, 999))
  canvas.dispatchEvent(pointer("pointercancel", 999, 999))
  canvas.dispatchEvent(new MouseEvent("click", { clientX: position.x, clientY: position.y, bubbles: true }))
  expect(released).toBe(0)
  expect(selected.at(-1)).toBe("task")
  dispose()
  root.remove()
})

test("reduced motion draws without RAF and normal motion cancels RAF on cleanup", () => {
  const matchMedia = window.matchMedia
  const requestAnimationFrame = window.requestAnimationFrame
  const cancelAnimationFrame = window.cancelAnimationFrame
  const requested: number[] = []
  const cancelled: number[] = []
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  window.requestAnimationFrame = ((_callback: FrameRequestCallback) => {
    requested.push(requested.length + 1)
    return requested.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => cancelled.push(id)) as typeof window.cancelAnimationFrame

  const reduced = document.createElement("div")
  document.body.append(reduced)
  const disposeReduced = render(() => canvasComponent(), reduced)
  expect(requested).toEqual([])
  disposeReduced()
  reduced.remove()

  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  const animated = document.createElement("div")
  document.body.append(animated)
  const disposeAnimated = render(() => canvasComponent(), animated)
  expect(requested.length).toBeGreaterThan(0)
  disposeAnimated()
  expect(cancelled).toContain(requested.at(-1))
  animated.remove()

  window.matchMedia = matchMedia
  window.requestAnimationFrame = requestAnimationFrame
  window.cancelAnimationFrame = cancelAnimationFrame
})

function canvasComponent() {
  return createComponent(GraphCanvas, {
    graphID: "lifecycle",
    data: { nodes: [{ id: "task", name: "Task" }], edges: [] },
    selectedNodeID: null,
    currentNodeID: "task",
    onSelectNode: () => {},
  })
}

function pointer(type: string, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { clientX, clientY, pointerId: 1 })
  return event
}
