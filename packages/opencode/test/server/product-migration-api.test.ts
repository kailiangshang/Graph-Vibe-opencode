import { afterAll, beforeEach, describe, expect } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Product } from "@opencode-ai/core/product"
import { ProductMigrationService } from "@opencode-ai/core/product-migration/service"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"
import { ProductMigrationSourceRoots } from "@opencode-ai/core/product-migration/roots"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { ProductMigrationPaths } from "../../src/server/routes/instance/httpapi/groups/product-migration"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlerLayers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const root = await mkdtemp(path.join(os.tmpdir(), "product-migration-api-"))
const targetData = path.join(root, "target-data")
const targetConfig = path.join(root, "target-config")
const targetState = path.join(root, "target-state")
const targetCache = path.join(root, "target-cache")
const targetTmp = path.join(root, "target-tmp")
const sourceRoot = path.join(root, "source")
const sourceData = path.join(sourceRoot, "data")
const sourceConfig = path.join(sourceRoot, "config")
const sourceState = path.join(sourceRoot, "state")

const services = (profile: Product.Profile) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ProductMigrationService.node,
      ProductMigrationState.node,
      Database.node,
      EventV2Bridge.node,
      Product.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [
        ProductMigrationSourceRoots.node,
        ProductMigrationSourceRoots.layerWith([
          {
            id: "fixture",
            data: sourceData,
            config: sourceConfig,
            state: sourceState,
            database: path.join(sourceData, "opencode.db"),
          },
        ]),
      ],
      [
        Global.node,
        Global.layerWith({
          data: targetData,
          config: targetConfig,
          state: targetState,
          cache: targetCache,
          tmp: targetTmp,
          log: path.join(targetData, "log"),
          repos: path.join(targetData, "repos"),
          bin: path.join(targetCache, "bin"),
        }),
      ],
      [Product.node, Product.layerWith(profile)],
    ],
  )
const api = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, ...globalHandlerLayers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(api.pipe(Layer.provideMerge(services(Product.GraphVibe))))
const openCodeIt = testEffect(api.pipe(Layer.provideMerge(services(Product.OpenCode))))

describe.serial("product migration HttpApi", () => {
  beforeEach(async () => {
    await rm(targetData, { recursive: true, force: true })
    await rm(targetConfig, { recursive: true, force: true })
    await Promise.all([
      mkdir(targetData, { recursive: true }),
      mkdir(targetConfig, { recursive: true }),
      mkdir(targetState, { recursive: true }),
      mkdir(targetCache, { recursive: true }),
      mkdir(targetTmp, { recursive: true }),
    ])
  })

  it.live("discovers a source and returns only bounded, redacted projections", () =>
    Effect.gen(function* () {
      const source = yield* sourceFixture({ authSecret: "provider-secret-never-return" })

      const discovered = yield* send(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })

      expect(discovered.status).toBe(200)
      expect(discovered.json).toMatchObject({ status: "draft", revision: 1 })
      expect(JSON.stringify(discovered.json)).not.toContain("provider-secret-never-return")
      expect(JSON.stringify(discovered.json)).not.toContain("accessToken")

      const projection = yield* get(ProductMigrationPaths.get)
      expect(projection.status).toBe(200)
      expect(projection.json).toEqual(discovered.json)
      expect(projection.text.length).toBeLessThan(64_000)

      const stale = yield* send(ProductMigrationPaths.updateDraft, {
        expectedRevision: 0,
        categories: [{ category: "config", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      expect(stale.status).toBe(409)
      expect(stale.json).toMatchObject({
        _tag: "ProductMigrationRevisionConflict",
        expectedRevision: 0,
        actualRevision: 1,
      })
    }),
  )

  it.live("executes, pauses, resumes, validates, and finalizes an immutable plan revision", () =>
    Effect.gen(function* () {
      const source = yield* sourceFixture({ authSecret: "copied-secret-never-return" })
      const discovered = yield* mutation(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })
      const draft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: discovered.revision,
        categories: [
          { category: "config", selected: true },
          { category: "credentials", selected: true },
          { category: "mcp", selected: true },
        ],
        sessionsEnabled: false,
        sessions: [],
      })
      const copied = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: draft.revision })

      expect(copied.status).toBe("copying")
      expect(copied.items.every((item) => item.status === "completed")).toBe(true)
      expect(JSON.stringify(copied)).not.toContain("copied-secret-never-return")
      expect(yield* Effect.promise(() => Bun.file(path.join(targetData, "auth.json")).text())).toContain(
        "copied-secret-never-return",
      )

      const paused = yield* mutation(ProductMigrationPaths.pause, { expectedRevision: copied.revision })
      expect(paused.status).toBe("paused")
      const resumed = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: paused.revision })
      expect(resumed.status).toBe("copying")
      expect(resumed.plan?.revision).toBe(draft.plan?.revision)

      const validated = yield* mutation(ProductMigrationPaths.validate, { expectedRevision: resumed.revision })
      expect(validated).toMatchObject({ status: "ready_to_finalize", canFinalize: true })
      const finalized = yield* mutation(ProductMigrationPaths.finalize, { expectedRevision: validated.revision })
      expect(finalized).toMatchObject({
        status: "completed",
        canFinalize: false,
        source: null,
        plan: null,
        validation: null,
        items: [],
      })

      const state = yield* ProductMigrationState.Service
      yield* state.requireCompleted()
      yield* Effect.promise(() => rm(source.data, { recursive: true, force: true }))
      const rediscovery = yield* send(ProductMigrationPaths.discover, {
        expectedRevision: finalized.revision,
        source: "fixture",
      })
      expect(rediscovery.status).toBe(409)
      expect(rediscovery.json).toMatchObject({ _tag: "ProductMigrationFinalized" })
      const rejected = yield* send(ProductMigrationPaths.pause, { expectedRevision: finalized.revision })
      expect(rejected.status).toBe(409)
      expect(rejected.json).toMatchObject({ _tag: "ProductMigrationFinalized" })
    }),
  )

  it.live("journals bounded failures and supports retrying and skipping failed items", () =>
    Effect.gen(function* () {
      const source = yield* sourceFixture({ invalidConfig: true })
      const discovered = yield* mutation(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })
      const draft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: discovered.revision,
        categories: [{ category: "config", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      const failed = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: draft.revision })

      expect(failed.status).toBe("failed")
      expect(failed.items).toHaveLength(1)
      expect(failed.items[0].status).toBe("failed")
      expect(failed.items[0].error?.length).toBeLessThanOrEqual(512)
      expect(failed.items[0].error).not.toContain("invalid-config-secret")

      yield* Effect.promise(() => Bun.write(path.join(source.config, "opencode.json"), JSON.stringify({})))
      const retry = yield* mutation(ProductMigrationPaths.retry, {
        expectedRevision: failed.revision,
        itemID: failed.items[0].itemID,
      })
      const changed = yield* send(ProductMigrationPaths.execute, { expectedRevision: retry.revision })
      expect(changed.status).toBe(422)
      expect(changed.json).toMatchObject({ _tag: "ProductMigrationSourceError", code: "changed" })

      const rediscovered = yield* send(ProductMigrationPaths.discover, {
        expectedRevision: retry.revision,
        source: "fixture",
      })
      expect(rediscovered.status).toBe(409)
      expect(rediscovered.json).toMatchObject({ _tag: "ProductMigrationConflict" })

      const sourceToSkip = yield* sourceFixture({ invalidConfig: true })
      yield* resetMigrationJournal()
      const skippedDiscovery = yield* mutation(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })
      const skippedDraft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: skippedDiscovery.revision,
        categories: [{ category: "config", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      const skipFailure = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: skippedDraft.revision })
      const skipped = yield* mutation(ProductMigrationPaths.skip, {
        expectedRevision: skipFailure.revision,
        itemID: skipFailure.items[0].itemID,
      })
      expect(skipped.items[0].status).toBe("skipped")
    }),
  )

  it.live("fresh start permanently opens the Graph Vibe gate", () =>
    Effect.gen(function* () {
      yield* resetMigrationJournal()
      const state = yield* ProductMigrationState.Service
      expect(Exit.isFailure(yield* state.requireCompleted().pipe(Effect.exit))).toBe(true)

      const completed = yield* mutation(ProductMigrationPaths.freshStart, { expectedRevision: 0 })
      expect(completed).toMatchObject({ status: "completed", revision: 1 })
      yield* state.requireCompleted()
    }),
  )

  it.live("rejects validation when migrated credential permissions are not private", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      yield* sourceFixture({ authSecret: "private" })
      const discovered = yield* mutation(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })
      const draft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: discovered.revision,
        categories: [{ category: "credentials", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      const copied = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: draft.revision })
      yield* Effect.promise(() => chmod(path.join(targetData, "auth.json"), 0o644))

      const response = yield* send(ProductMigrationPaths.validate, { expectedRevision: copied.revision })

      expect(response.status).toBe(422)
      expect(response.json).toMatchObject({
        _tag: "ProductMigrationValidationFailed",
        issues: [{ code: "credential_mode" }],
      })
    }),
  )

  it.live("rejects validation when a migrated TUI config no longer decodes", () =>
    Effect.gen(function* () {
      yield* sourceFixture({ tui: true })
      const discovered = yield* mutation(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: "fixture",
      })
      const draft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: discovered.revision,
        categories: [{ category: "config", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      const copied = yield* mutation(ProductMigrationPaths.execute, { expectedRevision: draft.revision })
      yield* Effect.promise(() => Bun.write(path.join(targetConfig, "tui.json"), '{"leader_timeout":0}'))

      const response = yield* send(ProductMigrationPaths.validate, { expectedRevision: copied.revision })

      expect(response.status).toBe(422)
      expect(response.json).toMatchObject({
        _tag: "ProductMigrationValidationFailed",
        issues: [{ code: "config_invalid" }],
      })
    }),
  )

  openCodeIt.live("rejects the migration API for the OpenCode product profile", () =>
    Effect.gen(function* () {
      const response = yield* get(ProductMigrationPaths.get)

      expect(response.status).toBe(404)
      expect(response.json).toMatchObject({ _tag: "ProductMigrationUnavailable" })
      expect(yield* (yield* ProductMigrationState.Service).get()).toBeUndefined()
    }),
  )

  it.live("rejects arbitrary remote source roots", () =>
    Effect.gen(function* () {
      const response = yield* send(ProductMigrationPaths.discover, {
        expectedRevision: 0,
        source: {
          data: "/tmp/untrusted-data",
          config: "/tmp/untrusted-config",
          state: "/tmp/untrusted-state",
          database: "/tmp/untrusted.db",
        },
      })

      expect(response.status).toBe(400)
    }),
  )

  it.live("returns a declared error for a corrupt migration journal", () =>
    Effect.gen(function* () {
      yield* sourceFixture({})
      yield* mutation(ProductMigrationPaths.discover, { expectedRevision: 0, source: "fixture" })
      const { db } = yield* Database.Service
      yield* db.run("UPDATE product_migration SET plan = '{' WHERE id = 'opencode-first-import'").pipe(Effect.orDie)

      const response = yield* get(ProductMigrationPaths.get)

      expect(response.status).toBe(422)
      expect(response.json).toMatchObject({ _tag: "ProductMigrationSourceError", code: "unreadable" })
    }),
  )

  it.live("publishes ordered authoritative revisions when a mutation returns a typed failure", () =>
    Effect.gen(function* () {
      const revisions: Array<{ status: string; revision: number }> = []
      const listener = (event: { payload: { type?: string; properties?: { status: string; revision: number } } }) => {
        if (event.payload.type === "product.migration.updated" && event.payload.properties) {
          revisions.push(event.payload.properties)
        }
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      yield* sourceFixture({})
      const discovered = yield* mutation(ProductMigrationPaths.discover, { expectedRevision: 0, source: "fixture" })
      const draft = yield* mutation(ProductMigrationPaths.updateDraft, {
        expectedRevision: discovered.revision,
        categories: [{ category: "config", selected: true }],
        sessionsEnabled: false,
        sessions: [],
      })
      yield* Effect.promise(() => Bun.write(path.join(targetConfig, "conflict.json"), "{}"))

      const response = yield* send(ProductMigrationPaths.execute, { expectedRevision: draft.revision })

      expect(response.status).toBe(409)
      expect(response.json).toMatchObject({ _tag: "ProductMigrationConflict" })
      expect(revisions).toEqual([
        { status: "draft", revision: discovered.revision },
        { status: "draft", revision: draft.revision },
        { status: "failed", revision: draft.revision + 2 },
      ])
    }),
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function get(url: string) {
  return Effect.gen(function* () {
    const response = yield* HttpClient.get(url)
    const text = yield* response.text
    return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  })
}

function send(url: string, body: unknown) {
  return Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)),
      HttpClient.execute,
    )
    const text = yield* response.text
    return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  })
}

function mutation(url: string, body: unknown) {
  return Effect.gen(function* () {
    const response = yield* send(url, body)
    if (response.status !== 200) {
      return yield* Effect.die(new Error(`Expected 200 from ${url}, got ${response.status}: ${response.text}`))
    }
    return response.json as {
      status: string
      revision: number
      canFinalize: boolean
      plan: { revision: number } | null
      items: Array<{ itemID: string; status: string; error: string | null }>
    }
  })
}

function sourceFixture(input: { authSecret?: string; invalidConfig?: boolean; tui?: boolean }) {
  return Effect.gen(function* () {
    yield* resetMigrationJournal()
    return yield* Effect.promise(async () => {
      await rm(sourceRoot, { recursive: true, force: true })
      const directory = sourceRoot
      const data = sourceData
      const config = sourceConfig
      const state = sourceState
      await Promise.all([
        mkdir(data, { recursive: true }),
        mkdir(config, { recursive: true }),
        mkdir(state, { recursive: true }),
      ])
      await Bun.write(
        path.join(config, "opencode.json"),
        input.invalidConfig ? "{ invalid-config-secret" : JSON.stringify({ model: "test/model" }),
      )
      await Bun.write(path.join(config, "package.json"), JSON.stringify({ dependencies: {} }))
      if (input.tui) await Bun.write(path.join(config, "tui.json"), JSON.stringify({ leader_timeout: 100 }))
      if (input.authSecret) {
        await Bun.write(
          path.join(data, "auth.json"),
          JSON.stringify({ provider: { type: "api", key: input.authSecret } }),
        )
      }
      const database = path.join(data, "opencode.db")
      const sqliteModule = await import("bun:sqlite")
      const sqlite = new sqliteModule.Database(database, { create: true })
      sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
      sqlite.run(
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
      )
      sqlite.run("INSERT INTO project VALUES ('project-1', ?)", [directory])
      sqlite.close()
      return { directory, data, config, state, paths: { data, config, state, database } }
    })
  })
}

function resetMigrationJournal() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run("DELETE FROM product_migration_item").pipe(Effect.orDie)
    yield* db.run("DELETE FROM product_migration_entity").pipe(Effect.orDie)
    yield* db.run("DELETE FROM product_migration").pipe(Effect.orDie)
    yield* Effect.promise(() => rm(targetConfig, { recursive: true, force: true }))
    yield* Effect.promise(() => mkdir(targetConfig, { recursive: true }))
  })
}
