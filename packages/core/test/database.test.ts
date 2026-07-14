import { describe, expect, test } from "bun:test"
import path from "path"
import { Database } from "../src/database/database"
import { Global } from "../src/global"
import { Product } from "../src/product"

const roots = {
  home: "/home/tester",
  data: "/xdg/data",
  cache: "/xdg/cache",
  config: "/xdg/config",
  state: "/xdg/state",
  tmp: "/tmp",
}

describe("Database.pathFor", () => {
  test("uses each product database inside its own data namespace", () => {
    const open = Global.paths(Product.OpenCode, roots)
    const graph = Global.paths(Product.GraphVibe, roots)

    expect(
      Database.pathFor({
        profile: Product.OpenCode,
        data: open.data,
        openCodeData: open.data,
        channel: "latest",
      }),
    ).toBe(path.join(open.data, "opencode.db"))
    expect(
      Database.pathFor({
        profile: Product.GraphVibe,
        data: graph.data,
        openCodeData: open.data,
        channel: "latest",
      }),
    ).toBe(path.join(graph.data, "graph-vibe.db"))
  })

  test("keeps non-release channels inside the selected product namespace", () => {
    const graph = Global.paths(Product.GraphVibe, roots)

    expect(
      Database.pathFor({
        profile: Product.GraphVibe,
        data: graph.data,
        openCodeData: Global.paths(Product.OpenCode, roots).data,
        channel: "local",
      }),
    ).toBe(path.join(graph.data, "graph-vibe-local.db"))
  })

  test("rejects Graph Vibe database overrides inside OpenCode data", () => {
    const open = Global.paths(Product.OpenCode, roots)
    const graph = Global.paths(Product.GraphVibe, roots)
    const input = {
      profile: Product.GraphVibe,
      data: graph.data,
      openCodeData: open.data,
      channel: "latest",
      database: path.join(open.data, "opencode.db"),
    } as const

    expect(() => Database.pathFor(input)).toThrow("Graph Vibe refuses an OpenCode database path")
    expect(Database.pathFor({ ...input, allowOpenCodePaths: true })).toBe(input.database)
  })
})
