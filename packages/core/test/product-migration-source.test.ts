import { expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, rm, symlink, truncate } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProductMigrationFile } from "@opencode-ai/core/product-migration/file"
import { ProductMigrationSource } from "@opencode-ai/core/product-migration/source"
import { tmpdir } from "./fixture/tmpdir"

test("bounds reference estimation concurrency", () => {
  expect(ProductMigrationSource.referenceConcurrency).toBe(16)
})

test("uses ordinal ordering for migration hashes", () => {
  expect(ProductMigrationSource.ordinal("z", "ä")).toBeLessThan(0)
  expect(ProductMigrationSource.ordinal("ä", "z")).toBeGreaterThan(0)
  expect(ProductMigrationSource.ordinal("same", "same")).toBe(0)
})

test("closes a managed SQLite read when BEGIN fails", () => {
  let closed = false
  expect(() =>
    ProductMigrationSource.openReadTransaction(() => ({
      run: () => {
        throw new Error("begin failed")
      },
      close: () => {
        closed = true
      },
    })),
  ).toThrow("begin failed")
  expect(closed).toBe(true)
})

test("paginates raw reference payloads beyond page and retained-memory budgets", () => {
  const sqlite = new SqliteDatabase(":memory:")
  sqlite.run("CREATE TABLE part (id TEXT PRIMARY KEY COLLATE NOCASE, session_id TEXT NOT NULL, data TEXT NOT NULL)")
  const insert = sqlite.query("INSERT INTO part VALUES (?, 'session-1', ?)")
  insert.run("part-Z", JSON.stringify({ pad: "x".repeat(80), type: "file", url: "/z" }))
  insert.run("part-a", JSON.stringify({ pad: "x".repeat(80), type: "file", url: "/a" }))
  insert.run("part-d", JSON.stringify({ pad: "x".repeat(80), type: "text" }))
  insert.run("part-b", JSON.stringify({ pad: "x".repeat(80), type: "text" }))
  insert.run("part-c", JSON.stringify({ pad: "x".repeat(80), type: "text" }))
  const references: Array<{ kind: "attachment" | "output"; value: string }> = []
  const state = { rows: 0, scannedBytes: 0, retainedCount: 0, retainedBytes: 0, pages: 0 }

  ProductMigrationSource.scanReferenceRows({
    sqlite,
    table: "part",
    column: "data",
    kind: "part",
    sessionID: "session-1",
    maxRows: 100,
    state,
    references,
    limits: {
      rowBytes: 1_024,
      scanBytes: 4_096,
      scanRows: 100,
      pageRows: 2,
      pageBytes: 128,
      retainedCount: 10,
      retainedBytes: 32,
      retainedValueBytes: 16,
    },
  })

  expect(state.pages).toBeGreaterThan(1)
  expect(state.scannedBytes).toBeGreaterThan(128)
  expect(state.retainedBytes).toBeLessThan(state.scannedBytes)
  expect(references).toEqual([
    { kind: "attachment", value: "/z" },
    { kind: "attachment", value: "/a" },
  ])
  sqlite.close(false)
})

test("rejects excessive retained references while scanning one bounded payload", () => {
  const sqlite = new SqliteDatabase(":memory:")
  sqlite.run("CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL)")
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?)", [
    JSON.stringify({ files: ["/a", "/b", "/c", "/d"].map((uri) => ({ uri })) }),
  ])

  expect(() =>
    ProductMigrationSource.scanReferenceRows({
      sqlite,
      table: "session_input",
      column: "prompt",
      kind: "prompt",
      sessionID: "session-1",
      maxRows: 100,
      state: { rows: 0, scannedBytes: 0, retainedCount: 0, retainedBytes: 0, pages: 0 },
      references: [],
      limits: {
        rowBytes: 1_024,
        scanBytes: 4_096,
        scanRows: 100,
        pageRows: 2,
        pageBytes: 512,
        retainedCount: 3,
        retainedBytes: 64,
        retainedValueBytes: 16,
      },
    }),
  ).toThrow("Retained reference count limit exceeded")
  sqlite.close(false)
})

test("rejects composite pagination keys with duplicate IDs during schema preflight", () => {
  const sqlite = new SqliteDatabase(":memory:")
  sqlite.run(
    "CREATE TABLE part (id TEXT NOT NULL, seq INTEGER NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, seq))",
  )
  sqlite.run("INSERT INTO part VALUES ('duplicate', 1, 'session-1', '{}'), ('duplicate', 2, 'session-1', '{}')")

  expect(() =>
    ProductMigrationSource.scanReferenceRows({
      sqlite,
      table: "part",
      column: "data",
      kind: "part",
      sessionID: "session-1",
      maxRows: 100,
      state: { rows: 0, scannedBytes: 0, retainedCount: 0, retainedBytes: 0, pages: 0 },
      references: [],
      limits: {
        rowBytes: 1_024,
        scanBytes: 4_096,
        scanRows: 100,
        pageRows: 1,
        pageBytes: 512,
        retainedCount: 10,
        retainedBytes: 64,
        retainedValueBytes: 16,
      },
    }),
  ).toThrow("part reference schema is unsupported")
  sqlite.close(false)
})

test("skips overlong reference values instead of retaining legacy inline URLs", () => {
  const sqlite = new SqliteDatabase(":memory:")
  sqlite.run("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)")
  sqlite.run("INSERT INTO part VALUES ('part-1', 'session-1', ?)", [
    JSON.stringify({ type: "file", url: `data:text/plain,${"x".repeat(32)}` }),
  ])
  const references: Array<{ kind: "attachment" | "output"; value: string }> = []

  ProductMigrationSource.scanReferenceRows({
    sqlite,
    table: "part",
    column: "data",
    kind: "part",
    sessionID: "session-1",
    maxRows: 100,
    state: { rows: 0, scannedBytes: 0, retainedCount: 0, retainedBytes: 0, pages: 0 },
    references,
    limits: {
      rowBytes: 1_024,
      scanBytes: 4_096,
      scanRows: 100,
      pageRows: 2,
      pageBytes: 512,
      retainedCount: 10,
      retainedBytes: 64,
      retainedValueBytes: 16,
    },
  })

  expect(references).toEqual([])
  sqlite.close(false)
})

test("estimates percent-encoded file URLs by their admissible decoded path", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const directory = Array.from({ length: 24 }, (_, index) => `segment-${index}-${" ".repeat(70)}`).reduce(
    (parent, segment) => path.join(parent, segment),
    project,
  )
  const attachment = path.join(directory, "attachment.txt")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state), mkdir(directory, { recursive: true })])
  await Bun.write(attachment, "encoded")
  const reference = pathToFileURL(attachment).href
  expect(Buffer.byteLength(reference)).toBeGreaterThan(4_096)
  expect(Buffer.byteLength(attachment)).toBeLessThanOrEqual(4_096)
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, admitted_seq INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', ?, 'Encoded', 1)", [project])
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?, 1)", [
    JSON.stringify({ files: [{ uri: reference }] }),
  ])
  sqlite.close(false)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result.projects[0]?.sessions[0]?.estimatedBytes).toBe(result.databaseBytes + 7)
})

test("rejects decoded filesystem paths above the shared inspection bound", async () => {
  await using tmp = await tmpdir()
  const result = await ProductMigrationFile.inspectReference({
    reference: path.join(tmp.path, "x".repeat(4_096)),
    roots: [tmp.path],
    maxBytes: ProductMigrationFile.referencedFileMaxBytes,
  })

  expect(result).toMatchObject({ status: "rejected" })
})

test("uses the versioned logical snapshot identity in fingerprints", () => {
  const input = {
    database: "/source/opencode.db",
    databaseBytes: 1024,
    sessionCount: 1,
    identity: {
      version: 1 as const,
      size: 1024,
      sha256: "a".repeat(64),
    },
  }

  expect(
    ProductMigrationSource.fingerprint({
      ...input,
      identity: { ...input.identity, sha256: "b".repeat(64) },
    }),
  ).not.toBe(ProductMigrationSource.fingerprint(input))
  expect(ProductMigrationSource.fingerprint({ ...input, databaseBytes: 2048 })).not.toBe(
    ProductMigrationSource.fingerprint(input),
  )
})

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

test("adds exact deduplicated admissible referenced file sizes to session estimates", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const attachments = path.join(data, "attachments")
  await Promise.all([mkdir(attachments, { recursive: true }), mkdir(config), mkdir(state), mkdir(project)])
  const accepted = path.join(attachments, "accepted.txt")
  const outside = path.join(tmp.path, "outside.txt")
  const linked = path.join(attachments, "linked.txt")
  await Bun.write(accepted, "planned")
  await Bun.write(outside, "outside")
  await symlink(accepted, linked)
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, admitted_seq INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', ?, 'Estimate', 1)", [project])
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?, 1)", [
    JSON.stringify({
      text: "attachments",
      files: [
        ...[accepted, accepted, path.join(attachments, "missing.txt"), linked, outside].map((uri) => ({
          uri,
          mime: "text/plain",
        })),
        { uri: "file://%", mime: "text/plain" },
      ],
    }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result.projects[0]?.sessions[0]?.estimatedBytes).toBe(result.databaseBytes + 7)
})

test("estimates attachments contained by a symlinked project root", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const projectLink = path.join(tmp.path, "project-link")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state), mkdir(project)])
  await symlink(project, projectLink)
  const attachment = path.join(projectLink, "attachment.txt")
  await Bun.write(path.join(project, "attachment.txt"), "linked-root")
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, admitted_seq INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [projectLink])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', ?, 'Estimate', 1)", [projectLink])
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?, 1)", [
    JSON.stringify({ text: "attachment", files: [{ uri: attachment, mime: "text/plain" }] }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result.projects[0]?.sessions[0]?.estimatedBytes).toBe(result.databaseBytes + "linked-root".length)
})

test("includes deduplicated completed tool output paths in session estimates", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const outputs = path.join(data, "tool-output")
  await Promise.all([mkdir(outputs, { recursive: true }), mkdir(config), mkdir(state), mkdir(project)])
  const output = path.join(outputs, "result.txt")
  await Bun.write(output, "result")
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', ?, 'Estimate', 1)", [project])
  sqlite.run("INSERT INTO session_message VALUES ('message-1', 'session-1', 1, ?)", [
    JSON.stringify({
      content: [
        {
          type: "tool",
          state: { status: "completed", outputPaths: [output, output] },
        },
      ],
    }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result.projects[0]?.sessions[0]?.estimatedBytes).toBe(result.databaseBytes + 6)
})

test("includes current and legacy attachment forms in session estimates", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const attachments = path.join(data, "attachments")
  await Promise.all([mkdir(attachments, { recursive: true }), mkdir(config), mkdir(state), mkdir(project)])
  const files = ["user", "tool", "legacy-file", "legacy-tool"].map((name) => path.join(attachments, name))
  await Promise.all(files.map((file, index) => Bun.write(file, "x".repeat(index + 1))))
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)",
  )
  sqlite.run("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)")
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', ?, 'Estimate', 1)", [project])
  sqlite.run("INSERT INTO session_message VALUES ('message-user', 'session-1', 1, ?)", [
    JSON.stringify({ files: [{ uri: files[0] }] }),
  ])
  sqlite.run("INSERT INTO session_message VALUES ('message-tool', 'session-1', 2, ?)", [
    JSON.stringify({
      content: [{ type: "tool", state: { status: "completed", attachments: [{ uri: files[1] }] } }],
    }),
  ])
  sqlite.run("INSERT INTO part VALUES ('part-file', 'session-1', ?)", [JSON.stringify({ type: "file", url: files[2] })])
  sqlite.run("INSERT INTO part VALUES ('part-tool', 'session-1', ?)", [
    JSON.stringify({ type: "tool", state: { status: "completed", attachments: [{ url: files[3] }] } }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const result = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(result.projects[0]?.sessions[0]?.estimatedBytes).toBe(result.databaseBytes + 10)
})

test("changes the source fingerprint when a referenced file identity changes", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const attachments = path.join(data, "attachments")
  await Promise.all([mkdir(attachments, { recursive: true }), mkdir(config), mkdir(state), mkdir(project)])
  const attachment = path.join(attachments, "changing.txt")
  await Bun.write(attachment, "one")
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, admitted_seq INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Estimate', 1)")
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?, 1)", [
    JSON.stringify({ text: "attachment", files: [{ uri: attachment, mime: "text/plain" }] }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const discover = () =>
    Effect.runPromise(
      ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
        Effect.provide(layer),
      ),
    )

  const planned = await discover()
  await Bun.write(attachment, "two")
  const changed = await discover()

  expect(changed.sourceFingerprint).not.toBe(planned.sourceFingerprint)
})

test("rejects referenced file estimates above file and session copy limits", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const project = path.join(tmp.path, "project")
  const attachments = path.join(data, "attachments")
  await Promise.all([mkdir(attachments, { recursive: true }), mkdir(config), mkdir(state), mkdir(project)])
  const oversized = path.join(attachments, "oversized")
  await Bun.write(oversized, "x")
  await truncate(oversized, 128 * 1024 * 1024 + 1)
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    "CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, admitted_seq INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [project])
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Estimate', 1)")
  sqlite.run("INSERT INTO session_input VALUES ('input-1', 'session-1', ?, 1)", [
    JSON.stringify({ text: "attachment", files: [{ uri: oversized, mime: "application/octet-stream" }] }),
  ])
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const source = await Effect.runPromise(ProductMigrationSource.Service.pipe(Effect.provide(layer)))

  expect(await Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip))).toMatchObject({
    _tag: "ProductMigrationSourceReadError",
  })

  await rm(oversized)
  const aggregate = Array.from({ length: 5 }, (_, index) => path.join(attachments, `aggregate-${index}`))
  await Promise.all(
    aggregate.map(async (file) => {
      await Bun.write(file, "x")
      await truncate(file, 128 * 1024 * 1024)
    }),
  )
  const updated = new SqliteDatabase(database)
  updated.run("UPDATE session_input SET prompt = ? WHERE id = 'input-1'", [
    JSON.stringify({
      text: "attachments",
      files: aggregate.map((uri) => ({ uri, mime: "application/octet-stream" })),
    }),
  ])
  updated.close()

  expect(await Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip))).toMatchObject({
    _tag: "ProductMigrationSourceReadError",
  })
})

test("changes the source fingerprint for WAL-only Graph mutations", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await mkdir(data)
  await mkdir(config)
  await mkdir(state)
  const database = path.join(data, "opencode.db")
  const writer = new SqliteDatabase(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  writer.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  writer.run("CREATE TABLE graph_node (id TEXT PRIMARY KEY, session_id TEXT)")
  writer.run("INSERT INTO project VALUES ('project-1', '/workspace/current')")
  writer.run("INSERT INTO session VALUES ('session-1', 'project-1', 'First session', 100)")
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)")

  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const planned = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )
  writer.run("INSERT INTO graph_node VALUES ('wal-only-node', 'session-1')")
  const changed = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.provide(layer),
    ),
  )

  expect(await Bun.file(`${database}-wal`).exists()).toBe(true)
  expect(changed.sourceFingerprint).not.toBe(planned.sourceFingerprint)
  writer.close(false)
})

test("keeps the logical database fingerprint stable across a pure WAL checkpoint", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const database = path.join(data, "opencode.db")
  const writer = new SqliteDatabase(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  writer.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  writer.run("INSERT INTO project VALUES ('project-1', '/workspace/current')")
  writer.run("INSERT INTO session VALUES ('session-1', 'project-1', 'First session', 100)")
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const discover = () =>
    Effect.runPromise(
      ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
        Effect.provide(layer),
      ),
    )

  const before = await discover()
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
  const after = await discover()

  expect(after.databaseFingerprint).toBe(before.databaseFingerprint)
  expect(after.sourceFingerprint).toBe(before.sourceFingerprint)
  writer.close(false)
})

test("fingerprints every copied source byte while excluding disposable trees", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([
    mkdir(data),
    mkdir(state),
    mkdir(path.join(config, "agents"), { recursive: true }),
    mkdir(path.join(config, "node_modules", "ignored"), { recursive: true }),
  ])
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  const files = [
    [path.join(config, "opencode.json"), "{}"],
    [path.join(config, "tui.json"), "{}"],
    [path.join(config, "agents", "review.md"), "review"],
    [path.join(config, "package.json"), '{"dependencies":{"plugin":"1.0.0"}}'],
    [path.join(data, "auth.json"), '{"provider":{"type":"api","key":"secret"}}'],
    [path.join(data, "mcp-auth.json"), '{"docs":{"tokens":{"accessToken":"secret"}}}'],
  ] as const
  await Promise.all(files.map(([file, content]) => Bun.write(file, content)))
  await Bun.write(path.join(config, "node_modules", "ignored", "index.js"), "ignored-a")
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const discover = () =>
    Effect.runPromise(
      ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
        Effect.provide(layer),
      ),
    )

  const initial = await discover()
  expect(initial.expected.configSources).toEqual([
    { path: "agents/review.md", sha256: createHash("sha256").update("review").digest("hex") },
    { path: "opencode.json", sha256: createHash("sha256").update("{}").digest("hex") },
    { path: "tui.json", sha256: createHash("sha256").update("{}").digest("hex") },
  ])
  expect(initial.expected.auth).toEqual({
    path: "auth.json",
    sha256: createHash("sha256").update('{"provider":{"type":"api","key":"secret"}}').digest("hex"),
  })
  expect(initial.expected.mcpAuth).toEqual({
    path: "mcp-auth.json",
    sha256: createHash("sha256").update('{"docs":{"tokens":{"accessToken":"secret"}}}').digest("hex"),
  })
  expect(initial.expected.dependencies).toEqual([{ name: "plugin", version: "1.0.0" }])
  for (const [file, content] of files) {
    await Bun.write(file, `${content} `)
    const changed = await discover()
    expect(changed.sourceFingerprint).not.toBe(initial.sourceFingerprint)
    await Bun.write(file, content)
  }
  await Bun.write(path.join(config, "node_modules", "ignored", "index.js"), "ignored-b")

  expect((await discover()).sourceFingerprint).toBe(initial.sourceFingerprint)
})

test("rejects config and credential files above their allocation limits", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(state), mkdir(path.join(config, "agents"), { recursive: true })])
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  const oversizedConfig = path.join(config, "agents", "oversized.md")
  await Bun.write(oversizedConfig, "x")
  await truncate(oversizedConfig, 8 * 1024 * 1024 + 1)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const source = await Effect.runPromise(ProductMigrationSource.Service.pipe(Effect.provide(layer)))

  await expect(Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip))).resolves.toMatchObject({
    _tag: "ProductMigrationSourceReadError",
  })

  await rm(oversizedConfig)
  const oversizedAuth = path.join(data, "auth.json")
  await Bun.write(oversizedAuth, "{}")
  await truncate(oversizedAuth, 1024 * 1024 + 1)
  await expect(Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip))).resolves.toMatchObject({
    _tag: "ProductMigrationSourceReadError",
  })
})

test("rejects symlinked and excessively deep configuration trees", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  await symlink(tmp.path, path.join(config, "agents"))
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))
  const source = await Effect.runPromise(ProductMigrationSource.Service.pipe(Effect.provide(layer)))

  expect(
    await Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip, Effect.provide(layer))),
  ).toMatchObject({ _tag: "ProductMigrationSourceReadError" })

  await rm(path.join(config, "agents"))
  const deep = Array.from({ length: 40 }, (_, index) => `d${index}`).reduce(
    (dir, name) => path.join(dir, name),
    path.join(config, "agents"),
  )
  await mkdir(deep, { recursive: true })
  await Bun.write(path.join(deep, "file.md"), "too deep")
  expect(
    await Effect.runPromise(source.discover({ data, config, state }).pipe(Effect.flip, Effect.provide(layer))),
  ).toMatchObject({ _tag: "ProductMigrationSourceReadError" })
})

test("rejects a symlinked configuration root", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const actualConfig = path.join(tmp.path, "actual-config")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(actualConfig), mkdir(state)])
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  await Bun.write(path.join(actualConfig, "opencode.json"), "{}")
  await symlink(actualConfig, config, "dir")
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(failure).toMatchObject({ _tag: "ProductMigrationSourceReadError" })
})

test("rejects a directory listing that exceeds the shared manifest entry budget", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  const agents = path.join(config, "agents")
  await Promise.all([mkdir(data), mkdir(state), mkdir(agents, { recursive: true })])
  await Promise.all(Array.from({ length: 10_001 }, (_, index) => mkdir(path.join(agents, `entry-${index}`))))
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(failure).toMatchObject({ _tag: "ProductMigrationSourceReadError" })
})

test("rejects oversized database inventories before loading project rows", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const database = path.join(data, "opencode.db")
  const sqlite = new SqliteDatabase(database, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(`
    WITH RECURSIVE inventory(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM inventory WHERE value < 10001)
    INSERT INTO project SELECT 'project-' || value, '/workspace/' || value FROM inventory
  `)
  sqlite.close()
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(failure).toMatchObject({ _tag: "ProductMigrationSourceReadError" })
})

test("rejects an oversized project field with a SQL preflight before materializing it", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', printf('%0*d', 4097, 0))")
  sqlite.close(false)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(errorMessage(failure.cause)).toContain("project.worktree byte limit")
})

test("rejects aggregate session metadata with a SQL preflight before materializing it", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', '/workspace')")
  sqlite.run(`
    WITH RECURSIVE rows(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM rows WHERE value < 257)
    INSERT INTO session
    SELECT printf('session-%04d', value), 'project-1', printf('%0*d', 65536, 0), value FROM rows
  `)
  sqlite.close(false)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(errorMessage(failure.cause)).toContain("session aggregate byte limit")
})

test("rejects oversized dynamically typed session scalars before materializing them", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run("INSERT INTO project VALUES ('project-1', '/workspace')")
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Session', zeroblob(1024))")
  sqlite.close(false)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(errorMessage(failure.cause)).toContain("session.time_updated byte limit")
})

test("rejects oversized reference payloads with a SQL preflight before materializing them", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data BLOB NOT NULL)")
  sqlite.run("INSERT INTO project VALUES ('project-1', '/workspace')")
  sqlite.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Session', 1)")
  sqlite.run("INSERT INTO part VALUES ('part-1', 'session-1', zeroblob(8388609))")
  sqlite.close(false)
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )

  expect(errorMessage(failure.cause)).toContain("part.data byte limit")
})

test("rejects non-registry dependency specifications", async () => {
  await using tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const config = path.join(tmp.path, "config")
  const state = path.join(tmp.path, "state")
  await Promise.all([mkdir(data), mkdir(config), mkdir(state)])
  const sqlite = new SqliteDatabase(path.join(data, "opencode.db"), { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  await Bun.write(path.join(config, "package.json"), '{"dependencies":{"unsafe":"file:../outside"}}')
  const layer = ProductMigrationSource.layer.pipe(Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)))

  const failure = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) => source.discover({ data, config, state })).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  )
  expect(failure).toMatchObject({ _tag: "ProductMigrationSourceReadError" })
})

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}
