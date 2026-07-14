import { expect, test } from "bun:test"
import { Product } from "@opencode-ai/core/product"
import { Installation } from "../src/installation"

test("Graph Vibe package detection never aliases opencode-ai", () => {
  expect(Installation.packageName(Product.GraphVibe, "npm")).toBe("graph-vibe")
  expect(Installation.packageName(Product.GraphVibe, "brew")).toBe("graph-vibe")
  expect(Installation.releaseAvailable(Product.GraphVibe)).toBe(false)
})

test("OpenCode retains its release identity", () => {
  expect(Installation.packageName(Product.OpenCode, "npm")).toBe("opencode-ai")
  expect(Installation.packageName(Product.OpenCode, "brew")).toBe("opencode")
  expect(Installation.releaseAvailable(Product.OpenCode)).toBe(true)
})
