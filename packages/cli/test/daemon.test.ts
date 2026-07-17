import { expect, test } from "bun:test"
import path from "path"
import { Product } from "@opencode-ai/core/product"
import { Daemon } from "../src/services/daemon"
import { defaultPort } from "../src/commands/handlers/serve"

test("Graph Vibe daemon identity is isolated", () => {
  expect(Daemon.paths("/state/graph-vibe", Product.GraphVibe)).toEqual({
    registration: path.join("/state/graph-vibe", "graph-vibe-server.json"),
    password: path.join("/state/graph-vibe", "graph-vibe-password"),
  })
  expect(defaultPort(Product.GraphVibe)).toBe(4097)
})

test("OpenCode daemon defaults remain unchanged", () => {
  expect(Daemon.paths("/state/opencode", Product.OpenCode)).toEqual({
    registration: path.join("/state/opencode", "server.json"),
    password: path.join("/state/opencode", "password"),
  })
  expect(defaultPort(Product.OpenCode)).toBe(4096)
})
