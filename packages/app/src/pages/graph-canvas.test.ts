import { describe, expect, test } from "bun:test"
import { GRAPH_CANVAS_LABEL, canvasNodeState, panCamera, reconcileCanvasNodes, screenToWorld } from "./graph-canvas"

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

  test("derives shape, icon, and text for workflow node state", () => {
    expect(canvasNodeState({ status: "pending", testStatus: "none", buildable: false }, false, false)).toEqual({
      state: "blocked",
      icon: "×",
      shape: "diamond",
      label: "Blocked",
    })
    expect(canvasNodeState({ status: "implemented", testStatus: "failed", buildable: true }, false, false)).toEqual({
      state: "failed",
      icon: "!",
      shape: "square",
      label: "Failed",
    })
    expect(canvasNodeState({ status: "implemented", testStatus: "failed", buildable: true }, true, true)).toEqual({
      state: "failed",
      icon: "!",
      shape: "square",
      label: "Current · Selected · Failed",
    })
    expect(canvasNodeState({ status: "verified", testStatus: "passed", buildable: false }, false, false)).toEqual({
      state: "verified",
      icon: "✓",
      shape: "circle",
      label: "Verified",
    })
    expect(canvasNodeState({ status: "verified", testStatus: "none", buildable: false }, false, false)).toMatchObject({
      state: "verified",
      label: "Verified",
    })
    expect(canvasNodeState({ status: "pending", testStatus: "none", buildable: true }, true, false)).toMatchObject({
      state: "current",
      label: "Current",
    })
    expect(canvasNodeState({ status: "pending", testStatus: "none", buildable: true }, false, true)).toEqual({
      state: "selected",
      icon: "◆",
      shape: "hexagon",
      label: "Selected",
    })
    expect(
      canvasNodeState({ status: "pending", testStatus: "none", buildable: true, checkpoint: true }, false, false),
    ).toEqual({ state: "checkpoint", icon: "Ⅱ", shape: "diamond", label: "Checkpoint" })
  })
})
