import { expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdir, readdir, rm, statfs } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Product } from "@opencode-ai/core/product"
import { ProductMigrationConfig } from "@opencode-ai/core/product-migration/config"
import { ProductMigrationGraph } from "@opencode-ai/core/product-migration/graph"
import { ProductMigrationService } from "@opencode-ai/core/product-migration/service"
import { ProductMigrationSession } from "@opencode-ai/core/product-migration/session"
import { ProductMigrationSourceRoots } from "@opencode-ai/core/product-migration/roots"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import {
  ProductMigrationEntityTable,
  ProductMigrationItemTable,
  ProductMigrationTable,
} from "@opencode-ai/core/product-migration/sql"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"
import { eq, sql } from "drizzle-orm"

test("pause completes while a category is blocked and stops unstarted categories", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const started = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const calls: string[] = []
  const layer = migrationLayer(fixture, {
    migrate: (input) =>
      Effect.gen(function* () {
        const category = input.categories?.[0] ?? "none"
        calls.push(category)
        if (category !== "config") return { configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return { configFiles: 1, credentialFiles: 0, databaseCredentials: 0 }
      }),
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationService.Service
        const draft = yield* selectedDraft(migration)
        const running = yield* migration.execute({ expectedRevision: draft.revision }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const copying = yield* migration.get()
        const paused = yield* Effect.race(
          migration.pause({ expectedRevision: copying.revision }),
          Effect.sleep("1 second").pipe(Effect.andThen(Effect.die("pause waited for execute"))),
        )
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)

        expect(paused.status).toBe("paused")
        expect(calls).toEqual(["config"])
        expect((yield* migration.get()).items.map((item) => [item.category, item.status])).toEqual([
          ["config", "completed"],
          ["credentials", "pending"],
          ["mcp", "pending"],
        ])
      }).pipe(Effect.provide(layer)),
    ),
  )
})

test("recovers copying lifecycle and item state after process interruption", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const calls: string[] = []
  const layer = migrationLayer(fixture, {
    migrate: (input) =>
      Effect.sync(() => {
        calls.push(input.categories?.[0] ?? "none")
        return { configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const { db } = yield* Database.Service
      yield* db
        .update(ProductMigrationTable)
        .set({ status: "copying", revision: draft.revision + 1 })
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(ProductMigrationItemTable)
        .set({ status: "copying" })
        .where(eq(ProductMigrationItemTable.category, "config"))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* migration.execute({ expectedRevision: draft.revision + 1 })

      expect(recovered.status).toBe("copying")
      expect(recovered.items.every((item) => item.status === "completed")).toBe(true)
      expect(calls).toEqual(["config", "credentials", "mcp"])
    }).pipe(Effect.provide(layer)),
  )
})

test("reruns validation from a persisted validating journal", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      const { db } = yield* Database.Service
      yield* db
        .update(ProductMigrationTable)
        .set({ status: "validating", revision: copied.revision + 1 })
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* migration.validate({ expectedRevision: copied.revision + 1 })

      expect(recovered.status).toBe("ready_to_finalize")
    }).pipe(Effect.provide(layer)),
  )
})

test("shares one source snapshot across a fifty-session execution batch", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.run("INSERT INTO project VALUES ('project-1', ?)", [fixture.sourceData])
  Array.from({ length: 50 }, (_, index) => `session-${index}`).forEach((id, index) =>
    source.run("INSERT INTO session VALUES (?, 'project-1', ?, ?)", [id, id, index]),
  )
  source.close()
  const observed = new Set<string>()
  const counts: number[] = []
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    importSession: (input) =>
      Effect.promise(async () => {
        const entries = await readdir(path.join(fixture.targetData, "product-migration-snapshots"), {
          withFileTypes: true,
        }).catch(() => [])
        const snapshots = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        counts.push(snapshots.length)
        snapshots.forEach((entry) => observed.add(entry))
        return {
          sessions: input.selections.map((selection) => ({
            sourceID: selection.sessionID,
            targetID: `ses_${selection.sessionID}`,
            projectID: selection.projectID,
            status: "ready" as const,
            checkpoint: "none" as const,
            detached: false,
            missingFiles: [],
            rejectedFiles: [],
          })),
        }
      }),
    importGraph: () => Effect.succeed({ sessions: [] }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const sessions = discovered.plan?.projects.flatMap((project) =>
        project.sessions.map((session) => ({ projectID: project.id, sessionID: session.id, selected: true })),
      )
      if (!sessions) return yield* Effect.die("Expected discovered sessions")
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [],
        sessionsEnabled: true,
        sessions,
      })
      yield* migration.execute({ expectedRevision: draft.revision })
    }).pipe(Effect.provide(layer)),
  )

  expect(counts).toHaveLength(50)
  expect(new Set(counts)).toEqual(new Set([1]))
  expect(observed.size).toBe(1)
})

test("keeps one separate source snapshot active for the validation batch", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const observed: string[][] = []
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    validate: () =>
      Effect.promise(async () => {
        const entries = await readdir(path.join(fixture.targetData, "product-migration-snapshots"), {
          withFileTypes: true,
        }).catch(() => [])
        observed.push(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        return []
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      yield* migration.validate({ expectedRevision: copied.revision })
    }).pipe(Effect.provide(layer)),
  )

  expect(observed).toHaveLength(1)
  expect(observed[0]).toHaveLength(1)
})

test("rechecks the source manifest at the end of validation", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    validate: () =>
      Effect.promise(async () => {
        await Bun.write(path.join(fixture.sourceConfig, "opencode.json"), '{"changed":true}')
        return []
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      const error = yield* migration.validate({ expectedRevision: copied.revision }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "ProductMigrationSourceError", code: "changed" })
    }).pipe(Effect.provide(layer)),
  )
})

test("returns a validated migration to draft and preserves completed work while adding sessions", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.run("INSERT INTO project VALUES ('project-1', '/workspace/current')")
  source.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Add later', 1)")
  source.close()
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      const ready = yield* migration.validate({ expectedRevision: copied.revision })
      const categories = ready.plan!.categories.map((item) => ({ category: item.category, selected: item.selected }))
      const sessions = ready.plan!.projects.flatMap((project) =>
        project.sessions.map((session) => ({ projectID: project.id, sessionID: session.id, selected: false })),
      )
      const reopened = yield* migration.updateDraft({
        expectedRevision: ready.revision,
        categories,
        sessionsEnabled: false,
        sessions,
      })
      expect(reopened.status).toBe("draft")
      expect(reopened.items.every((item) => item.status === "completed")).toBe(true)

      const added = yield* migration.updateDraft({
        expectedRevision: reopened.revision,
        categories,
        sessionsEnabled: true,
        sessions: sessions.map((session, index) => ({ ...session, selected: index === 0 })),
      })
      expect(added.items.filter((item) => item.status === "completed")).toHaveLength(reopened.items.length)
      expect(added.items.some((item) => item.category === "session" && item.status === "pending")).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})

test("reopens a reselected skipped item as pending", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      const { db } = yield* Database.Service
      const skipped = copied.items[0]!
      yield* db
        .update(ProductMigrationItemTable)
        .set({ status: "skipped" })
        .where(eq(ProductMigrationItemTable.item_id, skipped.itemID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(ProductMigrationTable)
        .set({
          status: "ready_to_finalize",
          revision: copied.revision + 1,
          validation: JSON.stringify({ valid: true, issues: [] }),
        })
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .run()
        .pipe(Effect.orDie)
      const ready = yield* migration.get()

      const reopened = yield* migration.updateDraft({
        expectedRevision: ready.revision,
        categories: ready.plan!.categories.map((item) => ({ category: item.category, selected: item.selected })),
        sessionsEnabled: false,
        sessions: [],
      })

      expect(reopened.items.find((item) => item.itemID === skipped.itemID)?.status).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )
})

test("resets a copying item on the first execute from paused", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const calls: string[] = []
  const layer = migrationLayer(fixture, {
    migrate: (input) =>
      Effect.sync(() => {
        calls.push(input.categories?.[0] ?? "none")
        return { configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const { db } = yield* Database.Service
      yield* db
        .update(ProductMigrationTable)
        .set({ status: "paused", revision: draft.revision + 1 })
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(ProductMigrationItemTable)
        .set({ status: "copying" })
        .where(eq(ProductMigrationItemTable.category, "config"))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* migration.execute({ expectedRevision: draft.revision + 1 })

      expect(recovered.items.every((item) => item.status === "completed")).toBe(true)
      expect(calls).toEqual(["config", "credentials", "mcp"])
    }).pipe(Effect.provide(layer)),
  )
})

test("rejects a transient source mutation before dependency installation", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  await Bun.write(path.join(fixture.sourceConfig, "package.json"), '{"dependencies":{"safe":"1.2.3"}}')
  const installs: Array<ReadonlyArray<{ name: string; version?: string }>> = []
  const layer = migrationLayer(fixture, {
    migrate: (input) =>
      Effect.promise(async () => {
        if (input.categories?.[0] === "config") {
          await Bun.write(
            path.join(fixture.sourceConfig, "package.json"),
            '{"dependencies":{"unexpected":"file:../outside"}}',
          )
        }
        return { configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }
      }),
    install: (_dir, input) => Effect.sync(() => installs.push(input?.add ?? [])),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const error = yield* migration.execute({ expectedRevision: draft.revision }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "ProductMigrationSourceError" })
      expect(installs).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})

test("installs the exact sorted dependency specs stored in the plan", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  await Bun.write(path.join(fixture.sourceConfig, "package.json"), '{"dependencies":{"zeta":"^2.0.0","alpha":"1.0.0"}}')
  const installs: Array<ReadonlyArray<{ name: string; version?: string }>> = []
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    install: (_dir, input) => Effect.sync(() => installs.push(input?.add ?? [])),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      yield* migration.execute({ expectedRevision: draft.revision })

      expect(installs).toEqual([
        [
          { name: "alpha", version: "1.0.0" },
          { name: "zeta", version: "^2.0.0" },
        ],
      ])
    }).pipe(Effect.provide(layer)),
  )
})

test("fails only the active category and leaves later categories pending", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: (input) =>
      input.categories?.[0] === "credentials"
        ? Effect.fail(new ProductMigrationConfig.MigrationError({ path: fixture.sourceData, cause: new Error("fail") }))
        : Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const failed = yield* migration.execute({ expectedRevision: draft.revision })

      expect(failed.status).toBe("failed")
      expect(failed.items.map((item) => [item.category, item.status])).toEqual([
        ["config", "completed"],
        ["credentials", "failed"],
        ["mcp", "pending"],
      ])
      expect(
        yield* migration
          .updateDraft({
            expectedRevision: failed.revision,
            categories: [{ category: "config", selected: false }],
            sessionsEnabled: false,
            sessions: [],
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProductMigrationConflict" })
      expect(
        yield* migration.discover({ expectedRevision: failed.revision, source: "fixture" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProductMigrationConflict" })
      expect(yield* migration.freshStart({ expectedRevision: failed.revision }).pipe(Effect.flip)).toMatchObject({
        _tag: "ProductMigrationInvalidTransition",
      })
      expect(yield* migration.get()).toMatchObject({
        status: "failed",
        revision: failed.revision,
        plan: { revision: failed.plan?.revision },
        items: [
          { category: "config", status: "completed" },
          { category: "credentials", status: "failed" },
          { category: "mcp", status: "pending" },
        ],
      })
    }).pipe(Effect.provide(layer)),
  )
})

test("unselects a skipped category in the stored plan before validation and finalization", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () =>
      Effect.fail(new ProductMigrationConfig.MigrationError({ path: fixture.sourceConfig, cause: new Error("fail") })),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [
          { category: "config", selected: true },
          { category: "credentials", selected: false },
          { category: "mcp", selected: false },
        ],
        sessionsEnabled: false,
        sessions: [],
      })
      const failed = yield* migration.execute({ expectedRevision: draft.revision })
      const retried = yield* migration.retry({ expectedRevision: failed.revision, itemID: "category:config" })
      expect(retried.plan?.revision).toBe(draft.plan?.revision)
      expect(retried.plan?.categories.find((category) => category.category === "config")?.selected).toBe(true)
      const failedAgain = yield* migration.execute({ expectedRevision: retried.revision })
      const skipped = yield* migration.skip({
        expectedRevision: failedAgain.revision,
        itemID: "category:config",
      })

      expect(skipped.plan?.revision).toBe(skipped.revision)
      expect(skipped.plan?.requiredBytes).toBe(0)
      expect(skipped.plan?.categories.find((category) => category.category === "config")?.selected).toBe(false)
      const resumed = yield* migration.execute({ expectedRevision: skipped.revision })
      const validated = yield* migration.validate({ expectedRevision: resumed.revision })
      const finalized = yield* migration.finalize({ expectedRevision: validated.revision })
      expect(finalized.status).toBe("completed")
    }).pipe(Effect.provide(layer)),
  )
})

test("unselects only the skipped session while preserving session migration mode", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.run("INSERT INTO project VALUES ('project-1', ?)", [fixture.sourceData])
  source.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Imported session', 1)")
  source.run("INSERT INTO session VALUES ('session-2', 'project-1', 'Other session', 2)")
  source.close()
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    importSession: () =>
      Effect.fail(
        new ProductMigrationSession.ImportError({ operation: "import selected session", cause: new Error("fail") }),
      ),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [
          { category: "config", selected: false },
          { category: "credentials", selected: false },
          { category: "mcp", selected: false },
        ],
        sessionsEnabled: true,
        sessions: [
          { projectID: "project-1", sessionID: "session-1", selected: true },
          { projectID: "project-1", sessionID: "session-2", selected: true },
        ],
      })
      const failed = yield* migration.execute({ expectedRevision: draft.revision })
      const failedItem = failed.items.find((item) => item.category === "session" && item.status === "failed")
      const pendingItem = failed.items.find((item) => item.category === "session" && item.status === "pending")
      if (!failedItem?.sourceID || !pendingItem?.sourceID)
        return yield* Effect.die("Expected failed and pending sessions")
      const skipped = yield* migration.skip({
        expectedRevision: failed.revision,
        itemID: failedItem.itemID,
      })

      expect(skipped.plan?.revision).toBe(skipped.revision)
      expect(skipped.plan?.sessionsEnabled).toBe(true)
      const sessions = skipped.plan?.projects.find((project) => project.id === "project-1")?.sessions
      expect(sessions?.find((session) => session.id === failedItem.sourceID)?.selected).toBe(false)
      expect(sessions?.find((session) => session.id === pendingItem.sourceID)?.selected).toBe(true)
      expect(skipped.plan?.requiredBytes).toBe(
        sessions?.find((session) => session.id === pendingItem.sourceID)?.estimatedBytes,
      )

      const failedAgain = yield* migration.execute({ expectedRevision: skipped.revision })
      const failedAgainItem = failedAgain.items.find((item) => item.category === "session" && item.status === "failed")
      if (!failedAgainItem) return yield* Effect.die("Expected the remaining session to fail")
      const skippedAgain = yield* migration.skip({
        expectedRevision: failedAgain.revision,
        itemID: failedAgainItem.itemID,
      })
      expect(skippedAgain.plan?.requiredBytes).toBe(0)
      const resumed = yield* migration.execute({ expectedRevision: skippedAgain.revision })
      const validated = yield* migration.validate({ expectedRevision: resumed.revision })
      const finalized = yield* migration.finalize({ expectedRevision: validated.revision })
      expect(finalized.status).toBe("completed")
    }).pipe(Effect.provide(layer)),
  )
})

test("cleans failed and skipped session closures while preserving a completed shared-project session", async () => {
  await using tmp = await tmpdir()
  const fixture = await cleanupFixture(tmp.path)
  const layer = liveMigrationLayer(fixture)

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [
          { category: "config", selected: false },
          { category: "credentials", selected: false },
          { category: "mcp", selected: false },
        ],
        sessionsEnabled: true,
        sessions: [
          { projectID: "project-shared", sessionID: "ses_shared_good", selected: true },
          { projectID: "project-shared", sessionID: "ses_shared_bad", selected: true },
          { projectID: "project-orphan", sessionID: "ses_orphan_bad", selected: true },
        ],
      })
      const failedOrphan = yield* migration.execute({ expectedRevision: draft.revision })
      expect(failedOrphan.items.find((item) => item.sourceID === "ses_orphan_bad")?.status).toBe("failed")
      const skippedOrphan = yield* migration.skip({
        expectedRevision: failedOrphan.revision,
        itemID: "session:ses_orphan_bad",
      })
      const failedShared = yield* migration.execute({ expectedRevision: skippedOrphan.revision })
      expect(failedShared.items.find((item) => item.sourceID === "ses_shared_good")?.status).toBe("completed")
      expect(failedShared.items.find((item) => item.sourceID === "ses_shared_bad")?.status).toBe("failed")
      const skippedShared = yield* migration.skip({
        expectedRevision: failedShared.revision,
        itemID: "session:ses_shared_bad",
      })
      const resumed = yield* migration.execute({ expectedRevision: skippedShared.revision })
      const validated = yield* migration.validate({ expectedRevision: resumed.revision })
      const { db } = yield* Database.Service
      const mappings = yield* db.all<{ entity_type: string; source_id: string; target_id: string }>(sql`
        SELECT entity_type, source_id, target_id
        FROM product_migration_entity
        WHERE migration_id = 'opencode-first-import'
        ORDER BY entity_type, source_id
      `)
      const finalized = yield* migration.finalize({ expectedRevision: validated.revision })
      return {
        finalized,
        sessions: yield* db.all<{ id: string; metadata: string }>(sql`SELECT id, metadata FROM session ORDER BY id`),
        projects: yield* db.all<{ id: string }>(sql`SELECT id FROM project ORDER BY id`),
        mappings,
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.finalized.status).toBe("completed")
  expect(result.sessions).toHaveLength(1)
  expect(JSON.parse(result.sessions[0]?.metadata ?? "{}").productMigration.sourceID).toBe("ses_shared_good")
  expect(result.projects).toHaveLength(1)
  expect(result.mappings.map((mapping) => `${mapping.entity_type}:${mapping.source_id}`)).toContain(
    "project:project-shared",
  )
  expect(
    result.mappings.some(
      (mapping) =>
        mapping.source_id.includes("shared_bad") ||
        mapping.source_id.includes("orphan_bad") ||
        mapping.source_id === "project-orphan",
    ),
  ).toBe(false)
  expect([...new Bun.Glob("product-migration/**/*").scanSync({ cwd: fixture.targetData })]).toEqual([])
}, 20_000)

test("service import preserves a selected parent relationship and ready child status", async () => {
  await using tmp = await tmpdir()
  const fixture = await cleanupFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.prepare(
    `INSERT INTO session
       (id, project_id, workspace_id, parent_id, slug, directory, title, version, metadata, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        time_created, time_updated)
     VALUES (?, 'project-shared', NULL, ?, ?, ?, ?, '1', '{}', 0, 0, 0, 0, 0, 0, 1, ?)`,
  ).run("ses_selected_child", "ses_shared_good", "selected-child", fixture.sharedProject, "Selected child", 11)
  source.prepare("UPDATE session SET time_updated = 10 WHERE id = ?").run("ses_shared_good")
  source.run("PRAGMA wal_checkpoint(TRUNCATE)")
  source.close()
  const layer = liveMigrationLayer(fixture)

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: discovered.plan?.categories.map((category) => ({ category: category.category, selected: false })) ?? [],
        sessionsEnabled: true,
        sessions: [
          { projectID: "project-shared", sessionID: "ses_shared_good", selected: true },
          { projectID: "project-shared", sessionID: "ses_selected_child", selected: true },
        ],
      })
      const executed = yield* migration.execute({ expectedRevision: draft.revision })
      const retry = yield* migration.execute({ expectedRevision: executed.revision })
      const { db } = yield* Database.Service
      const mappings = yield* db.all<{ source_id: string; target_id: string }>(sql`
        SELECT source_id, target_id FROM product_migration_entity
        WHERE migration_id = 'opencode-first-import' AND entity_type = 'session'
      `)
      const childID = mappings.find((mapping) => mapping.source_id === "ses_selected_child")?.target_id
      const child = childID
        ? yield* db.get<{ parent_id: string | null; metadata: string }>(sql`
            SELECT parent_id, metadata FROM session WHERE id = ${childID}
          `)
        : undefined
      return {
        executed,
        retry,
        mappings,
        child,
        versions: yield* db.all<{ session_id: string | null }>(sql`
          SELECT session_id FROM graph_version
          WHERE session_id IN (${mappings[0]?.target_id ?? ""}, ${mappings[1]?.target_id ?? ""})
        `),
        sessions: yield* db.all<{ id: string; metadata: string }>(sql`
          SELECT id, metadata FROM session
          WHERE id IN (${mappings[0]?.target_id ?? ""}, ${mappings[1]?.target_id ?? ""})
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  const parentID = result.mappings.find((mapping) => mapping.source_id === "ses_shared_good")?.target_id
  expect(result.executed.items.filter((item) => item.category === "session").every((item) => item.status === "completed")).toBe(true)
  expect(result.retry.items.filter((item) => item.category === "session")).toEqual(
    result.executed.items.filter((item) => item.category === "session"),
  )
  expect(result.mappings).toHaveLength(2)
  expect(result.executed.items.find((item) => item.sourceID === "ses_shared_good")?.targetID).toBe(parentID)
  expect(result.child?.parent_id).toBe(parentID)
  expect(JSON.parse(result.child?.metadata ?? "{}").productMigration).toMatchObject({
    status: "ready",
    checkpoint: "none",
    missingParent: false,
  })
  expect(result.versions).toHaveLength(2)
  expect(
    result.sessions.every(
      (session) => JSON.parse(session.metadata).productMigration.graphEnhancement?.id !== undefined,
    ),
  ).toBe(true)
}, 20_000)

test("normal execution queues destination enhancement that applies idempotently after finalization", async () => {
  await using tmp = await tmpdir()
  const fixture = await cleanupFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, 'ses_shared_good', 'user', 1, 1, 1, ?)`,
  ).run(
    "msg_service_source",
    JSON.stringify({ text: "Goal: Service migration\nTask: Queue enhancement", time: { created: 1 } }),
  )
  source.run("PRAGMA wal_checkpoint(TRUNCATE)")
  source.close()
  const layer = liveMigrationLayer(fixture)

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: discovered.plan?.categories.map((category) => ({ category: category.category, selected: false })) ?? [],
        sessionsEnabled: true,
        sessions: [{ projectID: "project-shared", sessionID: "ses_shared_good", selected: true }],
      })
      const executed = yield* migration.execute({ expectedRevision: draft.revision })
      const { db } = yield* Database.Service
      const mapping = yield* db.get<{ target_id: string }>(sql`
        SELECT target_id FROM product_migration_entity
        WHERE migration_id = 'opencode-first-import' AND entity_type = 'session'
          AND source_id = 'ses_shared_good'
      `)
      if (!mapping) return yield* Effect.die("Expected imported session mapping")
      const destination = yield* db.get<{ metadata: string }>(sql`
        SELECT metadata FROM session WHERE id = ${mapping.target_id}
      `)
      const marker = JSON.parse(destination?.metadata ?? "{}").productMigration?.graphEnhancement as
        | { id: string; request: unknown; model: unknown }
        | undefined
      if (!marker) return yield* Effect.die("Expected queued destination enhancement metadata")
      const task = yield* db.get<{ content: string }>(sql`
        SELECT content FROM graph_node WHERE session_id = ${mapping.target_id} AND type = 'atomic' LIMIT 1
      `)
      const taskSourceID = (JSON.parse(task?.content ?? "{}").migration as { source_id?: string } | undefined)
        ?.source_id
      if (!taskSourceID) return yield* Effect.die("Expected reconstructed task source ID")
      const validated = yield* migration.validate({ expectedRevision: executed.revision })
      const finalized = yield* migration.finalize({ expectedRevision: validated.revision })
      yield* Effect.promise(() => rm(fixture.sourceData, { recursive: true }))
      const graph = yield* ProductMigrationGraph.Service
      const enhancement = {
        enhancementID: marker.id,
        model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-service") },
        modules: [
          {
            name: "Queued service module",
            taskSourceIDs: [taskSourceID],
            sourceMessageIDs: ["msg_service_source"],
            confidence: 0.8,
          },
        ],
        dependencies: [],
      }
      const applied = yield* graph.applyEnhancement(enhancement)
      const retry = yield* graph.applyEnhancement(enhancement)
      return {
        executed,
        marker,
        finalized,
        applied,
        retry,
        journal: yield* db.get<Record<string, unknown>>(sql`
          SELECT source_path, source_fingerprint, plan FROM product_migration
          WHERE id = 'opencode-first-import'
        `),
        mappings: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM product_migration_entity`),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.executed.items.find((item) => item.sourceID === "ses_shared_good")?.status).toBe("completed")
  expect(result.marker).toMatchObject({
    id: expect.stringMatching(/^geh_/),
    request: { toolChoice: "none", tools: [] },
  })
  expect(result.marker.model).toBeNull()
  expect(result.finalized.status).toBe("completed")
  expect(result.journal).toMatchObject({ source_path: null, source_fingerprint: null, plan: null })
  expect(result.mappings).toEqual([])
  expect(result.applied.replaced).toBe(false)
  expect(result.retry).toMatchObject({
    versionID: result.applied.versionID,
    versionNumber: result.applied.versionNumber,
    replaced: true,
  })
}, 20_000)

test("rediscovery and fresh start reject a draft with durable entity mappings", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const { db } = yield* Database.Service
      yield* db
        .insert(ProductMigrationEntityTable)
        .values({
          migration_id: "opencode-first-import",
          entity_type: "session",
          source_id: "ses_source",
          source_fingerprint: draft.plan?.sourceFingerprint ?? "",
          target_id: "ses_target",
        })
        .run()
        .pipe(Effect.orDie)

      expect(
        yield* migration.discover({ expectedRevision: draft.revision, source: "fixture" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProductMigrationConflict" })
      expect(yield* migration.freshStart({ expectedRevision: draft.revision }).pipe(Effect.flip)).toMatchObject({
        _tag: "ProductMigrationConflict",
      })
      expect(yield* db.select().from(ProductMigrationEntityTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }).pipe(Effect.provide(layer)),
  )
})

test("computes selected bytes only and fresh start clears an untouched draft", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const selected = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [
          { category: "config", selected: true },
          { category: "credentials", selected: false },
          { category: "mcp", selected: false },
        ],
        sessionsEnabled: false,
        sessions: [],
      })
      const configBytes = selected.plan?.categories.find((category) => category.category === "config")?.estimatedBytes

      expect(selected.plan?.requiredBytes).toBe(configBytes)
      const completed = yield* migration.freshStart({ expectedRevision: selected.revision })
      expect(completed).toMatchObject({ status: "completed", source: null, plan: null, items: [] })
    }).pipe(Effect.provide(layer)),
  )
})

test("preflights selected output allocation together with planned snapshot bytes", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      const snapshotBytes = draft.source?.databaseBytes
      if (!snapshotBytes) return yield* Effect.die("Expected planned snapshot bytes")
      const disk = yield* Effect.promise(() => statfs(fixture.targetData))
      const availableBytes = disk.bavail * disk.bsize
      const selectedBytes = availableBytes - snapshotBytes + 1
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ plan: ProductMigrationTable.plan })
        .from(ProductMigrationTable)
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .get()
        .pipe(Effect.orDie)
      if (!row?.plan) return yield* Effect.die("Expected stored migration plan")
      yield* db
        .update(ProductMigrationTable)
        .set({ plan: JSON.stringify({ ...JSON.parse(row.plan), requiredBytes: selectedBytes }) })
        .where(eq(ProductMigrationTable.id, "opencode-first-import"))
        .run()
        .pipe(Effect.orDie)

      const error = yield* migration.execute({ expectedRevision: draft.revision }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "ProductMigrationInsufficientSpace",
        requiredBytes: selectedBytes + snapshotBytes,
      })
    }).pipe(Effect.provide(layer)),
  )
})

test("fails closed when available migration storage cannot be inspected", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const draft = yield* selectedDraft(migration)
      yield* Effect.promise(() => rm(fixture.targetData, { recursive: true }))

      const error = yield* migration.execute({ expectedRevision: draft.revision }).pipe(Effect.flip)
      const current = yield* migration.get()

      expect(error).toMatchObject({ _tag: "ProductMigrationSourceError", code: "unreadable" })
      expect(current.status).toBe("draft")
      expect(current.items.every((item) => item.status === "pending")).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})

test("validation rejects corrupted imported session state", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const source = new SqliteDatabase(fixture.sourceDatabase)
  source.run("INSERT INTO project VALUES ('project-1', ?)", [fixture.sourceData])
  source.run("INSERT INTO session VALUES ('session-1', 'project-1', 'Imported session', 1)")
  source.close()
  const layer = migrationLayer(fixture, {
    migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
    importSession: (input) =>
      Effect.succeed({
        sessions: [
          {
            sourceID: "session-1",
            targetID: "ses_target",
            projectID: "target-project",
            status: "ready" as const,
            checkpoint: "none" as const,
            detached: false,
            missingFiles: [],
            rejectedFiles: [],
          },
        ],
      }),
    importGraph: () => Effect.succeed({ sessions: [] }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* ProductMigrationService.Service
      const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
      const draft = yield* migration.updateDraft({
        expectedRevision: discovered.revision,
        categories: [],
        sessionsEnabled: true,
        sessions: [{ projectID: "project-1", sessionID: "session-1", selected: true }],
      })
      const copied = yield* migration.execute({ expectedRevision: draft.revision })
      const { db } = yield* Database.Service
      yield* db
        .run(
          `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
           VALUES ('target-project', '${fixture.target}', '[]', 0, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO session
             (id, project_id, slug, directory, title, version, metadata, time_created, time_updated)
           VALUES
             ('ses_target', 'target-project', 'imported', '${fixture.target}', 'Imported session', '1',
               '{"productMigration":{"migrationID":"wrong-migration","sourceID":"session-1","closure":{"legacyMessages":1,"parts":1,"currentMessages":1,"inputs":2,"todos":1,"projectID":"project-1","projectDirectoryCount":1,"projectDirectories":["${fixture.target}"],"workspaceID":"workspace-1","permissionCount":1,"permissionIDs":["permission-1"]},"copiedFileCount":1,"copiedFileBytes":134217729,"copiedFiles":[{"path":"product-migration/ses_target/missing.txt","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":134217729}]}}', 0, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .insert(ProductMigrationEntityTable)
        .values([
          {
            migration_id: "opencode-first-import",
            entity_type: "project",
            source_id: "project-1",
            source_fingerprint: copied.plan?.sourceFingerprint ?? "",
            target_id: "target-project",
          },
          {
            migration_id: "opencode-first-import",
            entity_type: "workspace",
            source_id: "workspace-1",
            source_fingerprint: copied.plan?.sourceFingerprint ?? "",
            target_id: "wrk_target",
          },
          {
            migration_id: "opencode-first-import",
            entity_type: "permission",
            source_id: "permission-1",
            source_fingerprint: copied.plan?.sourceFingerprint ?? "",
            target_id: "target-permission",
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO project_directory (project_id, directory, time_created)
           VALUES ('target-project', '${fixture.target}', 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO workspace (id, type, name, project_id, time_used)
           VALUES ('wrk_target', 'local', 'Imported', 'target-project', 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO permission (id, project_id, action, resource, time_created, time_updated)
           VALUES ('target-permission', 'target-project', 'allow', 'repository', 0, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db.run("DELETE FROM project_directory WHERE project_id = 'target-project'").pipe(Effect.orDie)
      yield* db.run("DELETE FROM workspace WHERE id = 'wrk_target'").pipe(Effect.orDie)
      yield* db.run("DELETE FROM permission WHERE id = 'target-permission'").pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
           VALUES ('input-1', 'ses_target', '{"text":"pending"}', 'queue', 1, NULL, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db.run("PRAGMA foreign_keys = OFF").pipe(Effect.orDie)
      yield* db
        .run(
          `INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
           VALUES ('input-orphan', 'ses_missing', '{"text":"orphan"}', 'queue', 1, 1, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db.run("PRAGMA foreign_keys = ON").pipe(Effect.orDie)
      const copiedFiles = path.join(fixture.targetData, "product-migration", "ses_target")
      yield* Effect.promise(() => mkdir(copiedFiles, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(copiedFiles, "0000000000000000-attachment.txt"), "corrupt"))
      const error = yield* migration.validate({ expectedRevision: copied.revision }).pipe(Effect.flip)

      expect(error._tag).toBe("ProductMigrationValidationFailed")
      if (error._tag !== "ProductMigrationValidationFailed") return
      expect(error.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "session_marker_invalid",
          "session_legacy_message_count",
          "session_part_count",
          "session_current_message_count",
          "session_input_count",
          "session_todo_count",
          "session_project_directory_count",
          "session_workspace_missing",
          "session_permission_count",
          "session_input_pending",
          "graph_missing",
          "foreign_key_violation",
          "copied_file_missing",
          "copied_file_hash",
          "copied_file_limit",
        ]),
      )
    }).pipe(Effect.provide(layer)),
  )
})

function selectedDraft(migration: ProductMigrationService.Interface) {
  return Effect.gen(function* () {
    const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
    return yield* migration.updateDraft({
      expectedRevision: discovered.revision,
      categories: [
        { category: "config", selected: true },
        { category: "credentials", selected: true },
        { category: "mcp", selected: true },
      ],
      sessionsEnabled: false,
      sessions: [],
    })
  })
}

function migrationLayer(
  fixture: Awaited<ReturnType<typeof migrationFixture>>,
  options: Pick<ProductMigrationConfig.Interface, "migrate"> & {
    readonly validate?: ProductMigrationConfig.Interface["validate"]
    readonly importSession?: ProductMigrationSession.Interface["import"]
    readonly importGraph?: ProductMigrationGraph.Interface["import"]
    readonly install?: Npm.Interface["install"]
  },
) {
  return AppNodeBuilder.build(LayerNode.group([ProductMigrationService.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
    [Product.node, Product.layerWith(Product.GraphVibe)],
    [
      Global.node,
      Global.layerWith({
        data: fixture.targetData,
        config: fixture.targetConfig,
        state: path.join(fixture.target, "state"),
        cache: path.join(fixture.target, "cache"),
        tmp: path.join(fixture.target, "tmp"),
        log: path.join(fixture.targetData, "log"),
        repos: path.join(fixture.targetData, "repos"),
        bin: path.join(fixture.target, "bin"),
      }),
    ],
    [
      ProductMigrationSourceRoots.node,
      ProductMigrationSourceRoots.layerWith([
        {
          id: "fixture",
          data: fixture.sourceData,
          config: fixture.sourceConfig,
          state: fixture.sourceState,
          database: fixture.sourceDatabase,
        },
      ]),
    ],
    [
      ProductMigrationConfig.node,
      Layer.mock(ProductMigrationConfig.Service)({
        ...options,
        validate: options.validate ?? (() => Effect.succeed([])),
      }),
    ],
    [
      ProductMigrationSession.node,
      Layer.mock(ProductMigrationSession.Service)({
        ...(options.importSession ? { import: options.importSession } : {}),
        cleanup: () => Effect.void,
      }),
    ],
    [
      ProductMigrationGraph.node,
      Layer.mock(ProductMigrationGraph.Service)({
        ...(options.importGraph ? { import: options.importGraph } : {}),
        queueEnhancement: (input) =>
          Effect.succeed({
            enhancementID: `enhancement:${input.sourceSessionID}`,
            targetSessionID: `ses_${input.sourceSessionID}`,
            model: undefined,
            sourceMessageIDs: [],
            bounds: { maxMessages: 64, maxBytes: 65_536 },
            truncation: {
              truncated: false,
              availableMessages: 0,
              selectedMessages: 0,
              selectedBytes: 0,
            },
            request: { system: [], messages: [], tools: [], toolChoice: "none" },
          }),
      }),
    ],
    [Npm.node, Layer.mock(Npm.Service)({ install: options.install ?? (() => Effect.void) })],
  ])
}

function liveMigrationLayer(fixture: Awaited<ReturnType<typeof cleanupFixture>>) {
  return AppNodeBuilder.build(
    LayerNode.group([ProductMigrationService.node, ProductMigrationGraph.node, Database.node]),
    [
      [Database.node, Database.layerFromPath(fixture.targetDatabase)],
      [Product.node, Product.layerWith(Product.GraphVibe)],
      [
        Global.node,
        Global.layerWith({
          data: fixture.targetData,
          config: fixture.targetConfig,
          state: path.join(fixture.target, "state"),
          cache: path.join(fixture.target, "cache"),
          tmp: path.join(fixture.target, "tmp"),
          log: path.join(fixture.targetData, "log"),
          repos: path.join(fixture.targetData, "repos"),
          bin: path.join(fixture.target, "bin"),
        }),
      ],
      [
        ProductMigrationSourceRoots.node,
        ProductMigrationSourceRoots.layerWith([
          {
            id: "fixture",
            data: fixture.sourceData,
            config: fixture.sourceConfig,
            state: fixture.sourceState,
            database: fixture.sourceDatabase,
          },
        ]),
      ],
      [
        ProductMigrationConfig.node,
        Layer.mock(ProductMigrationConfig.Service)({
          migrate: () => Effect.succeed({ configFiles: 0, credentialFiles: 0, databaseCredentials: 0 }),
          validate: () => Effect.succeed([]),
        }),
      ],
      [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
    ],
  )
}

async function migrationFixture(root: string) {
  const source = path.join(root, "source")
  const sourceData = path.join(source, "data")
  const sourceConfig = path.join(source, "config")
  const sourceState = path.join(source, "state")
  const target = path.join(root, "target")
  const targetData = path.join(target, "data")
  const targetConfig = path.join(target, "config")
  await Promise.all([
    mkdir(sourceData, { recursive: true }),
    mkdir(sourceConfig, { recursive: true }),
    mkdir(sourceState, { recursive: true }),
    mkdir(targetData, { recursive: true }),
    mkdir(targetConfig, { recursive: true }),
  ])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  await Bun.write(path.join(sourceConfig, "package.json"), '{"dependencies":{}}')
  await Bun.write(path.join(sourceData, "auth.json"), '{"provider":{"type":"api","key":"secret"}}')
  await Bun.write(path.join(sourceData, "mcp-auth.json"), '{"docs":{"tokens":{"accessToken":"secret"}}}')
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const sqlite = new SqliteDatabase(sourceDatabase, { create: true })
  sqlite.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL)")
  sqlite.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL)",
  )
  sqlite.close()
  return { sourceData, sourceConfig, sourceState, sourceDatabase, target, targetData, targetConfig }
}

async function cleanupFixture(root: string) {
  const source = path.join(root, "source")
  const sourceData = path.join(source, "data")
  const sourceConfig = path.join(source, "config")
  const sourceState = path.join(source, "state")
  const sharedProject = path.join(root, "shared-project")
  const orphanProject = path.join(root, "orphan-project")
  const target = path.join(root, "target")
  const targetData = path.join(target, "data")
  const targetConfig = path.join(target, "config")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const targetDatabase = path.join(targetData, "graph-vibe.db")
  const attachment = path.join(sourceData, "attachments", "cleanup.txt")
  await Promise.all([
    mkdir(path.dirname(attachment), { recursive: true }),
    mkdir(sourceConfig, { recursive: true }),
    mkdir(sourceState, { recursive: true }),
    mkdir(sharedProject),
    mkdir(orphanProject),
    mkdir(targetData, { recursive: true }),
    mkdir(targetConfig, { recursive: true }),
  ])
  await Bun.write(path.join(sourceConfig, "opencode.json"), "{}")
  await Bun.write(path.join(sourceConfig, "package.json"), '{"dependencies":{}}')
  await Bun.write(attachment, "cleanup payload")
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(sourceDatabase))),
  )
  const database = new SqliteDatabase(sourceDatabase)
  database.run("PRAGMA foreign_keys = ON")
  database
    .prepare(
      `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
       VALUES (?, ?, ?, 1, 1, '[]')`,
    )
    .run("project-shared", sharedProject, "Shared")
  database
    .prepare(
      `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
       VALUES (?, ?, ?, 1, 1, '[]')`,
    )
    .run("project-orphan", orphanProject, "Orphan")
  database
    .prepare(
      `INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
       VALUES (?, ?, 'main', 'git', 1)`,
    )
    .run("project-shared", sharedProject)
  database
    .prepare(
      `INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
       VALUES (?, ?, 'main', 'git', 1)`,
    )
    .run("project-orphan", orphanProject)
  const insertSession = database.prepare(
    `INSERT INTO session
       (id, project_id, slug, directory, title, version, metadata, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, '1', '{}', 0, 0, 0, 0, 0, 0, 1, ?)`,
  )
  insertSession.run("ses_shared_good", "project-shared", "shared-good", sharedProject, "Shared good", 4)
  insertSession.run("ses_shared_bad", "project-shared", "shared-bad", sharedProject, "Shared bad", 3)
  insertSession.run("ses_orphan_bad", "project-orphan", "orphan-bad", orphanProject, "Orphan bad", 2)
  const insertInput = database.prepare(
    `INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
     VALUES (?, ?, ?, 'steer', 1, NULL, 1)`,
  )
  const prompt = JSON.stringify({
    text: "cleanup",
    files: [{ uri: pathToFileURL(attachment).href, mime: "text/plain" }],
  })
  insertInput.run("input_shared_bad", "ses_shared_bad", prompt)
  insertInput.run("input_orphan_bad", "ses_orphan_bad", prompt)
  database.run(`
    WITH RECURSIVE rows(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM rows WHERE value <= 100000
    )
    INSERT INTO graph_node (id, project_id, session_id, type, name, level, time_created, time_updated)
    SELECT printf('node_shared_bad_%06d', value), 'project-shared', 'ses_shared_bad', 'atomic', 'Limit', 'L2', 1, 1
    FROM rows
  `)
  database.run(`
    WITH RECURSIVE rows(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM rows WHERE value <= 100000
    )
    INSERT INTO graph_node (id, project_id, session_id, type, name, level, time_created, time_updated)
    SELECT printf('node_orphan_bad_%06d', value), 'project-orphan', 'ses_orphan_bad', 'atomic', 'Limit', 'L2', 1, 1
    FROM rows
  `)
  database.run("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
  return {
    sourceData,
    sourceConfig,
    sourceState,
    sourceDatabase,
    target,
    targetData,
    targetConfig,
    targetDatabase,
    sharedProject,
  }
}
