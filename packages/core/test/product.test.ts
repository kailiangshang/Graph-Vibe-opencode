import { afterEach, describe, expect, test } from "bun:test"
import { Product } from "../src/product"

const original = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (original === undefined) {
    delete process.env.OPENCODE_CLIENT
    return
  }
  process.env.OPENCODE_CLIENT = original
})

describe("Product.current", () => {
  test("uses OpenCode by default", () => {
    delete process.env.OPENCODE_CLIENT

    expect(Product.current()).toEqual(Product.OpenCode)
  })

  test("selects Graph Vibe with its public identity", () => {
    process.env.OPENCODE_CLIENT = "graph-vibe"

    expect(Product.current()).toEqual({
      id: "graph-vibe",
      name: "Graph Vibe",
      cli: "graph-vibe",
      capability: "Graph-guided development",
      attribution: "Powered by OpenCode",
    })
  })

  test("reads the client at access time", () => {
    process.env.OPENCODE_CLIENT = "graph-vibe"
    expect(Product.current()).toBe(Product.GraphVibe)

    process.env.OPENCODE_CLIENT = "cli"
    expect(Product.current()).toBe(Product.OpenCode)
  })
})
