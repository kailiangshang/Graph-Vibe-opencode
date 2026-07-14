import { expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProductMigrationSource } from "@opencode-ai/core/product-migration/source"
import { tmpdir } from "./fixture/tmpdir"

test("discovers a consistent OpenCode source without modifying it", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await mkdir(data)
  await mkdir(config)
  await mkdir(state)
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run("CREATE TABLE graph_node (id TEXT PRIMARY KEY, session_id TEXT)")
  sqlite.run("INSERT INTO project VALUES ('project-1', '/workspace/current')")
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', 'First session', 100)")
  sqlite.run("INSERT INTO graph_node VALUES ('node-1', 'session-1')")
  sqlite.close()
  await Bun.write(path.join(config, "opencode.json"), JSON.stringify({ model: "test/model" }))
  await Bun.write(path.join(data, "auth.json"), JSON.stringify({ test: { type: "api", key: "secret" } }))

  const before = {
    database: Bun.hash(await Bun.file(database).arrayBuffer()),
    config: Bun.hash(await Bun.file(path.join(config, "opencode.json")).arrayBuffer()),
    auth: Bun.hash(await Bun.file(path.join(data, "auth.json")).arrayBuffer()),
  }
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result).toMatchObject({
    database,
    mixedGraph: true,
    sessionCount: 1,
    projects: [
      {
        id: "project-1",
        path: "/workspace/current",
        sessionCount: 1,
        sessions: [{ id: "session-1", title: "First session", updatedAt: 100, hasGraph: true }],
      },
    ],
  })
  expect(result.categories.map((item) => [item.category, item.available])).toEqual([
    ["config", true],
    ["credentials", true],
    ["mcp", false],
  ])
  expect({
    database: Bun.hash(await Bun.file(database).arrayBuffer()),
    config: Bun.hash(await Bun.file(path.join(config, "opencode.json")).arrayBuffer()),
    auth: Bun.hash(await Bun.file(path.join(data, "auth.json")).arrayBuffer()),
  }).toEqual(before)
})
