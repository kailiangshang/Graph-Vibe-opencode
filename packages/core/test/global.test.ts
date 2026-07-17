import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Product } from "@opencode-ai/core/product"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "opencode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("constructs non-overlapping mutable paths for each product", () => {
    const roots = {
      home: "/home/tester",
      data: "/xdg/data",
      cache: "/xdg/cache",
      config: "/xdg/config",
      state: "/xdg/state",
      tmp: "/tmp",
    }
    const open = Global.paths(Product.OpenCode, roots)
    const graph = Global.paths(Product.GraphVibe, roots)

    expect(open).toMatchObject({
      data: "/xdg/data/opencode",
      config: "/xdg/config/opencode",
      tmp: "/tmp/opencode",
    })
    expect(graph).toMatchObject({
      data: "/xdg/data/graph-vibe",
      config: "/xdg/config/graph-vibe",
      tmp: "/tmp/graph-vibe",
    })
    expect(
      (["data", "config", "cache", "state", "tmp", "bin", "log", "repos"] as const).every(
        (key) => open[key] !== graph[key],
      ),
    ).toBe(true)
  })
})
