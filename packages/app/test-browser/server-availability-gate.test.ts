import { expect, test } from "bun:test"
import { createComponent, createEffect, createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { ServerAvailabilityGate } from "@/components/server-availability-gate"

Object.assign(globalThis, { React: { createElement: h } })

test("keeps the server subtree mounted while health details update", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const [health, setHealth] = createSignal<{ name: string } | undefined>({ name: "Graph Vibe" })
  let mounts = 0

  const Marker = () => {
    const element = document.createElement("span")
    onMount(() => mounts++)
    createEffect(() => (element.textContent = health()?.name ?? ""))
    return element
  }
  const dispose = render(
    () =>
      createComponent(ServerAvailabilityGate, {
        serverKey: () => "http://127.0.0.1:4097",
        available: () => health() !== undefined,
        get children() {
          return createComponent(Marker, {})
        },
      }),
    root,
  )

  expect(root.textContent).toBe("Graph Vibe")
  expect(mounts).toBe(1)
  setHealth({ name: "Graph Vibe Refreshed" })
  expect(root.textContent).toBe("Graph Vibe Refreshed")
  expect(mounts).toBe(1)

  dispose()
  root.remove()
})
