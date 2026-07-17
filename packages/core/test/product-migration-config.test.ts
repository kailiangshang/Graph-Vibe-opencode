import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, realpath, rename, stat, symlink, truncate } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { eq } from "drizzle-orm"
import { ProductMigrationConfig } from "@opencode-ai/core/product-migration/config"
import { ProductMigrationConfigPolicy } from "@opencode-ai/core/product-migration/config-policy"
import { ProductMigrationSource } from "@opencode-ai/core/product-migration/source"
import { ProductMigrationSnapshot } from "@opencode-ai/core/product-migration/snapshot"
import { tmpdir } from "./fixture/tmpdir"

const sqliteModule = await import("bun:sqlite")
const placeholderFile = (file: string) => ({ path: file, sha256: "0".repeat(64) })
const validationExpected = (
  input: Partial<ProductMigrationSource.ExpectedInventory>,
): ProductMigrationSource.ExpectedInventory => ({
  configPaths: [],
  configSources: [],
  auth: null,
  mcpAuth: null,
  dependencies: [],
  credentialIDs: [],
  ...input,
})

test("rejects config bytes that do not match the planned inventory", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const databaseFingerprint = await databaseFingerprintFor(sourceDatabase)

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration
        .migrate({
          sourceConfig,
          sourceData,
          sourceDatabase,
          targetConfig,
          targetData,
          databaseFingerprint,
          categories: ["config"],
          expected: {
            configPaths: ["graph-vibe.json"],
            configSources: [{ path: "opencode.json", sha256: "0".repeat(64) }],
            auth: null,
            mcpAuth: null,
            dependencies: [],
            credentialIDs: [],
          },
        })
        .pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("requires an exact database fingerprint before config target materialization", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration
        // @ts-expect-error The runtime boundary must reject callers that omit the required fingerprint.
        .migrate({
          sourceConfig,
          sourceData,
          sourceDatabase,
          targetConfig,
          targetData,
          categories: ["config"],
          expected: validationExpected({
            configPaths: ["graph-vibe.json"],
            configSources: [{ path: "opencode.json", sha256: createHash("sha256").update("{}").digest("hex") }],
          }),
        })
        .pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigSourceChanged" })
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("rejects oversized database credential values before importing them", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite
    .query("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)")
    .run("credential-large", "provider", "large", '{"type":"key","key":"secret"}' + " ".repeat(1024 * 1024))
  sqlite.close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["credentials"],
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
})

test("rejects oversized database credential metadata before materializing it", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    `INSERT INTO credential
     SELECT 'credential-large-label', 'provider', printf('%0*d', 4097, 0), '{"type":"key","key":"secret"}', NULL, NULL, 1, 1, 1`,
  )
  sqlite.close(false)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["credentials"],
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
  expect(errorMessage(error.cause)).toContain("credential.label byte limit")
})

test("preflights oversized credential IDs before loading the ID inventory", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    `INSERT INTO credential
     SELECT printf('%0*d', 257, 0), 'provider', 'label', '{"type":"key","key":"secret"}', NULL, NULL, 1, 1, 1`,
  )
  sqlite.close(false)
  const databaseFingerprint = await databaseFingerprintFor(sourceDatabase)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration
        .migrate({
          sourceConfig,
          sourceData,
          sourceDatabase,
          targetConfig,
          targetData,
          databaseFingerprint,
          categories: ["credentials"],
          expected: validationExpected({ credentialIDs: ["planned"] }),
        })
        .pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
  expect(errorMessage(error.cause)).toContain("credential.id byte limit")
})

test("rejects non-text database credential metadata before target materialization", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id BLOB, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    `INSERT INTO credential VALUES ('credential-blob', zeroblob(8), 'label', '{"type":"key","key":"secret"}', NULL, NULL, 1, 1, 1)`,
  )
  sqlite.close(false)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["credentials"],
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
  expect(errorMessage(error.cause)).toContain("Credential text fields are invalid")
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("rejects oversized dynamically typed credential scalars before materializing them", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    `INSERT INTO credential VALUES ('credential-scalar', 'provider', 'label', '{"type":"key","key":"secret"}', NULL, NULL, 1, zeroblob(1024), 1)`,
  )
  sqlite.close(false)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["credentials"],
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
  expect(errorMessage(error.cause)).toContain("credential.time_created byte limit")
})

test("rejects an oversized aggregate database credential inventory", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  const insert = sqlite.query("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, 1, 1, 1)")
  const value = '{"type":"key","key":"secret"}' + " ".repeat(1024 * 1024 - 128)
  for (let index = 0; index < 17; index++) {
    insert.run(`credential-${index}`, "provider", `credential-${index}`, value)
  }
  sqlite.close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["credentials"],
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigError" })
})

for (const change of ["added", "removed"] as const) {
  test(`rejects ${change} credential rows before target materialization`, async () => {
    await using tmp = await tmpdir()
    const sourceConfig = path.join(tmp.path, "source-config")
    const sourceData = path.join(tmp.path, "source-data")
    const targetConfig = path.join(tmp.path, "target-config")
    const targetData = path.join(tmp.path, "target-data")
    await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
    const sourceDatabase = path.join(sourceData, "opencode.db")
    const source = new sqliteModule.Database(sourceDatabase, { create: true })
    source.run(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    )
    if (change === "added") {
      source.run(`INSERT INTO credential VALUES
        ('credential-planned', 'provider', 'planned', '{"type":"key","key":"planned"}', NULL, NULL, 1, 1, 1),
        ('credential-added', 'provider', 'added', '{"type":"key","key":"added"}', NULL, NULL, 1, 1, 1)`)
    }
    source.close(false)
    const layer = ProductMigrationConfig.layer.pipe(
      Layer.provideMerge(Database.layerFromPath(":memory:")),
      Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
    )
    const databaseFingerprint = await databaseFingerprintFor(sourceDatabase)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationConfig.Service
        const error = yield* migration
          .migrate({
            sourceConfig,
            sourceData,
            sourceDatabase,
            targetConfig,
            targetData,
            databaseFingerprint,
            categories: ["credentials"],
            expected: validationExpected({ credentialIDs: ["credential-planned"] }),
          })
          .pipe(Effect.flip)
        const { db } = yield* Database.Service
        return { error, credentials: yield* db.select().from(CredentialTable).all().pipe(Effect.orDie) }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.error).toMatchObject({ _tag: "ProductMigrationConfigSourceChanged" })
    expect(result.credentials).toEqual([])
    expect(await Bun.file(targetConfig).exists()).toBe(false)
  })
}

test("rejects a credential value-only race before target materialization", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const source = new sqliteModule.Database(sourceDatabase, { create: true })
  source.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  source.run(
    `INSERT INTO credential VALUES ('credential-planned', 'provider', 'planned', '{"type":"key","key":"planned"}', NULL, NULL, 1, 1, 1)`,
  )
  source.close(false)
  const plannedIdentity = await ProductMigrationSnapshot.databaseIdentity(sourceDatabase)
  const databaseFingerprint = ProductMigrationSource.fingerprint({
    database: sourceDatabase,
    databaseBytes: plannedIdentity.size,
    sessionCount: 0,
    identity: plannedIdentity,
  })
  const changed = new sqliteModule.Database(sourceDatabase)
  changed.run(
    `UPDATE credential SET value = '{"type":"key","key":"changed"}', time_updated = 2 WHERE id = 'credential-planned'`,
  )
  changed.close(false)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      const error = yield* ProductMigrationSnapshot.use({ database: sourceDatabase }, (snapshot) =>
        migration
          .migrate({
            sourceConfig,
            sourceData,
            sourceDatabase,
            targetConfig,
            targetData,
            snapshot,
            databaseFingerprint,
            categories: ["credentials"],
            expected: validationExpected({ credentialIDs: ["credential-planned"] }),
          })
          .pipe(Effect.flip),
      )
      const { db } = yield* Database.Service
      return { error, credentials: yield* db.select().from(CredentialTable).all().pipe(Effect.orDie) }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.error).toMatchObject({ _tag: "ProductMigrationConfigSourceChanged" })
  expect(result.credentials).toEqual([])
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("bounds credential rows before materializing an over-limit inventory", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(targetData)])
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const source = new sqliteModule.Database(sourceDatabase, { create: true })
  source.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  const insert = source.query("INSERT INTO credential VALUES (?, 'provider', ?, ?, NULL, NULL, 1, 1, 1)")
  const credentialIDs = Array.from({ length: 10_000 }, (_, index) => `credential-${index.toString().padStart(5, "0")}`)
  source.transaction(() => {
    credentialIDs.forEach((id) => insert.run(id, id, '{"type":"key","key":"secret"}'))
    insert.run("credential-unplanned", "unplanned", '{"type":"key","key":"secret"}')
  })()
  source.close(false)
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const databaseFingerprint = await databaseFingerprintFor(sourceDatabase)

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration
        .migrate({
          sourceConfig,
          sourceData,
          sourceDatabase,
          targetConfig,
          targetData,
          databaseFingerprint,
          categories: ["credentials"],
          expected: validationExpected({ credentialIDs }),
        })
        .pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationConfigSourceChanged" })
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("requires every selected artifact while accepting imported credential rows", async () => {
  await using tmp = await tmpdir()
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  const sourceDatabase = path.join(tmp.path, "source.db")
  await mkdir(targetConfig)
  await mkdir(path.join(targetConfig, "agents"))
  await mkdir(targetData)
  const source = new sqliteModule.Database(sourceDatabase, { create: true })
  source.run("CREATE TABLE credential (id TEXT PRIMARY KEY)")
  source.run("INSERT INTO credential VALUES ('credential-1')")
  source.close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      const missing = yield* migration.validate({
        targetConfig,
        targetData,
        sourceDatabase,
        categories: ["config", "credentials", "mcp"],
        expected: validationExpected({
          configPaths: ["graph-vibe.json"],
          mcpAuth: placeholderFile("mcp-auth.json"),
          credentialIDs: ["credential-1"],
        }),
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(CredentialTable)
        .values({
          id: Credential.ID.make("credential-1"),
          integration_id: Integration.ID.make("provider"),
          label: "default",
          value: { type: "key", key: "secret" },
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const imported = yield* migration.validate({
        targetConfig,
        targetData,
        sourceDatabase,
        categories: ["credentials"],
        expected: validationExpected({ credentialIDs: ["credential-1"] }),
      })
      return { missing, imported }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.missing.map((issue) => issue.code)).toEqual(["config_missing", "credential_missing", "mcp_missing"])
  expect(result.imported).toEqual([])
})

test("requires every immutable expected config path and credential ID", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source.db")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(path.join(targetConfig, "agents"), { recursive: true })
  await mkdir(targetData)
  await Bun.write(path.join(targetConfig, "graph-vibe.json"), "{}")
  await Bun.write(path.join(targetConfig, "agents", "first.md"), "first")
  await Bun.write(path.join(targetConfig, "agents", "second.md"), "second")
  await Bun.write(path.join(targetData, "auth.json"), '{"provider":{"type":"api","key":"secret"}}')
  await Bun.write(path.join(targetData, "mcp-auth.json"), '{"docs":{"tokens":{"accessToken":"secret"}}}')
  await chmod(path.join(targetData, "auth.json"), 0o600)
  await chmod(path.join(targetData, "mcp-auth.json"), 0o600)
  const source = new sqliteModule.Database(sourceDatabase, { create: true })
  source.run("CREATE TABLE credential (id TEXT PRIMARY KEY)")
  source.run("INSERT INTO credential VALUES ('credential-1'), ('credential-2')")
  source.close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const expected = validationExpected({
    configPaths: ["agents/first.md", "agents/second.md", "graph-vibe.json"],
    auth: placeholderFile("auth.json"),
    mcpAuth: placeholderFile("mcp-auth.json"),
    credentialIDs: ["credential-1", "credential-2"],
  })

  const issues = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(CredentialTable)
        .values([
          {
            id: Credential.ID.make("credential-1"),
            integration_id: Integration.ID.make("provider"),
            label: "first",
            value: { type: "key", key: "first" },
            time_created: 1,
            time_updated: 1,
          },
          {
            id: Credential.ID.make("credential-2"),
            integration_id: Integration.ID.make("provider"),
            label: "second",
            value: { type: "key", key: "second" },
            time_created: 1,
            time_updated: 1,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* migration.validate({
          sourceDatabase,
          targetConfig,
          targetData,
          categories: ["config", "credentials", "mcp"],
          expected,
        }),
      ).toEqual([])
      yield* Effect.promise(() => Bun.file(path.join(targetConfig, "agents", "second.md")).delete())
      yield* db
        .delete(CredentialTable)
        .where(eq(CredentialTable.id, Credential.ID.make("credential-2")))
        .run()
        .pipe(Effect.orDie)
      return yield* migration.validate({
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["config", "credentials", "mcp"],
        expected,
      })
    }).pipe(Effect.provide(layer)),
  )

  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "config_missing", message: expect.stringContaining("agents/second.md") }),
      expect.objectContaining({ code: "credential_missing", message: expect.stringContaining("credential-2") }),
    ]),
  )
})

test("reports oversized target config and credential files without allocating them", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source.db")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await Promise.all([mkdir(targetConfig), mkdir(targetData)])
  const config = path.join(targetConfig, "graph-vibe.json")
  const auth = path.join(targetData, "auth.json")
  await Bun.write(config, "{}")
  await Bun.write(auth, "{}")
  await truncate(config, 8 * 1024 * 1024 + 1)
  await truncate(auth, 1024 * 1024 + 1)
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const issues = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration.validate({
        sourceDatabase,
        targetConfig,
        targetData,
        categories: ["config", "credentials"],
        expected: validationExpected({
          configPaths: ["graph-vibe.json"],
          auth: placeholderFile("auth.json"),
        }),
      }),
    ).pipe(Effect.provide(layer)),
  )

  expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["config_limit", "credential_limit"]))
})

test("migrates configuration and credentials without copying disposable dependencies", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(path.join(sourceConfig, "agents"), { recursive: true })
  await mkdir(path.join(sourceConfig, "skills", "review"), { recursive: true })
  await mkdir(path.join(sourceConfig, "skills", "cache"), { recursive: true })
  await mkdir(path.join(sourceConfig, "node_modules", "ignored"), { recursive: true })
  await mkdir(path.join(sourceConfig, "commands"), { recursive: true })
  await mkdir(path.join(sourceConfig, "themes"), { recursive: true })
  await mkdir(path.join(sourceConfig, "references"), { recursive: true })
  await mkdir(path.join(sourceConfig, "plugins"), { recursive: true })
  await mkdir(path.join(sourceConfig, "plugins", "node_modules", "ignored"), { recursive: true })
  await mkdir(path.join(sourceConfig, "cache"), { recursive: true })
  await mkdir(path.join(sourceConfig, "logs"), { recursive: true })
  await mkdir(sourceData)
  await mkdir(targetConfig)
  await Bun.write(path.join(sourceConfig, "opencode.json"), JSON.stringify({ model: "test/model" }))
  await Bun.write(path.join(sourceConfig, "config.json"), JSON.stringify({ small_model: "test/small" }))
  await Bun.write(path.join(sourceConfig, "agents", "review.md"), "review agent")
  await Bun.write(path.join(sourceConfig, "skills", "review", "SKILL.md"), "review skill")
  await Bun.write(path.join(sourceConfig, "skills", "cache", "SKILL.md"), "cache skill")
  await Bun.write(path.join(sourceConfig, "commands", "check.md"), "check command")
  await Bun.write(path.join(sourceConfig, "themes", "dark.json"), "{}")
  await Bun.write(path.join(sourceConfig, "references", "rules.md"), "rules")
  await Bun.write(path.join(sourceConfig, "plugins", "local.ts"), "export default {}")
  await Bun.write(path.join(sourceConfig, "plugins", "node_modules", "ignored", "index.js"), "ignored")
  await Bun.write(path.join(sourceConfig, "tui.jsonc"), '{ "theme": "dark" }')
  await Bun.write(path.join(sourceConfig, "node_modules", "ignored", "package.json"), "{}")
  await Bun.write(path.join(sourceConfig, "cache", "state"), "ignored")
  await Bun.write(path.join(sourceConfig, "logs", "latest.log"), "ignored")
  await Bun.write(path.join(sourceConfig, "package.json"), "{}")
  await Bun.write(path.join(sourceConfig, "package-lock.json"), "{}")
  await Bun.write(path.join(sourceData, "auth.json"), JSON.stringify({ provider: { type: "api", key: "secret" } }))
  await Bun.write(
    path.join(sourceData, "mcp-auth.json"),
    JSON.stringify({ docs: { tokens: { accessToken: "token" } } }),
  )
  await chmod(path.join(sourceData, "auth.json"), 0o600)
  await chmod(path.join(sourceData, "mcp-auth.json"), 0o600)
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.run(
    `INSERT INTO credential VALUES ('credential-1', 'provider', 'default', '{"type":"key","key":"secret"}', NULL, NULL, 1, 1, 1)`,
  )
  sqlite.close()
  const sourceHash = Bun.hash(await Bun.file(path.join(sourceConfig, "opencode.json")).arrayBuffer())
  const sourceAuthHash = Bun.hash(await Bun.file(path.join(sourceData, "auth.json")).arrayBuffer())
  const sourceDatabaseHash = Bun.hash(await Bun.file(sourceDatabase).arrayBuffer())
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const migrated = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      const result = yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
      const retry = yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
      const { db } = yield* Database.Service
      const credentials = yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)
      return { result, retry, credentials }
    }).pipe(Effect.provide(layer)),
  )

  expect(migrated.result).toMatchObject({ configFiles: 8, credentialFiles: 2, databaseCredentials: 1 })
  expect(await Bun.file(path.join(targetConfig, "graph-vibe.json")).json()).toEqual({
    small_model: "test/small",
    model: "test/model",
  })
  expect(await Bun.file(path.join(targetConfig, "agents", "review.md")).text()).toBe("review agent")
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "SKILL.md")).text()).toBe("review skill")
  expect(await Bun.file(path.join(targetConfig, "skills", "cache")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "commands", "check.md")).text()).toBe("check command")
  expect(await Bun.file(path.join(targetConfig, "themes", "dark.json")).json()).toEqual({})
  expect(await Bun.file(path.join(targetConfig, "references", "rules.md")).text()).toBe("rules")
  expect(await Bun.file(path.join(targetConfig, "plugins", "local.ts")).text()).toBe("export default {}")
  expect(await Bun.file(path.join(targetConfig, "plugins", "node_modules")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "tui.jsonc")).text()).toBe('{ "theme": "dark" }')
  expect(await Bun.file(path.join(targetConfig, "node_modules")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "cache")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "logs")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "package.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "package-lock.json")).exists()).toBe(false)
  expect((await stat(path.join(targetData, "auth.json"))).mode & 0o777).toBe(0o600)
  expect((await stat(path.join(targetData, "mcp-auth.json"))).mode & 0o777).toBe(0o600)
  expect(Bun.hash(await Bun.file(path.join(sourceConfig, "opencode.json")).arrayBuffer())).toBe(sourceHash)
  expect(Bun.hash(await Bun.file(path.join(sourceData, "auth.json")).arrayBuffer())).toBe(sourceAuthHash)
  expect(Bun.hash(await Bun.file(sourceDatabase).arrayBuffer())).toBe(sourceDatabaseHash)

  expect(migrated.credentials).toHaveLength(1)
  expect(migrated.retry).toEqual({ configFiles: 8, credentialFiles: 2, databaseCredentials: 0 })
})

test("retries configuration after package installation creates disposable artifacts", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(Effect.provide(layer)),
  )
  await mkdir(path.join(targetConfig, "node_modules", "dependency"), { recursive: true })
  await mkdir(path.join(targetConfig, ".cache"))
  await Bun.write(path.join(targetConfig, "package.json"), '{ "dependencies": {} }')
  await Bun.write(path.join(targetConfig, "bun.lock"), "lockfile")
  await Bun.write(path.join(targetConfig, "node_modules", "dependency", "index.js"), "installed")

  const retry = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(Effect.provide(layer)),
  )

  expect(retry.configFiles).toBe(1)
  expect(await Bun.file(path.join(targetConfig, "graph-vibe.json")).json()).toEqual({ model: "source" })
})

test("rejects disposable target symlinks before retrying configuration", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  const outside = path.join(tmp.path, "outside")
  await Promise.all([mkdir(sourceConfig), mkdir(sourceData), mkdir(outside)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData }),
    ).pipe(Effect.provide(layer)),
  )
  await symlink(outside, path.join(targetConfig, "node_modules"), "dir")

  const error = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  )

  expect(error._tag).toBe("ProductMigrationConfigTargetConflict")
  expect(await readdir(outside)).toEqual([])
})

test("executes and validates nested config while excluding disposable package artifacts", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const sourceState = path.join(tmp.path, "source-state")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  const skill = path.join(sourceConfig, "skills", "review")
  const rustArtifact = path.join(skill, "target", "release", "deps", "libreview.rlib")
  await Promise.all([
    mkdir(path.join(skill, "node_modules", "dependency"), { recursive: true }),
    mkdir(path.join(skill, "cache"), { recursive: true }),
    mkdir(path.join(skill, "logs"), { recursive: true }),
    mkdir(path.dirname(rustArtifact), { recursive: true }),
    mkdir(path.join(skill, "dist"), { recursive: true }),
    mkdir(path.join(skill, "build"), { recursive: true }),
    mkdir(path.join(skill, "coverage"), { recursive: true }),
    mkdir(path.join(skill, "scripts", "bin"), { recursive: true }),
    mkdir(sourceData),
    mkdir(sourceState),
    mkdir(targetData),
  ])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  await Bun.write(path.join(skill, "SKILL.md"), "review")
  await Bun.write(path.join(skill, "package.json"), "{}")
  await Bun.write(path.join(skill, "package-lock.json"), "{}")
  await Bun.write(path.join(skill, "bun.lock"), "lock")
  await Bun.write(path.join(skill, "node_modules", "dependency", "index.js"), "ignored")
  await Bun.write(path.join(skill, "cache", "state"), "ignored")
  await Bun.write(path.join(skill, "logs", "latest.log"), "ignored")
  await Bun.write(rustArtifact, "x")
  await truncate(rustArtifact, 8 * 1024 * 1024 + 1)
  await Bun.write(path.join(skill, "dist", "bundle.js"), "ignored")
  await Bun.write(path.join(skill, "build", "output.js"), "ignored")
  await Bun.write(path.join(skill, "coverage", "report.json"), "ignored")
  await Bun.write(path.join(skill, "scripts", "bin", "harnessctl"), "runtime")
  await chmod(path.join(skill, "scripts", "bin", "harnessctl"), 0o755)
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new sqliteModule.Database(sourceDatabase, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  const platform = AppNodeBuilder.build(FSUtil.node)
  const sourceLayer = ProductMigrationSource.layer.pipe(Layer.provideMerge(platform))
  const configLayer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(platform),
  )

  const discovery = await Effect.runPromise(
    ProductMigrationSource.Service.use((source) =>
      source.discover({ data: sourceData, config: sourceConfig, state: sourceState }),
    ).pipe(Effect.provide(sourceLayer)),
  )
  const issues = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migration
        .migrate({
          sourceConfig,
          sourceData,
          sourceDatabase,
          targetConfig,
          targetData,
          databaseFingerprint: discovery.databaseFingerprint,
          categories: ["config"],
          expected: discovery.expected,
        })
        .pipe(
          Effect.andThen(
            migration.validate({
              sourceDatabase,
              targetConfig,
              targetData,
              categories: ["config"],
              expected: discovery.expected,
            }),
          ),
        ),
    ).pipe(Effect.provide(configLayer)),
  )

  expect(issues).toEqual([])
  expect(discovery.expected.configPaths).toEqual([
    "graph-vibe.json",
    "skills/review/SKILL.md",
    "skills/review/scripts/bin/harnessctl",
  ])
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "SKILL.md")).text()).toBe("review")
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "scripts", "bin", "harnessctl")).text()).toBe(
    "runtime",
  )
  expect((await stat(path.join(targetConfig, "skills", "review", "scripts", "bin", "harnessctl"))).mode & 0o777).toBe(
    0o755,
  )
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "package.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "node_modules")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "target")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "dist")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "build")).exists()).toBe(false)
  expect(await Bun.file(path.join(targetConfig, "skills", "review", "coverage")).exists()).toBe(false)
})

test("rejects an accepted config parent swapped outside the canonical source root before reading", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  const outside = path.join(tmp.path, "outside")
  const agents = path.join(sourceConfig, "agents")
  await Promise.all([mkdir(agents, { recursive: true }), mkdir(sourceData), mkdir(targetData), mkdir(outside)])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  await Bun.write(path.join(agents, "review.md"), "inside")
  await Bun.write(path.join(outside, "review.md"), "outside secret")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const platform = AppNodeBuilder.build(FSUtil.node)
  const swapped = { value: false }
  const swappingFS = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        readDirectoryEntries: (directory) =>
          fs.readDirectoryEntries(directory).pipe(
            Effect.tap(() => {
              if (directory !== agents || swapped.value) return Effect.void
              swapped.value = true
              return Effect.promise(async () => {
                await rename(agents, `${agents}-original`)
                await symlink(outside, agents, "dir")
              })
            }),
          ),
      })
    }),
  ).pipe(Layer.provide(platform))
  const layer = ProductMigrationConfig.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(":memory:")),
    Layer.provideMerge(swappingFS),
  )

  const result = await Effect.runPromise(
    ProductMigrationConfig.Service.use((migration) =>
      migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData }).pipe(Effect.exit),
    ).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result)).toBe(true)
  expect(await Bun.file(path.join(targetConfig, "agents", "review.md")).exists()).toBe(false)
})

test("rejects relative paths before writing", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migration.migrate({
        sourceConfig: "relative-config",
        sourceData: "/source-data",
        sourceDatabase: "/source-data/opencode.db",
        targetConfig: "/target-config",
        targetData: "/target-data",
        databaseFingerprint: "unreachable",
        expected: validationExpected({}),
      })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigInvalidPath")
})

test("rejects a populated target without changing either tree", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await mkdir(targetConfig)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(path.join(targetConfig, "graph-vibe.json"), '{ "model": "target" }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData: path.join(tmp.path, "target-data"),
      })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigTargetConflict")
  expect(await Bun.file(path.join(sourceConfig, "opencode.json")).text()).toBe('{ "model": "source" }')
  expect(await Bun.file(path.join(targetConfig, "graph-vibe.json")).text()).toBe('{ "model": "target" }')
})

test("does not leave a target when staging fails", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const blocked = path.join(tmp.path, "blocked")
  const targetConfig = path.join(blocked, "target-config")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(blocked, "not a directory")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData: path.join(tmp.path, "target-data"),
      })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigError")
  expect(await Bun.file(targetConfig).exists()).toBe(false)
  expect(await Bun.file(path.join(sourceConfig, "opencode.json")).text()).toBe('{ "model": "source" }')
})

test("rejects target roots that resolve through symlinks into the source", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  await symlink(sourceData, targetData, "dir")

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigInvalidPath")
  expect(await Bun.file(path.join(sourceConfig, "opencode.json")).text()).toBe('{ "model": "source" }')
})

test("preserves existing credentials and removes staging after a conflict", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await mkdir(targetData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(path.join(sourceData, "auth.json"), '{ "provider": { "type": "api", "key": "source" } }')
  await chmod(path.join(sourceData, "auth.json"), 0o644)
  await Bun.write(path.join(targetData, "auth.json"), '{ "provider": { "type": "api", "key": "target" } }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigTargetConflict")
  expect(await Bun.file(targetConfig).exists()).toBe(false)
  expect((await readdir(tmp.path)).some((name) => name.startsWith("target-config.migration-"))).toBe(false)
  expect(await Bun.file(path.join(targetData, "auth.json")).text()).toBe(
    '{ "provider": { "type": "api", "key": "target" } }',
  )
  expect(await Bun.file(path.join(targetData, "auth.json.migration-staging")).exists()).toBe(false)
})

test("does not follow a credential staging symlink", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await mkdir(targetData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(path.join(sourceData, "auth.json"), '{ "provider": { "type": "api", "key": "source" } }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()
  const sourceHash = Bun.hash(await Bun.file(sourceDatabase).arrayBuffer())
  await symlink(sourceDatabase, path.join(targetData, "auth.json.migration-staging"))
  await symlink(path.join(sourceData, "auth.json"), path.join(targetData, "auth.json"))

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(Bun.hash(await Bun.file(sourceDatabase).arrayBuffer())).toBe(sourceHash)
  expect((await stat(path.join(sourceData, "auth.json"))).mode & 0o777).toBe(0o644)
  expect(await Bun.file(path.join(targetData, "auth.json")).text()).toBe(
    '{ "provider": { "type": "api", "key": "source" } }',
  )
  expect((await lstat(path.join(targetData, "auth.json"))).isSymbolicLink()).toBe(false)
  expect((await stat(path.join(targetData, "auth.json"))).mode & 0o777).toBe(0o600)
})

test("extracts legacy TUI settings from the main configuration", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(
    path.join(sourceConfig, "opencode.json"),
    JSON.stringify({
      model: "source",
      theme: "legacy",
      keybinds: { app_exit: "ctrl+x" },
      tui: { diff_style: "stacked" },
    }),
  )
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(await Bun.file(path.join(targetConfig, "graph-vibe.json")).json()).toEqual({ model: "source" })
  expect(await Bun.file(path.join(targetConfig, "tui.json")).json()).toEqual({
    $schema: "https://opencode.ai/tui.json",
    theme: "legacy",
    keybinds: { app_exit: "ctrl+x" },
    diff_style: "stacked",
  })
})

test("corrects permissions on an identical existing credential file", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await mkdir(targetData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  const auth = '{ "provider": { "type": "api", "key": "source" } }'
  await Bun.write(path.join(sourceData, "auth.json"), auth)
  await Bun.write(path.join(targetData, "auth.json"), auth)
  await chmod(path.join(targetData, "auth.json"), 0o644)
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect((await stat(path.join(targetData, "auth.json"))).mode & 0o777).toBe(0o600)
})

test("rejects malformed credential files before promotion", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  const targetData = path.join(tmp.path, "target-data")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(path.join(sourceData, "auth.json"), '{ "provider": { "type": "api" } }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, { sourceConfig, sourceData, sourceDatabase, targetConfig, targetData })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigError")
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

test("rejects malformed TUI configuration before promotion", async () => {
  await using tmp = await tmpdir()
  const sourceConfig = path.join(tmp.path, "source-config")
  const sourceData = path.join(tmp.path, "source-data")
  const targetConfig = path.join(tmp.path, "target-config")
  await mkdir(sourceConfig)
  await mkdir(sourceData)
  await Bun.write(path.join(sourceConfig, "opencode.json"), '{ "model": "source" }')
  await Bun.write(path.join(sourceConfig, "tui.json"), '{ "attention": { "volume": 2 } }')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  new sqliteModule.Database(sourceDatabase, { create: true }).close()

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationConfig.Service
      return yield* migrate(migration, {
        sourceConfig,
        sourceData,
        sourceDatabase,
        targetConfig,
        targetData: path.join(tmp.path, "target-data"),
      })
    }).pipe(
      Effect.flip,
      Effect.provide(
        ProductMigrationConfig.layer.pipe(
          Layer.provideMerge(Database.layerFromPath(":memory:")),
          Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
        ),
      ),
    ),
  )

  expect(error._tag).toBe("ProductMigrationConfigError")
  expect(await Bun.file(targetConfig).exists()).toBe(false)
})

function migrate(
  migration: ProductMigrationConfig.Interface,
  input: Omit<Parameters<ProductMigrationConfig.Interface["migrate"]>[0], "expected" | "databaseFingerprint">,
) {
  return Effect.promise(async () => ({
    expected: await expectedInventory(input.sourceConfig, input.sourceData, input.sourceDatabase),
    databaseFingerprint: await databaseFingerprintFor(input.sourceDatabase),
  })).pipe(Effect.flatMap((planned) => migration.migrate({ ...input, ...planned })))
}

async function databaseFingerprintFor(database: string) {
  const canonical = await realpath(database)
  const identity = await ProductMigrationSnapshot.databaseIdentity(canonical)
  const source = new sqliteModule.Database(canonical, { readonly: true })
  const sessionCount = source
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
    .get()
    ? (source.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0)
    : 0
  source.close(false)
  return ProductMigrationSource.fingerprint({
    database: canonical,
    databaseBytes: identity.size,
    sessionCount,
    identity,
  })
}

async function expectedInventory(sourceConfig: string, sourceData: string, sourceDatabase: string) {
  const configSources: ProductMigrationSource.ExpectedFile[] = []
  const add = async (file: string, relative: string) => {
    configSources.push({
      path: relative.replaceAll(path.sep, "/"),
      sha256: createHash("sha256")
        .update(Buffer.from(await Bun.file(file).arrayBuffer()))
        .digest("hex"),
    })
  }
  const scan = async (directory: string, relative: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (ProductMigrationConfigPolicy.isDisposable(entry.name)) continue
      const file = path.join(directory, entry.name)
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await scan(file, child)
      if (entry.isFile()) await add(file, child)
    }
  }
  for (const name of ["config.json", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"]) {
    const file = path.join(sourceConfig, name)
    if (await Bun.file(file).exists()) await add(file, name)
  }
  for (const name of ProductMigrationConfigPolicy.directories) {
    const directory = path.join(sourceConfig, name)
    if (
      await lstat(directory).then(
        (info) => info.isDirectory(),
        () => false,
      )
    )
      await scan(directory, name)
  }
  const expectedFile = async (name: string) => {
    const file = path.join(sourceData, name)
    if (!(await Bun.file(file).exists())) return null
    return {
      path: name,
      sha256: createHash("sha256")
        .update(Buffer.from(await Bun.file(file).arrayBuffer()))
        .digest("hex"),
    }
  }
  const packageFile = path.join(sourceConfig, "package.json")
  const credentialIDs = await Bun.file(sourceDatabase)
    .exists()
    .then((exists) => {
      if (!exists) return []
      const source = new sqliteModule.Database(sourceDatabase, { readonly: true })
      const ids = source
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
        .get()
        ? source
            .query<{ id: string }, []>("SELECT id FROM credential ORDER BY id")
            .all()
            .map((row) => row.id)
        : []
      source.close(false)
      return ids
    })
  return {
    configPaths: [],
    configSources: configSources.toSorted((left, right) => left.path.localeCompare(right.path)),
    auth: await expectedFile("auth.json"),
    mcpAuth: await expectedFile("mcp-auth.json"),
    dependencies: (await Bun.file(packageFile).exists())
      ? ProductMigrationSource.registryDependencies(await Bun.file(packageFile).text())
      : [],
    credentialIDs,
  } satisfies ProductMigrationSource.ExpectedInventory
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}
