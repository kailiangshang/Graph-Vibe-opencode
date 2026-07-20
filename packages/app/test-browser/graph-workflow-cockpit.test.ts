import { expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
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

test("renders valid checkpoint actions and dispatches task selection and locate", async () => {
  const matchMedia = window.matchMedia
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
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  const centerRequests: string[] = []
  let continued = 0
  let returned = 0
  let viewed = 0
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
        projectName: "Graph Vibe",
        sessionTitle: "Cockpit polish",
        onBackToSession: () => returned++,
        onViewChanges: () => viewed++,
        onCenterRequest: (id, token) => centerRequests.push(`${id}:${token}`),
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
  expect(root.textContent).toContain("Graph Vibe")
  expect(root.textContent).toContain("Cockpit polish")
  expect(root.textContent).toContain("Verify phase")
  expect(root.textContent).not.toContain("Pause")
  const progress = root.querySelector('[role="progressbar"]')
  expect(progress?.getAttribute("aria-valuemin")).toBe("0")
  expect(progress?.getAttribute("aria-valuemax")).toBe("100")
  expect(progress?.getAttribute("aria-valuenow")).toBe("0")

  root.querySelector<HTMLButtonElement>(".graph-action.primary")!.click()
  expect(continued).toBe(1)
  root.querySelector<HTMLButtonElement>(".graph-task")!.click()
  await Bun.sleep(1)
  expect(selected.at(-1)).toBe("task")
  expect(centerRequests).toEqual(["task:1"])
  root.querySelector<HTMLButtonElement>(".graph-locate")!.click()
  await Bun.sleep(1)
  expect(selected).toEqual(["task", "task"])
  expect(centerRequests).toEqual(["task:1", "task:2"])
  root.querySelector<HTMLButtonElement>(".graph-locate")!.click()
  await Bun.sleep(1)
  expect(centerRequests).toEqual(["task:1", "task:2", "task:3"])
  root.querySelector<HTMLButtonElement>('[aria-label="Back to session"]')!.click()
  root.querySelector<HTMLButtonElement>('[aria-label="View changes for Build rail"]')!.click()
  expect(returned).toBe(1)
  expect(viewed).toBe(1)
  dispose()
  root.remove()
  window.matchMedia = matchMedia
})

test("Main derives its rail and inspector from visible graph nodes without plan controls", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        source: "main",
        workflow,
        graph: {
          nodes: [
            {
              id: "main-only",
              name: "Released capability",
              type: "atomic",
              level: "L2",
              status: "verified",
              testStatus: "passed",
              priority: null,
              sessionID: null,
              desc: "Visible only in Main",
            },
          ],
          edges: [],
        },
        selectedNodeID: "main-only",
        onSelectNode: (id) => selected.push(id),
      }),
    root,
  )

  expect(root.textContent).toContain("Released capability")
  expect(root.textContent).toContain("Visible only in Main")
  expect(root.textContent).not.toContain("Build rail")
  expect(root.querySelector('[aria-label="Execution mode"]')).toBeNull()
  root.querySelector<HTMLButtonElement>(".graph-task")!.click()
  expect(selected).toEqual(["main-only"])
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
        workflow: {
          ...workflow,
          phase: "building",
          activeOperationKind: "artifact_apply",
          checkpoint: { status: "approved", kind: null },
        },
        graph: { nodes: [], edges: [] },
        selectedNodeID: null,
        onSelectNode: () => {},
        onPause: () => paused++,
      }),
    root,
  )
  expect(root.textContent).toContain("Pause")
  expect(root.textContent).toContain("Pause or wait for active workflow changes before changing execution mode")
  expect(root.textContent).not.toContain("Continue")
  ;[...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Pause")!.click()
  expect(paused).toBe(1)
  const inspectorPause = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Pause",
  )
  expect(inspectorPause).toBeDefined()
  dispose()
  root.remove()
})

test("renders no-mode, paused, failed, complete, and action-error states with valid actions", () => {
  const cases = [
    {
      name: "Execution mode required",
      value: { ...workflow, mode: null, phase: "planning", checkpoint: { status: "none", kind: null } },
      hasContinue: false,
      hasPause: false,
    },
    {
      name: "Workflow paused",
      value: { ...workflow, phase: "checkpoint", checkpoint: { status: "pending", kind: "pause" } },
      hasContinue: true,
      hasPause: false,
    },
    {
      name: "Workflow failed",
      value: { ...workflow, phase: "failed", checkpoint: { status: "none", kind: null } },
      hasContinue: false,
      hasPause: false,
    },
    {
      name: "Workflow complete",
      value: { ...workflow, phase: "complete", checkpoint: { status: "none", kind: null } },
      hasContinue: false,
      hasPause: false,
    },
  ] as const
  cases.forEach((item) => {
    const root = document.createElement("div")
    document.body.append(root)
    const dispose = render(
      () =>
        createComponent(GraphCockpit, {
          workflow: item.value,
          graph: graphWithTask(),
          selectedNodeID: "task",
          onSelectNode: () => {},
        }),
      root,
    )
    expect(root.textContent).toContain(item.name)
    expect([...root.querySelectorAll("button")].some((button) => button.textContent === "Continue")).toBe(
      item.hasContinue,
    )
    expect([...root.querySelectorAll("button")].some((button) => button.textContent === "Pause")).toBe(item.hasPause)
    dispose()
    root.remove()
  })

  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow,
        graph: graphWithTask(),
        selectedNodeID: "task",
        onSelectNode: () => {},
        actionError: "The workflow service could not be reached. Check the connection and retry this action.",
      }),
    root,
  )
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("could not be reached")
  dispose()
  root.remove()
})

test("mobile task activation retains Tasks and Locate recenters the same task", async () => {
  const matchMedia = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  const root = document.createElement("div")
  document.body.append(root)
  const centerRequests: string[] = []
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow,
        graph: graphWithTask(),
        selectedNodeID: null,
        onSelectNode: () => {},
        onCenterRequest: (id, token) => centerRequests.push(`${id}:${token}`),
      }),
    root,
  )
  root.querySelector<HTMLButtonElement>(".graph-task")!.click()
  await Bun.sleep(1)
  expect(centerRequests).toEqual([])
  root.querySelector<HTMLButtonElement>(".graph-locate")!.click()
  await Bun.sleep(1)
  root.querySelector<HTMLButtonElement>(".graph-locate")!.click()
  await Bun.sleep(1)
  expect(centerRequests).toEqual(["task:1", "task:2"])
  dispose()
  root.remove()
  window.matchMedia = matchMedia
})

test("keeps a long desktop task rail scrollable and preserves failed-current indicators across surfaces", () => {
  const failed = { ...task, status: "implemented", testStatus: "failed", buildable: false }
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    ...failed,
    id: `task-${index}`,
    name: `Overflow task ${index + 1}`,
    current: index === 0,
  }))
  const root = document.createElement("div")
  root.className = "dark"
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow: {
          ...workflow,
          currentTask: { id: "task-0", name: "Overflow task 1", moduleName: "UI" },
          tasks,
          modules: [{ id: "module", name: "UI", progress: { verified: 0, total: 30 }, tasks }],
        },
        graph: {
          nodes: tasks.map((item) => ({ ...graphWithTask().nodes[0], id: item.id, name: item.name })),
          edges: [],
        },
        selectedNodeID: "task-0",
        onSelectNode: () => {},
      }),
    root,
  )
  expect(root.querySelector(".graph-rail")?.classList.contains("overflow-y-auto")).toBe(true)
  expect(root.querySelectorAll(".graph-task")).toHaveLength(30)
  expect(root.textContent?.match(/Current · Selected · Failed · Blocked/g)?.length).toBeGreaterThanOrEqual(2)
  expect(root.closest(".dark")).not.toBeNull()
  dispose()
  root.remove()
})

test("renders the cockpit under both light and dark theme roots", () => {
  for (const theme of ["light", "dark"]) {
    const root = document.createElement("div")
    root.className = theme
    document.body.append(root)
    const dispose = render(
      () =>
        createComponent(GraphCockpit, {
          workflow,
          graph: graphWithTask(),
          selectedNodeID: "task",
          onSelectNode: () => {},
        }),
      root,
    )
    expect(root.querySelector('[aria-label="Graph workflow cockpit"]')).not.toBeNull()
    expect(root.classList.contains(theme)).toBe(true)
    dispose()
    root.remove()
  }
})

test("ships reduced-motion and reduced-transparency visual contracts", async () => {
  const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text()
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  expect(css).toContain("@media (prefers-reduced-transparency: reduce)")
  expect(css).toContain("backdrop-filter: none")
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
  expect(reduced.querySelector("canvas")?.getAttribute("data-animation-active")).toBe("false")
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
  expect(animated.querySelector("canvas")?.getAttribute("data-animation-active")).toBe("true")
  disposeAnimated()
  expect(cancelled).toContain(requested.at(-1))
  animated.remove()

  window.matchMedia = matchMedia
  window.requestAnimationFrame = requestAnimationFrame
  window.cancelAnimationFrame = cancelAnimationFrame
})

test("canvas redraws at positive dimensions after the mobile Graph tab becomes visible", () => {
  const originalResizeObserver = window.ResizeObserver
  const callbacks: ResizeObserverCallback[] = []
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { configurable: true, value: TestResizeObserver })
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        workflow,
        graph: graphWithTask(),
        selectedNodeID: null,
        onSelectNode: () => {},
      }),
    root,
  )
  const container = root.querySelector<HTMLElement>(".graph-canvas")!
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: 360 },
    clientHeight: { configurable: true, value: 240 },
  })
  root.querySelector<HTMLButtonElement>("#graph-tab-graph")!.click()
  expect(callbacks).toHaveLength(1)
  callbacks[0]?.([], {} as ResizeObserver)
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!
  expect(canvas.width).toBeGreaterThan(0)
  expect(canvas.height).toBeGreaterThan(0)
  dispose()
  root.remove()
  Object.defineProperty(window, "ResizeObserver", { configurable: true, value: originalResizeObserver })
})

test("selection and current-task changes redraw without restarting topology simulation", async () => {
  const requestAnimationFrame = window.requestAnimationFrame
  const cancelAnimationFrame = window.cancelAnimationFrame
  const requested: number[] = []
  window.requestAnimationFrame = (() => {
    requested.push(requested.length + 1)
    return requested.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame
  const [style, setStyle] = createSignal({ selected: null as string | null, current: null as string | null })
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(GraphCanvas, {
        graphID: "workflow-1",
        data: { nodes: [{ id: "task", name: "Task" }], edges: [] },
        get selectedNodeID() {
          return style().selected
        },
        get currentNodeID() {
          return style().current
        },
        onSelectNode: () => {},
      }),
    root,
  )
  const started = requested.length
  setStyle({ selected: "task", current: "task" })
  await Promise.resolve()
  expect(requested).toHaveLength(started)
  dispose()
  root.remove()
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

function graphWithTask() {
  return {
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
  }
}
