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

test("installation method probes use product-specific package identities", () => {
  expect(
    Installation.methodProbeCommands(Product.GraphVibe).filter((probe) =>
      (["brew", "scoop", "choco"] as Installation.Method[]).includes(probe.name),
    ),
  ).toEqual([
    { name: "brew", command: ["brew", "list", "--formula", "graph-vibe"] },
    { name: "scoop", command: ["scoop", "list", "graph-vibe"] },
    { name: "choco", command: ["choco", "list", "--limit-output", "graph-vibe"] },
  ])
  expect(
    Installation.methodProbeCommands(Product.OpenCode).filter((probe) =>
      (["brew", "scoop", "choco"] as Installation.Method[]).includes(probe.name),
    ),
  ).toEqual([
    { name: "brew", command: ["brew", "list", "--formula", "opencode"] },
    { name: "scoop", command: ["scoop", "list", "opencode"] },
    { name: "choco", command: ["choco", "list", "--limit-output", "opencode"] },
  ])
})
