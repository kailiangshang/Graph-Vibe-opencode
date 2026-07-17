import { expect, test } from "bun:test"
import { desktopProduct } from "./product"

test("selects Graph Vibe desktop runtime identity", () => {
  expect(desktopProduct("graph-vibe", "prod")).toEqual({
    id: "ai.graph-vibe.desktop",
    name: "Graph Vibe",
    client: "graph-vibe",
  })
})

test("retains OpenCode desktop runtime identity", () => {
  expect(desktopProduct("desktop", "beta")).toEqual({
    id: "ai.opencode.desktop.beta",
    name: "OpenCode Beta",
    client: "desktop",
  })
})
