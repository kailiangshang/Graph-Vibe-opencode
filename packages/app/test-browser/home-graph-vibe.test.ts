import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { HomeGraphVibe } from "@/pages/home-graph-vibe"

Object.assign(globalThis, { React: { createElement: h } })

test("renders nothing when hidden", () => {
  const app = mount({ visible: false })
  expect(app.root.textContent).toBe("")
  expect(app.root.querySelector("button")).toBeNull()
  app.dispose()
})

test("presents the Graph workflow action and invokes its boundary", () => {
  const calls: string[] = []
  const app = mount({ visible: true, onStart: () => calls.push("start") })
  const button = app.root.querySelector("button")!

  expect(app.root.textContent).toContain("Graph-guided development")
  expect(button.textContent).toContain("Start Graph Workflow")
  expect(button.disabled).toBe(false)
  button.click()
  expect(calls).toEqual(["start"])
  app.dispose()
})

test("disables the action and announces workflow creation while pending", () => {
  const app = mount({ visible: true, pending: true })
  const button = app.root.querySelector("button")!

  expect(button.disabled).toBe(true)
  expect(button.textContent).toContain("Creating workflow…")
  expect(button.getAttribute("aria-busy")).toBe("true")
  app.dispose()
})

test("identifies the selected project", () => {
  const app = mount({ visible: true, projectName: "Telemetry Console" })
  expect(app.root.textContent).toContain("Selected project")
  expect(app.root.textContent).toContain("Telemetry Console")
  app.dispose()
})

test("presents the focused server capability", () => {
  const app = mount({ visible: true, capability: "Focused graph guidance" })
  expect(app.root.textContent).toContain("Focused graph guidance")
  expect(app.root.textContent).not.toContain("Graph-guided development")
  app.dispose()
})

test("keeps unavailable Graph Vibe visible while disabling its action", () => {
  const calls: string[] = []
  const app = mount({ visible: true, unavailable: true, onStart: () => calls.push("start") })
  const button = app.root.querySelector("button")!

  expect(app.root.textContent).toContain("Server unavailable")
  expect(button.textContent).toContain("Start Graph Workflow")
  expect(button.textContent).not.toContain("Creating workflow…")
  expect(button.disabled).toBe(true)
  expect(button.getAttribute("aria-busy")).toBe("false")
  button.click()
  expect(calls).toEqual([])
  app.dispose()
})

function mount(input: {
  visible: boolean
  pending?: boolean
  unavailable?: boolean
  projectName?: string
  capability?: string
  onStart?: () => void
}) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(HomeGraphVibe, {
        visible: input.visible,
        pending: input.pending ?? false,
        unavailable: input.unavailable ?? false,
        capability: input.capability ?? "Graph-guided development",
        get projectName() {
          return input.projectName
        },
        onStart: input.onStart ?? (() => {}),
      }),
    root,
  )
  return { root, dispose: () => { dispose(); root.remove() } }
}
