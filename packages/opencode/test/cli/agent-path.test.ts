import { expect, test } from "bun:test"
import path from "path"
import { Product } from "@opencode-ai/core/product"
import { agentConfigDirectory } from "../../src/cli/cmd/agent"

test("Graph Vibe creates project agents under .graph-vibe", () => {
  expect(agentConfigDirectory("/workspace", "project", Product.GraphVibe, "/config/graph-vibe")).toBe(
    path.join("/workspace", ".graph-vibe", "agents"),
  )
})

test("OpenCode retains its existing project agent directory", () => {
  expect(agentConfigDirectory("/workspace", "project", Product.OpenCode, "/config/opencode")).toBe(
    path.join("/workspace", ".opencode", "agents"),
  )
})
