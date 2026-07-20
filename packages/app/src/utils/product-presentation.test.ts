import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createProductState } from "@/context/product"
import { ServerConnection } from "@/context/server"
import type { ServerHealth } from "./server-health"
import { resolveProductPresentation } from "./product-presentation"

const graphVibe = {
  id: "graph-vibe" as const,
  name: "Graph Vibe",
  capability: "Graph-guided development",
}

describe("resolveProductPresentation", () => {
  test("falls back to OpenCode when product data is missing", () => {
    expect(resolveProductPresentation(undefined)).toEqual({
      id: "opencode",
      name: "OpenCode",
      capability: "The AI coding agent built for the terminal",
    })
  })

  test("uses the OpenCode fallback for explicit OpenCode data", () => {
    expect(
      resolveProductPresentation({
        id: "opencode",
        name: "Renamed OpenCode",
        capability: "Unexpected capability",
      }),
    ).toEqual({
      id: "opencode",
      name: "OpenCode",
      capability: "The AI coding agent built for the terminal",
    })
  })

  test("uses the OpenCode fallback for unknown product data", () => {
    expect(
      resolveProductPresentation({
        id: "unknown",
        name: "Unknown Product",
        capability: "Unknown capability",
      }),
    ).toEqual({
      id: "opencode",
      name: "OpenCode",
      capability: "The AI coding agent built for the terminal",
    })
  })

  test("preserves explicit Graph Vibe data", () => {
    expect(resolveProductPresentation(graphVibe)).toEqual(graphVibe)
  })
})

describe("createProductState", () => {
  test("reactively follows the active server key", () => {
    createRoot((dispose) => {
      const openCodeKey = ServerConnection.key({ type: "http", http: { url: "http://opencode-server" } })
      const graphVibeKey = ServerConnection.key({ type: "http", http: { url: "http://graph-vibe-server" } })
      const [serverKey, setServerKey] = createSignal(openCodeKey)
      const health: Record<ServerConnection.Key, ServerHealth> = {
        [openCodeKey]: { healthy: true },
        [graphVibeKey]: { healthy: true, product: graphVibe },
      }
      const product = createProductState(serverKey, () => health)

      expect(product.product()).toEqual({
        id: "opencode",
        name: "OpenCode",
        capability: "The AI coding agent built for the terminal",
      })
      expect(product.graphVibe()).toBe(false)

      setServerKey(graphVibeKey)

      expect(product.product()).toEqual(graphVibe)
      expect(product.graphVibe()).toBe(true)
      dispose()
    })
  })
})
