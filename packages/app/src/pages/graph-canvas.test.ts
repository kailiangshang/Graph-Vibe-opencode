import { describe, expect, test } from "bun:test"
import { GRAPH_CANVAS_LABEL, panCamera, reconcileCanvasNodes, screenToWorld } from "./graph-canvas"

describe("GraphCanvas model", () => {
  test("retains positions while updating node data and adding deterministic nodes", () => {
    const previous = [{ id: "a", x: 10, y: 20, vx: 1, vy: 2, data: { id: "a", name: "Old" } }]
    const next = reconcileCanvasNodes("graph-1", previous, [
      { id: "a", name: "Updated" },
      { id: "b", name: "New" },
    ])
    expect(next[0]).toMatchObject({ id: "a", x: 10, y: 20, data: { name: "Updated" } })
    expect(next[1]?.id).toBe("b")
    expect(next[1]?.x).toBeNumber()
  })

  test("converts container-local coordinates independently of device pixel ratio", () => {
    expect(
      screenToWorld({
        clientX: 350,
        clientY: 250,
        left: 100,
        top: 50,
        width: 300,
        height: 200,
        cameraX: 20,
        cameraY: -10,
        zoom: 2,
      }),
    ).toEqual({ x: 40, y: 55 })
  })

  test("pans in CSS pixels without changing zoom", () => {
    expect(panCamera({ x: 10, y: -5, zoom: 1.5 }, { x: 100, y: 80 }, { x: 135, y: 60 })).toEqual({
      x: 45,
      y: -25,
      zoom: 1.5,
    })
  })

  test("renders an accessible deterministic canvas boundary", () => {
    expect(GRAPH_CANVAS_LABEL).toBe("Workflow graph canvas. Use the task rail for keyboard navigation.")
  })
})
