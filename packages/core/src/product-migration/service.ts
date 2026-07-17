export * as ProductMigrationService from "./service"

import { lstat, readdir, realpath, statfs } from "node:fs/promises"
import path from "node:path"
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { LayerNode } from "../effect/layer-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { GraphVersionTable } from "../graph/sql"
import { Npm } from "../npm"
import { PermissionSaved } from "../permission/saved"
import { PermissionTable } from "../permission/sql"
import { ProjectV2 } from "../project"
import { ProjectDirectoryTable } from "../project/sql"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  TodoTable,
} from "../session/sql"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { ProductMigrationConfig } from "./config"
import { ProductMigrationFile } from "./file"
import { ProductMigrationGraph } from "./graph"
import { ProductMigrationPlanner } from "./planner"
import { ProductMigrationSession } from "./session"
import { ProductMigrationSnapshot } from "./snapshot"
import { ProductMigrationSource } from "./source"
import { ProductMigrationEntityTable, ProductMigrationItemTable, ProductMigrationTable } from "./sql"
import { ProductMigrationState } from "./state"
import { ProductMigrationSourceRoots } from "./roots"

const ID = "opencode-first-import"
const ERROR_LIMIT = 512

const SourceInput = Schema.Struct({
  data: Schema.String,
  config: Schema.String,
  state: Schema.String,
  database: Schema.String,
})
const ExpectedFile = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4_096)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const ExpectedInventory = Schema.Struct({
  configPaths: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(10_000)),
  configSources: Schema.Array(ExpectedFile).check(Schema.isMaxLength(10_000)),
  auth: Schema.NullOr(ExpectedFile),
  mcpAuth: Schema.NullOr(ExpectedFile),
  dependencies: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(256)),
      version: Schema.String.check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(10_000)),
  credentialIDs: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(10_000)),
})
const StoredPlan = Schema.Struct({
  ...ProductMigration.Plan.fields,
  databaseFingerprint: Schema.String,
  source: SourceInput,
  sourceSummary: ProductMigration.SourceSummary,
  expected: ExpectedInventory,
})
interface StoredPlan extends Schema.Schema.Type<typeof StoredPlan> {}

const StoredValidation = ProductMigration.Validation
const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(StoredPlan))
const decodeValidation = Schema.decodeUnknownOption(Schema.fromJsonString(StoredValidation))

export interface SourceInput {
  readonly data: string
  readonly config: string
  readonly state: string
  readonly database?: string
}

export interface DraftInput {
  readonly expectedRevision: number
  readonly categories: ReadonlyArray<{ readonly category: ProductMigration.Category; readonly selected: boolean }>
  readonly sessionsEnabled: boolean
  readonly sessions: ReadonlyArray<{
    readonly projectID: string
    readonly sessionID: string
    readonly selected: boolean
  }>
  readonly currentProject?: string
}

type MutationError =
  | ProductMigration.Required
  | ProductMigration.RevisionConflict
  | ProductMigration.InvalidTransition
  | ProductMigration.Finalized
  | ProductMigration.SourceError
  | ProductMigration.ValidationFailed
  | ProductMigration.Conflict
  | ProductMigration.InsufficientSpace
  | ProductMigration.ItemNotFound

export interface Interface {
  readonly get: () => Effect.Effect<ProductMigration.Projection, ProductMigration.SourceError>
  readonly discover: (input: {
    readonly expectedRevision: number
    readonly source?: string
    readonly currentProject?: string
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly updateDraft: (input: DraftInput) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly execute: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly pause: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly retry: (input: {
    readonly expectedRevision: number
    readonly itemID: string
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly skip: (input: {
    readonly expectedRevision: number
    readonly itemID: string
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly validate: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly finalize: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
  readonly freshStart: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<ProductMigration.Projection, MutationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const state = yield* ProductMigrationState.Service
    const source = yield* ProductMigrationSource.Service
    const config = yield* ProductMigrationConfig.Service
    const sessions = yield* ProductMigrationSession.Service
    const graph = yield* ProductMigrationGraph.Service
    const npm = yield* Npm.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const sourceRoots = yield* ProductMigrationSourceRoots.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const snapshotDirectory = path.join(global.data, "product-migration-snapshots")

    const get = Effect.fn("ProductMigration.get")(() =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const migration = yield* tx
              .select()
              .from(ProductMigrationTable)
              .where(eq(ProductMigrationTable.id, ID))
              .get()
              .pipe(Effect.orDie)
            if (!migration) return emptyProjection()
            const plan = decodeStoredPlan(migration.plan)
            const validation = decodeStoredValidation(migration.validation)
            if ((migration.plan !== null && !plan) || (migration.validation !== null && !validation)) {
              return yield* journalReadError()
            }
            const rows = yield* tx
              .select()
              .from(ProductMigrationItemTable)
              .where(eq(ProductMigrationItemTable.migration_id, ID))
              .all()
              .pipe(Effect.orDie)
            const items = rows
              .toSorted((left, right) => ProductMigrationSource.ordinal(left.item_id, right.item_id))
              .map(
                (item): ProductMigration.Item => ({
                  itemID: bounded(item.item_id, 256),
                  category: item.category,
                  sourceID: item.source_id ? bounded(item.source_id, 256) : null,
                  targetID: item.target_id ? bounded(item.target_id, 256) : null,
                  status: item.status,
                  selected: item.selected,
                  estimatedBytes: item.estimated_bytes,
                  error: item.error ? bounded(item.error, ERROR_LIMIT) : null,
                }),
              )
            return {
              status: migration.status,
              revision: migration.revision,
              source: plan?.sourceSummary ?? null,
              plan: plan ? publicPlan(plan) : null,
              items,
              validation: validation ?? null,
              completedItems: items.filter((item) => item.status === "completed" || item.status === "skipped").length,
              totalItems: items.length,
              canFinalize: migration.status === "ready_to_finalize" && validation?.valid === true,
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die)),
    )

    const discover = Effect.fn("ProductMigration.discover")(function* (input: {
      readonly expectedRevision: number
      readonly source?: string
      readonly currentProject?: string
    }) {
      return yield* locks.withLock(ID)(
        Effect.gen(function* () {
          yield* ensureDiscoverable(db, input.expectedRevision)
          const roots = yield* sourceRoots.resolve(input.source).pipe(
            Effect.mapError(
              () =>
                new ProductMigration.SourceError({
                  code: "invalid_root",
                  message: "Migration source is not allowed",
                }),
            ),
          )
          const discovery = yield* source.discover({ ...roots, snapshotDirectory }).pipe(Effect.mapError(sourceError))
          const planned = ProductMigrationPlanner.plan(discovery, { currentProject: input.currentProject })
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* ensureDiscoverable(tx, input.expectedRevision)
                const actualRevision = current?.revision ?? 0
                const revision = actualRevision + 1
                const stored = storedPlan({
                  ...planned,
                  revision,
                  source: { data: roots.data, config: roots.config, state: roots.state, database: discovery.database },
                  discovery,
                })
                yield* tx
                  .insert(ProductMigrationTable)
                  .values({
                    id: ID,
                    status: "draft",
                    source_path: discovery.database,
                    source_fingerprint: discovery.sourceFingerprint,
                    revision,
                    plan: JSON.stringify(stored),
                    validation: null,
                  })
                  .onConflictDoUpdate({
                    target: ProductMigrationTable.id,
                    set: {
                      status: "draft",
                      source_path: discovery.database,
                      source_fingerprint: discovery.sourceFingerprint,
                      revision,
                      plan: JSON.stringify(stored),
                      validation: null,
                    },
                  })
                  .run()
                  .pipe(Effect.orDie)
                yield* tx
                  .delete(ProductMigrationItemTable)
                  .where(eq(ProductMigrationItemTable.migration_id, ID))
                  .run()
                  .pipe(Effect.orDie)
                const items = planItems(stored)
                if (items.length > 0) yield* tx.insert(ProductMigrationItemTable).values(items).run().pipe(Effect.orDie)
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die))
          return yield* get()
        }),
      )
    })

    const updateDraft = Effect.fn("ProductMigration.updateDraft")(function* (input: DraftInput) {
      return yield* locks.withLock(ID)(
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* requiredRow(tx)
              yield* ensureMutable(current)
              yield* ensureRevision(current.revision, input.expectedRevision)
              if (current.status !== "draft" && current.status !== "ready_to_finalize") {
                return yield* new ProductMigration.Conflict({
                  message: "Migration selections cannot change after execution starts",
                })
              }
              const previous = yield* requirePlan(current.plan)
              const categories = new Map(input.categories.map((item) => [item.category, item.selected]))
              const selectedSessions = new Set(
                input.sessions.filter((item) => item.selected).map((item) => `${item.projectID}\0${item.sessionID}`),
              )
              const revision = current.revision + 1
              const next: StoredPlan = {
                ...previous,
                revision,
                categories: previous.categories.map((category) => ({
                  ...category,
                  selected: category.available && (categories.get(category.category) ?? category.selected),
                })),
                sessionsEnabled: input.sessionsEnabled,
                projects: previous.projects.map((project) => ({
                  ...project,
                  current: input.currentProject ? project.path === input.currentProject : project.current,
                  sessions: project.sessions.map((session) => ({
                    ...session,
                    selected: input.sessionsEnabled && selectedSessions.has(`${project.id}\0${session.id}`),
                  })),
                })),
              }
              const existing = yield* tx
                .select()
                .from(ProductMigrationItemTable)
                .where(eq(ProductMigrationItemTable.migration_id, ID))
                .all()
                .pipe(Effect.orDie)
              const desiredIDs = new Set(planItems({ ...next, requiredBytes: 0 }).map((item) => item.item_id))
              if (existing.some((item) => item.status === "completed" && !desiredIDs.has(item.item_id))) {
                return yield* new ProductMigration.Conflict({
                  message: "Completed migration items cannot be removed from the plan",
                })
              }
              const selectedBytes =
                next.categories
                  .filter((category) => category.selected)
                  .reduce((total, category) => total + category.estimatedBytes, 0) +
                (next.sessionsEnabled
                  ? next.projects
                      .flatMap((project) => project.sessions)
                      .filter((session) => session.selected)
                      .reduce((total, session) => total + session.estimatedBytes, 0)
                  : 0)
              const updated = { ...next, requiredBytes: selectedBytes }
              yield* tx
                .update(ProductMigrationTable)
                .set({ status: "draft", revision, plan: JSON.stringify(updated), validation: null })
                .where(eq(ProductMigrationTable.id, ID))
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .delete(ProductMigrationItemTable)
                .where(
                  and(eq(ProductMigrationItemTable.migration_id, ID), eq(ProductMigrationItemTable.status, "pending")),
                )
                .run()
                .pipe(Effect.orDie)
              yield* Effect.forEach(
                existing.filter((item) => item.status === "skipped" && desiredIDs.has(item.item_id)),
                (item) =>
                  tx
                    .update(ProductMigrationItemTable)
                    .set({ status: "pending", error: null })
                    .where(
                      and(
                        eq(ProductMigrationItemTable.migration_id, ID),
                        eq(ProductMigrationItemTable.item_id, item.item_id),
                      ),
                    )
                    .run()
                    .pipe(Effect.orDie),
                { discard: true },
              )
              const retainedIDs = new Set(
                existing.filter((item) => item.status !== "pending").map((item) => item.item_id),
              )
              const items = planItems(updated).filter((item) => !retainedIDs.has(item.item_id))
              if (items.length > 0) yield* tx.insert(ProductMigrationItemTable).values(items).run().pipe(Effect.orDie)
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die), Effect.andThen(get)),
      )
    })

    const execute = Effect.fn("ProductMigration.execute")(function* (input: { readonly expectedRevision: number }) {
      return yield* locks.withLock(ID)(
        Effect.gen(function* () {
          const current = yield* requiredMigration()
          yield* ensureMutable(current)
          yield* ensureRevision(current.revision, input.expectedRevision)
          const plan = yield* requirePlan(current.plan)
          const disk = yield* Effect.tryPromise({
            try: () => statfs(global.data),
            catch: () =>
              new ProductMigration.SourceError({
                code: "unreadable",
                message: "Available migration storage could not be inspected",
              }),
          })
          const availableBytes = disk.bavail * disk.bsize
          const requiredBytes = Math.min(Number.MAX_SAFE_INTEGER, plan.requiredBytes + plan.sourceSummary.databaseBytes)
          if (requiredBytes > availableBytes) {
            return yield* new ProductMigration.InsufficientSpace({
              requiredBytes,
              availableBytes,
            })
          }
          return yield* ProductMigrationSnapshot.use(
            { database: plan.source.database, directory: snapshotDirectory },
            (snapshot) =>
              Effect.gen(function* () {
                yield* verifySource(plan, snapshot)
                const started = yield* startExecution(current)
                const pending = yield* migrationItems(["pending"])
                const categoryItems = pending.filter(
                  (item) => item.category === "config" || item.category === "credentials" || item.category === "mcp",
                )
                yield* Effect.forEach(
                  categoryItems,
                  (item) =>
                    Effect.gen(function* () {
                      if (yield* executionStopped()) return
                      yield* setItems([item.item_id], "copying", null)
                      const category = item.category as "config" | "credentials" | "mcp"
                      const copied = yield* config
                        .migrate({
                          sourceConfig: plan.source.config,
                          sourceData: plan.source.data,
                          sourceDatabase: plan.source.database,
                          targetConfig: global.config,
                          targetData: global.data,
                          snapshotDirectory,
                          snapshot,
                          databaseFingerprint: plan.databaseFingerprint,
                          categories: [category],
                          expected: plan.expected,
                        })
                        .pipe(
                          Effect.andThen(verifySource(plan, snapshot)),
                          Effect.andThen(
                            category === "config"
                              ? npm.install(global.config, {
                                  add: plan.expected.dependencies.map((item) => ({ ...item })),
                                })
                              : Effect.void,
                          ),
                          Effect.andThen(verifySource(plan, snapshot)),
                          Effect.map(() => ({ success: true as const })),
                          Effect.catch((error) => Effect.succeed({ success: false as const, error })),
                        )
                      if (copied.success) {
                        yield* setItems([item.item_id], "completed", null)
                        return
                      }
                      yield* setItems([item.item_id], "failed", `${category} migration failed`)
                      yield* failMigration(started.revision)
                      if (copied.error instanceof ProductMigration.SourceError) return yield* copied.error
                      if (copied.error instanceof ProductMigrationConfig.SourceChanged) {
                        return yield* new ProductMigration.SourceError({
                          code: "changed",
                          message: "OpenCode credential source changed after migration planning",
                        })
                      }
                      if (copied.error instanceof ProductMigrationConfig.TargetConflict) {
                        return yield* new ProductMigration.Conflict({
                          itemID: item.item_id,
                          message: "Target configuration conflicts with the plan",
                        })
                      }
                    }),
                  { concurrency: 1, discard: true },
                )

                const sessionItems = pending.filter((item) => item.category === "session")
                const selectionInventory = plan.projects.flatMap((project) =>
                  project.sessions.flatMap((session) =>
                    session.selected ? [{ projectID: project.id, sessionID: session.id }] : [],
                  ),
                )
                yield* Effect.forEach(
                  sessionItems,
                  (item) =>
                    Effect.gen(function* () {
                      if (yield* executionStopped()) return
                      const selection = plan.projects
                        .flatMap((project) =>
                          project.sessions.map((session) => ({ projectID: project.id, sessionID: session.id })),
                        )
                        .find((candidate) => candidate.sessionID === item.source_id)
                      if (!selection) {
                        yield* setItems([item.item_id], "failed", "Session selection is invalid")
                        yield* failMigration(started.revision)
                        return
                      }
                      yield* setItems([item.item_id], "copying", null)
                      const copied = yield* sessions
                        .import({
                          migrationID: ID,
                          sourceDatabase: plan.source.database,
                          sourceData: plan.source.data,
                          targetData: global.data,
                          snapshotDirectory,
                          snapshot,
                          selections: [selection],
                          selectionInventory,
                          sourceFingerprint: plan.sourceFingerprint,
                          databaseFingerprint: plan.databaseFingerprint,
                        })
                        .pipe(
                          Effect.flatMap((result) =>
                            graph
                              .import({
                                migrationID: ID,
                                sourceDatabase: plan.source.database,
                                snapshotDirectory,
                                snapshot,
                                sourceSessionIDs: [selection.sessionID],
                               sourceFingerprint: plan.sourceFingerprint,
                               databaseFingerprint: plan.databaseFingerprint,
                             })
                             .pipe(
                                Effect.andThen(
                                  graph.queueEnhancement({ migrationID: ID, sourceSessionID: selection.sessionID }),
                                ),
                                Effect.tapError(() =>
                                  sessions
                                    .cleanup({
                                      migrationID: ID,
                                      sourceSessionID: selection.sessionID,
                                      targetData: global.data,
                                    })
                                    .pipe(Effect.ignore),
                                ),
                                Effect.as(result.sessions[0]?.targetID ?? null),
                              ),
                          ),
                          Effect.andThen((targetID) => verifySource(plan, snapshot).pipe(Effect.as(targetID))),
                          Effect.map((targetID) => ({ success: true as const, targetID })),
                          Effect.catch((error) => Effect.succeed({ success: false as const, error })),
                        )
                      if (copied.success) {
                        yield* completeSessionItem(item.item_id, copied.targetID)
                        return
                      }
                      yield* setItems([item.item_id], "failed", "Session migration failed")
                      yield* failMigration(started.revision)
                      if (copied.error instanceof ProductMigration.SourceError) return yield* copied.error
                    }),
                  { concurrency: 1, discard: true },
                )
                yield* verifySource(plan, snapshot)
                return yield* get()
              }),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof ProductMigrationSnapshot.SnapshotError
                ? new ProductMigration.SourceError({
                    code: error.reason === "changed" ? "changed" : "unreadable",
                    message:
                      error.reason === "changed"
                        ? "OpenCode source changed during migration"
                        : "OpenCode source snapshot could not be read",
                  })
                : error,
            ),
          )
        }),
      )
    })

    const pause = Effect.fn("ProductMigration.pause")(function* (input: { readonly expectedRevision: number }) {
      const current = yield* requiredMigration()
      yield* ensureMutable(current)
      yield* state.pause(input)
      return yield* get()
    })

    const retryOrSkip = Effect.fnUntraced(function* (
      input: { readonly expectedRevision: number; readonly itemID: string },
      status: "pending" | "skipped",
    ) {
      return yield* locks.withLock(ID)(
        Effect.gen(function* () {
          if (status === "skipped") {
            const prepared = yield* db.transaction((tx) => requireFailedItem(tx, input))
            if (prepared.item.category === "session" && prepared.item.source_id) {
              yield* sessions
                .cleanup({
                  migrationID: ID,
                  sourceSessionID: prepared.item.source_id,
                  targetData: global.data,
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new ProductMigration.Conflict({
                        itemID: bounded(input.itemID, 256),
                        message: "Failed to clean the skipped session import",
                      }),
                  ),
                )
            }
          }
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const prepared = yield* requireFailedItem(tx, input)
              const current = prepared.current
              const item = prepared.item
              const revision = current.revision + 1
              const plan = status === "skipped" ? yield* requirePlan(current.plan) : undefined
              const selected = plan
                ? {
                    ...plan,
                    revision,
                    categories: plan.categories.map((category) => ({
                      ...category,
                      selected: item.category === category.category ? false : category.selected,
                    })),
                    projects: plan.projects.map((project) => ({
                      ...project,
                      sessions: project.sessions.map((session) => ({
                        ...session,
                        selected:
                          item.category === "session" && session.id === item.source_id ? false : session.selected,
                      })),
                    })),
                  }
                : undefined
              const updatedPlan = selected
                ? {
                    ...selected,
                    requiredBytes:
                      selected.categories
                        .filter((category) => category.selected)
                        .reduce((total, category) => total + category.estimatedBytes, 0) +
                      (selected.sessionsEnabled
                        ? selected.projects
                            .flatMap((project) => project.sessions)
                            .filter((session) => session.selected)
                            .reduce((total, session) => total + session.estimatedBytes, 0)
                        : 0),
                  }
                : undefined
              yield* tx
                .update(ProductMigrationItemTable)
                .set({ status, error: null })
                .where(
                  and(
                    eq(ProductMigrationItemTable.migration_id, ID),
                    eq(ProductMigrationItemTable.item_id, input.itemID),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .update(ProductMigrationTable)
                .set({
                  status: "paused",
                  revision,
                  validation: null,
                  ...(updatedPlan ? { plan: JSON.stringify(updatedPlan) } : {}),
                })
                .where(eq(ProductMigrationTable.id, ID))
                .run()
                .pipe(Effect.orDie)
            }),
          )
        }).pipe(Effect.catchTag("SqlError", Effect.die), Effect.andThen(get)),
      )
    })

    const validate = Effect.fn("ProductMigration.validate")(function* (input: { readonly expectedRevision: number }) {
      return yield* locks.withLock(ID)(
        Effect.gen(function* () {
          const validating = yield* state.validate(input)
          const current = yield* requiredMigration()
          const plan = yield* requirePlan(current.plan)
          return yield* ProductMigrationSnapshot.use(
            { database: plan.source.database, directory: snapshotDirectory },
            (snapshot) =>
              Effect.gen(function* () {
                const discovered = yield* source.discover({ ...plan.source, snapshotDirectory, snapshot }).pipe(
                  Effect.mapError(sourceError),
                  Effect.tapError(() => failMigration(validating.revision)),
                )
                const items = yield* migrationItems(["pending", "copying", "failed"])
                const importedSessions = (yield* migrationItems(["completed"]))
                  .filter((item) => item.category === "session" && item.target_id !== null)
                  .map((item) => ({ sourceID: item.source_id, targetID: SessionSchema.ID.make(item.target_id!) }))
                const targetSessionIDs = importedSessions.map((item) => item.targetID)
                const targetSessions =
                  targetSessionIDs.length === 0
                    ? []
                    : (yield* Effect.forEach(chunked(targetSessionIDs), (sessionIDs) =>
                        db
                          .select({
                            id: SessionTable.id,
                            projectID: SessionTable.project_id,
                            workspaceID: SessionTable.workspace_id,
                            metadata: SessionTable.metadata,
                          })
                          .from(SessionTable)
                          .where(inArray(SessionTable.id, sessionIDs))
                          .all()
                          .pipe(Effect.orDie),
                      )).flat()
                const sessionsByID = new Map(targetSessions.map((session) => [session.id, session]))
                const relationshipClosures = targetSessions.flatMap((session) => {
                  const marker = migrationMarker(session.metadata)
                  const closure = marker ? markerClosure(marker) : undefined
                  return closure ? [{ sessionID: session.id, closure }] : []
                })
                const relationshipGroups = [
                  {
                    type: "project",
                    sourceIDs: [...new Set(relationshipClosures.map((item) => item.closure.projectID))],
                  },
                  {
                    type: "workspace",
                    sourceIDs: [
                      ...new Set(
                        relationshipClosures.flatMap((item) =>
                          item.closure.workspaceID === null ? [] : [item.closure.workspaceID],
                        ),
                      ),
                    ],
                  },
                  {
                    type: "permission",
                    sourceIDs: [...new Set(relationshipClosures.flatMap((item) => item.closure.permissionIDs))],
                  },
                ] as const
                const relationshipMappings = new Map(
                  (yield* Effect.forEach(relationshipGroups, (group) =>
                    Effect.forEach(chunked(group.sourceIDs), (sourceIDs) =>
                      db
                        .select({
                          sourceID: ProductMigrationEntityTable.source_id,
                          sourceFingerprint: ProductMigrationEntityTable.source_fingerprint,
                          targetID: ProductMigrationEntityTable.target_id,
                        })
                        .from(ProductMigrationEntityTable)
                        .where(
                          and(
                            eq(ProductMigrationEntityTable.migration_id, ID),
                            eq(ProductMigrationEntityTable.entity_type, group.type),
                            inArray(ProductMigrationEntityTable.source_id, sourceIDs),
                          ),
                        )
                        .all()
                        .pipe(
                          Effect.orDie,
                          Effect.map((rows) => rows.map((row) => ({ ...row, type: group.type }))),
                        ),
                    ).pipe(Effect.map((groups) => groups.flat())),
                  ))
                    .flat()
                    .filter((row) => row.sourceFingerprint === plan.sourceFingerprint)
                    .map((row) => [`${row.type}\0${row.sourceID}`, row.targetID] as const),
                )
                const targetProjectIDs = [
                  ...new Set(
                    relationshipGroups[0].sourceIDs.flatMap((sourceID) => {
                      const targetID = relationshipMappings.get(`project\0${sourceID}`)
                      const decoded = targetID ? Schema.decodeUnknownOption(ProjectV2.ID)(targetID) : Option.none()
                      return Option.isSome(decoded) ? [decoded.value] : []
                    }),
                  ),
                ]
                const targetWorkspaceIDs = [
                  ...new Set(
                    relationshipGroups[1].sourceIDs.flatMap((sourceID) => {
                      const targetID = relationshipMappings.get(`workspace\0${sourceID}`)
                      const decoded = targetID ? Schema.decodeUnknownOption(WorkspaceV2.ID)(targetID) : Option.none()
                      return Option.isSome(decoded) ? [decoded.value] : []
                    }),
                  ),
                ]
                const targetPermissionIDs = [
                  ...new Set(
                    relationshipGroups[2].sourceIDs.flatMap((sourceID) => {
                      const targetID = relationshipMappings.get(`permission\0${sourceID}`)
                      const decoded = targetID
                        ? Schema.decodeUnknownOption(PermissionSaved.ID)(targetID)
                        : Option.none()
                      return Option.isSome(decoded) ? [decoded.value] : []
                    }),
                  ),
                ]
                const projectDirectories = (yield* Effect.forEach(chunked(targetProjectIDs), (projectIDs) =>
                  db
                    .select({ projectID: ProjectDirectoryTable.project_id, directory: ProjectDirectoryTable.directory })
                    .from(ProjectDirectoryTable)
                    .where(inArray(ProjectDirectoryTable.project_id, projectIDs))
                    .all()
                    .pipe(Effect.orDie),
                )).flat()
                const workspaces = (yield* Effect.forEach(chunked(targetWorkspaceIDs), (workspaceIDs) =>
                  db
                    .select({ id: WorkspaceTable.id, projectID: WorkspaceTable.project_id })
                    .from(WorkspaceTable)
                    .where(inArray(WorkspaceTable.id, workspaceIDs))
                    .all()
                    .pipe(Effect.orDie),
                )).flat()
                const permissions = (yield* Effect.forEach(chunked(targetPermissionIDs), (permissionIDs) =>
                  db
                    .select({ id: PermissionTable.id, projectID: PermissionTable.project_id })
                    .from(PermissionTable)
                    .where(inArray(PermissionTable.id, permissionIDs))
                    .all()
                    .pipe(Effect.orDie),
                )).flat()
                const projectDirectoryIDs = new Set(
                  projectDirectories.map((item) => `${item.projectID}\0${item.directory}`),
                )
                const workspacesByID = new Map(workspaces.map((item) => [String(item.id), item]))
                const permissionsByID = new Map(permissions.map((item) => [String(item.id), item]))
                const closureRows =
                  targetSessionIDs.length === 0
                    ? []
                    : (yield* Effect.forEach(chunked(targetSessionIDs), (sessionIDs) =>
                        Effect.all([
                          db
                            .select({ sessionID: MessageTable.session_id, count: count() })
                            .from(MessageTable)
                            .where(inArray(MessageTable.session_id, sessionIDs))
                            .groupBy(MessageTable.session_id)
                            .all()
                            .pipe(
                              Effect.orDie,
                              Effect.map((rows) => rows.map((row) => ({ ...row, family: "legacyMessages" as const }))),
                            ),
                          db
                            .select({ sessionID: PartTable.session_id, count: count() })
                            .from(PartTable)
                            .where(inArray(PartTable.session_id, sessionIDs))
                            .groupBy(PartTable.session_id)
                            .all()
                            .pipe(
                              Effect.orDie,
                              Effect.map((rows) => rows.map((row) => ({ ...row, family: "parts" as const }))),
                            ),
                          db
                            .select({ sessionID: SessionMessageTable.session_id, count: count() })
                            .from(SessionMessageTable)
                            .where(inArray(SessionMessageTable.session_id, sessionIDs))
                            .groupBy(SessionMessageTable.session_id)
                            .all()
                            .pipe(
                              Effect.orDie,
                              Effect.map((rows) => rows.map((row) => ({ ...row, family: "currentMessages" as const }))),
                            ),
                          db
                            .select({ sessionID: SessionInputTable.session_id, count: count() })
                            .from(SessionInputTable)
                            .where(inArray(SessionInputTable.session_id, sessionIDs))
                            .groupBy(SessionInputTable.session_id)
                            .all()
                            .pipe(
                              Effect.orDie,
                              Effect.map((rows) => rows.map((row) => ({ ...row, family: "inputs" as const }))),
                            ),
                          db
                            .select({ sessionID: TodoTable.session_id, count: count() })
                            .from(TodoTable)
                            .where(inArray(TodoTable.session_id, sessionIDs))
                            .groupBy(TodoTable.session_id)
                            .all()
                            .pipe(
                              Effect.orDie,
                              Effect.map((rows) => rows.map((row) => ({ ...row, family: "todos" as const }))),
                            ),
                        ]).pipe(Effect.map((groups) => groups.flat())),
                      )).flat()
                const closureCounts = new Map(
                  closureRows.map((row) => [`${row.sessionID}\0${row.family}`, row.count] as const),
                )
                const pendingInputs =
                  targetSessionIDs.length === 0
                    ? []
                    : (yield* Effect.forEach(chunked(targetSessionIDs), (sessionIDs) =>
                        db
                          .select({ sessionID: SessionInputTable.session_id })
                          .from(SessionInputTable)
                          .where(
                            and(
                              inArray(SessionInputTable.session_id, sessionIDs),
                              isNull(SessionInputTable.promoted_seq),
                            ),
                          )
                          .all()
                          .pipe(Effect.orDie),
                      )).flat()
                const graphVersions =
                  targetSessionIDs.length === 0
                    ? []
                    : (yield* Effect.forEach(chunked(targetSessionIDs), (sessionIDs) =>
                        db
                          .select({ sessionID: GraphVersionTable.session_id })
                          .from(GraphVersionTable)
                          .where(inArray(GraphVersionTable.session_id, sessionIDs))
                          .all()
                          .pipe(Effect.orDie),
                      )).flat()
                const graphSessionIDs = new Set(
                  graphVersions.flatMap((version) => (version.sessionID ? [version.sessionID] : [])),
                )
                const sessionIssues: ProductMigration.ValidationIssue[] = importedSessions.flatMap((item) => {
                  const session = sessionsByID.get(item.targetID)
                  const marker = session ? migrationMarker(session.metadata) : undefined
                  const closure = marker ? markerClosure(marker) : undefined
                  const inventory = marker ? markerCopiedFiles(marker) : undefined
                  const projectID = closure ? relationshipMappings.get(`project\0${closure.projectID}`) : undefined
                  const workspaceID =
                    closure?.workspaceID === null || closure === undefined
                      ? undefined
                      : relationshipMappings.get(`workspace\0${closure.workspaceID}`)
                  const permissionIDs = closure?.permissionIDs.map((sourceID) =>
                    relationshipMappings.get(`permission\0${sourceID}`),
                  )
                  return [
                    ...(!session
                      ? [{ code: "session_missing", message: "A migrated session is missing" }]
                      : !isMigrationSession(session.metadata, item.sourceID)
                        ? [{ code: "session_marker_invalid", message: "A migrated session marker is invalid" }]
                        : []),
                    ...(session && !closure
                      ? [{ code: "session_closure_invalid", message: "A migrated session closure is invalid" }]
                      : closure
                        ? (
                            [
                              ["legacyMessages", "session_legacy_message_count", "legacy message"],
                              ["parts", "session_part_count", "part"],
                              ["currentMessages", "session_current_message_count", "current message"],
                              ["inputs", "session_input_count", "input"],
                              ["todos", "session_todo_count", "todo"],
                            ] as const
                          ).flatMap(([family, code, label]) =>
                            (closureCounts.get(`${item.targetID}\0${family}`) ?? 0) === closure[family]
                              ? []
                              : [
                                  {
                                    code,
                                    message: `A migrated session ${label} count does not match its source closure`,
                                  },
                                ],
                          )
                        : []),
                    ...(session && closure && (!projectID || session.projectID !== projectID)
                      ? [{ code: "session_project_missing", message: "A migrated session project mapping is missing" }]
                      : []),
                    ...(session && closure && projectID
                      ? closure.projectDirectories.every((directory) =>
                          projectDirectoryIDs.has(`${projectID}\0${directory}`),
                        )
                        ? []
                        : [
                            {
                              code: "session_project_directory_count",
                              message: "A migrated session project-directory closure is incomplete",
                            },
                          ]
                      : []),
                    ...(session && closure
                      ? closure.workspaceID === null
                        ? session.workspaceID === null
                          ? []
                          : [
                              {
                                code: "session_workspace_missing",
                                message: "A migrated session workspace is unexpected",
                              },
                            ]
                        : workspaceID &&
                            session.workspaceID === workspaceID &&
                            workspacesByID.get(workspaceID)?.projectID === projectID
                          ? []
                          : [{ code: "session_workspace_missing", message: "A migrated session workspace is missing" }]
                      : []),
                    ...(session && closure
                      ? permissionIDs?.every(
                          (permissionID) =>
                            permissionID !== undefined && permissionsByID.get(permissionID)?.projectID === projectID,
                        )
                        ? []
                        : [
                            {
                              code: "session_permission_count",
                              message: "A migrated session permission closure is incomplete",
                            },
                          ]
                      : []),
                    ...(session && !inventory
                      ? [
                          {
                            code: "copied_file_inventory",
                            message: "A migrated session copied-file inventory is invalid",
                          },
                        ]
                      : []),
                    ...(pendingInputs.some((input) => input.sessionID === item.targetID)
                      ? [{ code: "session_input_pending", message: "A migrated session has pending input" }]
                      : []),
                    ...(!graphSessionIDs.has(item.targetID)
                      ? [{ code: "graph_missing", message: "A migrated session has no Graph version" }]
                      : []),
                  ]
                })
                const foreignKeyIssues = (yield* db
                  .all<Record<string, unknown>>("PRAGMA foreign_key_check")
                  .pipe(Effect.orDie)).length
                  ? [{ code: "foreign_key_violation", message: "Migrated records violate database references" }]
                  : []
                const copiedFileIssues = (yield* fs.existsSafe(path.join(global.data, "product-migration")))
                  ? yield* validateCopiedFiles(global.data)
                  : []
                const expectedCopiedFileIssues = yield* validateExpectedCopiedFiles(
                  global.data,
                  targetSessions.flatMap((session) => markerCopiedFiles(migrationMarker(session.metadata)) ?? []),
                )
                const artifactIssues = yield* config.validate({
                  sourceDatabase: discovered.database,
                  targetConfig: global.config,
                  targetData: global.data,
                  expected: plan.expected,
                  categories: plan.categories
                    .filter(
                      (
                        category,
                      ): category is typeof category & {
                        category: "config" | "credentials" | "mcp"
                      } =>
                        category.selected &&
                        (category.category === "config" ||
                          category.category === "credentials" ||
                          category.category === "mcp"),
                    )
                    .map((category) => category.category),
                })
                yield* verifySource(plan, snapshot).pipe(Effect.tapError(() => failMigration(validating.revision)))
                const issues: ProductMigration.ValidationIssue[] = [
                  ...(discovered.sourceFingerprint !== plan.sourceFingerprint
                    ? [{ code: "source_changed", message: "The OpenCode source changed after planning" }]
                    : []),
                  ...items.slice(0, 31).map((item) => ({
                    code: "item_incomplete",
                    message: `Migration item ${bounded(item.item_id, 256)} is ${item.status}`,
                  })),
                  ...sessionIssues,
                  ...foreignKeyIssues,
                  ...copiedFileIssues,
                  ...expectedCopiedFileIssues,
                  ...artifactIssues,
                ]
                const validation = { valid: issues.length === 0, issues: issues.slice(0, 32) }
                yield* db
                  .update(ProductMigrationTable)
                  .set({ validation: JSON.stringify(validation) })
                  .where(eq(ProductMigrationTable.id, ID))
                  .run()
                  .pipe(Effect.orDie)
                if (!validation.valid) {
                  yield* failMigration(validating.revision)
                  return yield* new ProductMigration.ValidationFailed({ issues: validation.issues })
                }
                yield* state.validationSucceeded({ expectedRevision: validating.revision })
                return yield* get()
              }),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof ProductMigrationSnapshot.SnapshotError
                ? new ProductMigration.SourceError({
                    code: error.reason === "changed" ? "changed" : "unreadable",
                    message:
                      error.reason === "changed"
                        ? "OpenCode source changed during validation"
                        : "OpenCode source snapshot could not be read",
                  })
                : error,
            ),
          )
        }),
      )
    })

    const finalize = Effect.fn("ProductMigration.finalize")(function* (input: { readonly expectedRevision: number }) {
      return yield* locks.withLock(ID)(
        Effect.gen(function* () {
          const current = yield* requiredMigration()
          yield* ensureMutable(current)
          yield* ensureRevision(current.revision, input.expectedRevision)
          const validation = decodeStoredValidation(current.validation)
          if (!validation?.valid) {
            return yield* new ProductMigration.ValidationFailed({
              issues: [{ code: "validation_required", message: "Migration must pass validation before finalization" }],
            })
          }
          yield* state.finalize(input)
          return yield* get()
        }),
      )
    })

    const freshStart = Effect.fn("ProductMigration.freshStart")(function* (input: {
      readonly expectedRevision: number
    }) {
      return yield* locks.withLock(ID)(state.freshStart(input).pipe(Effect.andThen(get)))
    })

    function requiredMigration() {
      return requiredRow(db)
    }

    function requireFailedItem(
      query: Pick<Database.Interface["db"], "select">,
      input: { readonly expectedRevision: number; readonly itemID: string },
    ) {
      return Effect.gen(function* () {
        const current = yield* requiredRow(query)
        yield* ensureMutable(current)
        yield* ensureRevision(current.revision, input.expectedRevision)
        if (current.status !== "failed" && current.status !== "paused") {
          return yield* new ProductMigration.InvalidTransition({ status: current.status, target: "paused" })
        }
        const item = yield* query
          .select()
          .from(ProductMigrationItemTable)
          .where(
            and(eq(ProductMigrationItemTable.migration_id, ID), eq(ProductMigrationItemTable.item_id, input.itemID)),
          )
          .get()
          .pipe(Effect.orDie)
        if (!item) return yield* new ProductMigration.ItemNotFound({ itemID: bounded(input.itemID, 256) })
        if (item.status !== "failed") {
          return yield* new ProductMigration.Conflict({
            itemID: bounded(input.itemID, 256),
            message: "Only failed migration items can be retried or skipped",
          })
        }
        return { current, item }
      })
    }

    function ensureDiscoverable(query: Pick<Database.Interface["db"], "get" | "select">, expectedRevision: number) {
      return Effect.gen(function* () {
        const current = yield* query
          .select()
          .from(ProductMigrationTable)
          .where(eq(ProductMigrationTable.id, ID))
          .get()
          .pipe(Effect.orDie)
        yield* ensureRevision(current?.revision ?? 0, expectedRevision)
        if (!current) return undefined
        if (current.status === "completed") return yield* new ProductMigration.Finalized()
        if (current.status !== "draft") {
          if (current.status === "copying" || current.status === "validating") {
            return yield* new ProductMigration.InvalidTransition({ status: current.status, target: "draft" })
          }
          return yield* new ProductMigration.Conflict({
            message: "Migration discovery cannot replace a plan after execution starts",
          })
        }
        const started = yield* query
          .get<{ count: number }>(
            sql`
            SELECT COUNT(*) AS count FROM product_migration_item
            WHERE migration_id = ${ID} AND status <> 'pending'
          `,
          )
          .pipe(Effect.orDie)
        const mappings = yield* query
          .get<{ count: number }>(
            sql`
            SELECT COUNT(*) AS count FROM product_migration_entity WHERE migration_id = ${ID}
          `,
          )
          .pipe(Effect.orDie)
        if ((started?.count ?? 0) > 0 || (mappings?.count ?? 0) > 0) {
          return yield* new ProductMigration.Conflict({
            message: "Migration discovery cannot replace durable migration work",
          })
        }
        return current
      })
    }

    function migrationItems(statuses: ProductMigration.ItemStatus[]) {
      return db
        .select()
        .from(ProductMigrationItemTable)
        .where(eq(ProductMigrationItemTable.migration_id, ID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((items) => items.filter((item) => statuses.includes(item.status))),
        )
    }

    function setItems(itemIDs: string[], status: ProductMigration.ItemStatus, error: string | null) {
      return Effect.forEach(
        itemIDs,
        (itemID) =>
          db
            .update(ProductMigrationItemTable)
            .set({ status, error: error ? bounded(error, ERROR_LIMIT) : null })
            .where(and(eq(ProductMigrationItemTable.migration_id, ID), eq(ProductMigrationItemTable.item_id, itemID)))
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )
    }

    function completeSessionItem(itemID: string, targetID: string | null) {
      return db
        .update(ProductMigrationItemTable)
        .set({ status: "completed", target_id: targetID, error: null })
        .where(and(eq(ProductMigrationItemTable.migration_id, ID), eq(ProductMigrationItemTable.item_id, itemID)))
        .run()
        .pipe(Effect.orDie)
    }

    function failMigration(expectedRevision: number) {
      return db
        .update(ProductMigrationTable)
        .set({ status: "failed", revision: expectedRevision + 1 })
        .where(and(eq(ProductMigrationTable.id, ID), eq(ProductMigrationTable.revision, expectedRevision)))
        .run()
        .pipe(Effect.orDie)
    }

    function startExecution(current: typeof ProductMigrationTable.$inferSelect) {
      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* requiredRow(tx)
            yield* ensureMutable(row)
            yield* ensureRevision(row.revision, current.revision)
            if (!["draft", "paused", "failed", "copying"].includes(row.status)) {
              return yield* new ProductMigration.InvalidTransition({ status: row.status, target: "copying" })
            }
            yield* tx
              .update(ProductMigrationItemTable)
              .set({ status: "pending" })
              .where(
                and(eq(ProductMigrationItemTable.migration_id, ID), eq(ProductMigrationItemTable.status, "copying")),
              )
              .run()
              .pipe(Effect.orDie)
            const next = yield* tx
              .update(ProductMigrationTable)
              .set({ status: "copying", revision: row.revision + 1, validation: null })
              .where(eq(ProductMigrationTable.id, ID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            return {
              id: next.id,
              status: next.status,
              sourcePath: next.source_path,
              sourceFingerprint: next.source_fingerprint,
              revision: next.revision,
              finalizedAt: next.finalized_at,
              timeCreated: next.time_created,
              timeUpdated: next.time_updated,
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    }

    function executionStopped() {
      return db
        .select({ status: ProductMigrationTable.status })
        .from(ProductMigrationTable)
        .where(eq(ProductMigrationTable.id, ID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.status !== "copying"),
        )
    }

    function verifySource(plan: StoredPlan, snapshot?: ProductMigrationSnapshot.Snapshot) {
      return source.discover({ ...plan.source, snapshotDirectory, snapshot }).pipe(
        Effect.mapError(sourceError),
        Effect.flatMap((discovery) => {
          if (discovery.sourceFingerprint === plan.sourceFingerprint) return Effect.succeed(discovery)
          return Effect.fail(
            new ProductMigration.SourceError({
              code: "changed",
              message: "OpenCode source changed after migration planning",
            }),
          )
        }),
      )
    }

    return Service.of({
      get,
      discover,
      updateDraft,
      execute,
      pause,
      retry: (input) => retryOrSkip(input, "pending"),
      skip: (input) => retryOrSkip(input, "skipped"),
      validate,
      finalize,
      freshStart,
    })
  }),
)

function emptyProjection(): ProductMigration.Projection {
  return {
    status: "undiscovered",
    revision: 0,
    source: null,
    plan: null,
    items: [],
    validation: null,
    completedItems: 0,
    totalItems: 0,
    canFinalize: false,
  }
}

function storedPlan(input: {
  readonly revision: number
  readonly sourceFingerprint: string
  readonly categories: ReadonlyArray<{
    readonly category: ProductMigration.Category
    readonly selected: boolean
    readonly estimatedBytes: number
  }>
  readonly sessionsEnabled: boolean
  readonly projects: ReturnType<typeof ProductMigrationPlanner.plan>["projects"]
  readonly source: typeof SourceInput.Type
  readonly discovery: ProductMigrationSource.Discovery
}): StoredPlan {
  const projects = input.projects.slice(0, 1_000).map((project) => ({
    ...project,
    id: bounded(project.id, 256),
    path: bounded(project.path, 4_096),
    sessions: project.sessions.slice(0, 2_000).map((session) => ({
      ...session,
      id: bounded(session.id, 256),
      title: bounded(session.title, 256),
    })),
  }))
  return {
    revision: input.revision,
    sourceFingerprint: bounded(input.sourceFingerprint, 256),
    databaseFingerprint: input.discovery.databaseFingerprint,
    categories: input.discovery.categories.map((category) => ({
      category: category.category,
      available: category.available,
      selected: input.categories.find((item) => item.category === category.category)?.selected ?? false,
      estimatedBytes: category.estimatedBytes,
    })),
    sessionsEnabled: input.sessionsEnabled,
    projects,
    requiredBytes: input.discovery.categories
      .filter((category) => input.categories.find((item) => item.category === category.category)?.selected)
      .reduce((total, category) => total + category.estimatedBytes, 0),
    source: input.source,
    sourceSummary: {
      database: bounded(input.discovery.database, 4_096),
      databaseBytes: input.discovery.databaseBytes,
      mixedGraph: input.discovery.mixedGraph,
      sessionCount: input.discovery.sessionCount,
    },
    expected: {
      configPaths: input.discovery.expected.configPaths.slice(0, 10_000).map((item) => bounded(item, 4_096)),
      configSources: input.discovery.expected.configSources.slice(0, 10_000).map((item) => ({
        path: item.path,
        sha256: item.sha256,
      })),
      auth: input.discovery.expected.auth,
      mcpAuth: input.discovery.expected.mcpAuth,
      dependencies: input.discovery.expected.dependencies.slice(0, 10_000).map((item) => ({
        name: item.name,
        version: item.version,
      })),
      credentialIDs: input.discovery.expected.credentialIDs.slice(0, 10_000).map((item) => bounded(item, 256)),
    },
  }
}

function publicPlan(plan: StoredPlan): ProductMigration.Plan {
  return {
    revision: plan.revision,
    sourceFingerprint: plan.sourceFingerprint,
    categories: plan.categories,
    sessionsEnabled: plan.sessionsEnabled,
    projects: plan.projects,
    requiredBytes: plan.requiredBytes,
  }
}

function planItems(plan: StoredPlan): Array<typeof ProductMigrationItemTable.$inferInsert> {
  const categories = plan.categories
    .filter((category) => category.available && category.selected)
    .map((category) => ({
      migration_id: ID,
      item_id: `category:${category.category}`,
      category: category.category,
      selected: true,
      estimated_bytes: category.estimatedBytes,
      source_fingerprint: plan.sourceFingerprint,
    }))
  const sessions = plan.sessionsEnabled
    ? plan.projects.flatMap((project) =>
        project.sessions
          .filter((session) => session.selected)
          .map((session) => ({
            migration_id: ID,
            item_id: `session:${session.id}`,
            category: "session" as const,
            source_id: session.id,
            selected: true,
            estimated_bytes: session.estimatedBytes,
            source_fingerprint: plan.sourceFingerprint,
          })),
      )
    : []
  return [...categories, ...sessions]
}

function decodeStoredPlan(value: string | null) {
  if (!value) return undefined
  return Option.getOrUndefined(decodePlan(value))
}

function requirePlan(value: string | null) {
  const plan = decodeStoredPlan(value)
  return plan ? Effect.succeed(plan) : journalReadError()
}

function journalReadError() {
  return Effect.fail(
    new ProductMigration.SourceError({ code: "unreadable", message: "The product migration journal is corrupt" }),
  )
}

function decodeStoredValidation(value: string | null) {
  if (!value) return undefined
  return Option.getOrUndefined(decodeValidation(value))
}

function sourceError(error: ProductMigrationSource.SourceNotFound | ProductMigrationSource.SourceReadError) {
  if (error instanceof ProductMigrationSource.SourceNotFound) {
    return new ProductMigration.SourceError({ code: "not_found", message: "OpenCode source was not found" })
  }
  const detail = error.cause instanceof Error ? error.cause.message.toLowerCase() : ""
  const code = detail.includes("unsupported") ? "unsupported" : detail.includes("changed") ? "changed" : "unreadable"
  return new ProductMigration.SourceError({
    code,
    message:
      code === "unsupported"
        ? "OpenCode source schema is unsupported"
        : code === "changed"
          ? "OpenCode source changed while it was being read"
          : "OpenCode source could not be read",
  })
}

function ensureRevision(actualRevision: number, expectedRevision: number) {
  if (actualRevision !== expectedRevision) {
    return Effect.fail(new ProductMigration.RevisionConflict({ expectedRevision, actualRevision }))
  }
  return Effect.void
}

function ensureMutable(row: typeof ProductMigrationTable.$inferSelect) {
  if (row.status === "completed") return Effect.fail(new ProductMigration.Finalized())
  return Effect.void
}

function requiredRow(db: Pick<Database.Interface["db"], "select">) {
  return db
    .select()
    .from(ProductMigrationTable)
    .where(eq(ProductMigrationTable.id, ID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new ProductMigration.Required()))),
    )
}

function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`
}

function chunked<A>(items: ReadonlyArray<A>) {
  return Array.from({ length: Math.ceil(items.length / 500) }, (_, index) =>
    items.slice(index * 500, (index + 1) * 500),
  )
}

function isMigrationSession(value: unknown, sourceID: string | null) {
  const marker = migrationMarker(value)
  return marker !== undefined && marker.migrationID === ID && marker.sourceID === sourceID
}

function migrationMarker(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("productMigration" in value)) return
  const marker = value.productMigration
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return
  return marker as Record<string, unknown>
}

function markerClosure(marker: Record<string, unknown>) {
  const value = marker.closure
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const closure = value as Record<string, unknown>
  const keys = ["legacyMessages", "parts", "currentMessages", "inputs", "todos"] as const
  if (!keys.every((key) => Number.isSafeInteger(closure[key]) && Number(closure[key]) >= 0)) return
  if (typeof closure.projectID !== "string" || closure.projectID.length > 256) return
  const projectDirectories = Array.isArray(closure.projectDirectories)
    ? closure.projectDirectories.filter((item): item is string => typeof item === "string")
    : []
  if (
    !Number.isSafeInteger(closure.projectDirectoryCount) ||
    Number(closure.projectDirectoryCount) < 0 ||
    Number(closure.projectDirectoryCount) > 10_000 ||
    !Array.isArray(closure.projectDirectories) ||
    closure.projectDirectories.length !== closure.projectDirectoryCount ||
    projectDirectories.length !== closure.projectDirectories.length ||
    projectDirectories.some((item) => item.length > 4_096) ||
    new Set(projectDirectories).size !== projectDirectories.length
  )
    return
  if (closure.workspaceID !== null && (typeof closure.workspaceID !== "string" || closure.workspaceID.length > 256))
    return
  const permissionIDs = Array.isArray(closure.permissionIDs)
    ? closure.permissionIDs.filter((item): item is string => typeof item === "string")
    : []
  if (
    !Number.isSafeInteger(closure.permissionCount) ||
    Number(closure.permissionCount) < 0 ||
    Number(closure.permissionCount) > 10_000 ||
    !Array.isArray(closure.permissionIDs) ||
    closure.permissionIDs.length !== closure.permissionCount ||
    permissionIDs.length !== closure.permissionIDs.length ||
    permissionIDs.some((item) => item.length > 256) ||
    new Set(permissionIDs).size !== permissionIDs.length
  )
    return
  return {
    legacyMessages: Number(closure.legacyMessages),
    parts: Number(closure.parts),
    currentMessages: Number(closure.currentMessages),
    inputs: Number(closure.inputs),
    todos: Number(closure.todos),
    projectID: closure.projectID,
    projectDirectoryCount: Number(closure.projectDirectoryCount),
    projectDirectories,
    workspaceID: closure.workspaceID,
    permissionCount: Number(closure.permissionCount),
    permissionIDs,
  }
}

function markerCopiedFiles(marker: Record<string, unknown> | undefined) {
  if (!marker || !Number.isSafeInteger(marker.copiedFileCount) || Number(marker.copiedFileCount) < 0) return
  if (!Number.isSafeInteger(marker.copiedFileBytes) || Number(marker.copiedFileBytes) < 0) return
  if (!Array.isArray(marker.copiedFiles) || marker.copiedFiles.length !== marker.copiedFileCount) return
  const files = marker.copiedFiles.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    if (!("path" in item) || typeof item.path !== "string") return []
    if (!("sha256" in item) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return []
    if (!("size" in item) || !Number.isSafeInteger(item.size) || Number(item.size) < 0) return []
    return [{ path: item.path, sha256: item.sha256, size: Number(item.size) }]
  })
  if (files.length !== marker.copiedFiles.length) return
  if (new Set(files.map((file) => file.path)).size !== files.length) return
  if (files.reduce((total, file) => total + file.size, 0) !== marker.copiedFileBytes) return
  return files
}

function validateExpectedCopiedFiles(
  data: string,
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>,
) {
  if (files.length > 10_000) {
    return Effect.succeed([{ code: "copied_file_limit", message: "Migrated copied-file inventory is too large" }])
  }
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(data),
      catch: () => new Error("Migrated copied-file inventory could not be validated"),
    })
    const limit =
      files.some((file) => file.size > ProductMigrationFile.referencedFileMaxBytes) ||
      files.reduce((total, file) => total + file.size, 0) > ProductMigrationFile.referencedSessionMaxBytes
        ? [{ code: "copied_file_limit", message: "Migrated copied-file inventory exceeds byte limits" }]
        : []
    const issues = yield* Effect.forEach(
      files,
      (file) => {
        if (path.isAbsolute(file.path)) {
          return Effect.succeed([
            { code: "copied_file_unsafe", message: "A migrated copied-file path is not relative" },
          ])
        }
        const target = path.resolve(root, file.path)
        const relative = path.relative(root, target)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          return Effect.succeed([
            { code: "copied_file_unsafe", message: "A migrated copied-file path escapes Graph Vibe data" },
          ])
        }
        return Effect.gen(function* () {
          const info = yield* Effect.promise(() => lstat(target).catch(() => undefined))
          if (!info) return [{ code: "copied_file_missing", message: "A migrated copied file is missing" }]
          if (!info.isFile() || info.isSymbolicLink()) {
            return [{ code: "copied_file_unsafe", message: "A migrated copied file is not a regular file" }]
          }
          if (info.size > ProductMigrationFile.referencedFileMaxBytes) {
            return [{ code: "copied_file_limit", message: "A migrated copied file exceeds validation limits" }]
          }
          if (info.size !== file.size) {
            return [{ code: "copied_file_hash", message: "A migrated copied file does not match its inventory" }]
          }
          const hashed = yield* Effect.tryPromise({
            try: () =>
              ProductMigrationFile.hashContainedFile({
                file: target,
                root,
                maxBytes: ProductMigrationFile.referencedFileMaxBytes,
              }),
            catch: () => new Error("Migrated copied-file inventory could not be validated"),
          })
          return hashed.sha256 === file.sha256
            ? []
            : [{ code: "copied_file_hash", message: "A migrated copied file does not match its inventory" }]
        })
      },
      { concurrency: 1 },
    )
    return [...limit, ...issues.flat()]
  }).pipe(
    Effect.catch(() =>
      Effect.succeed([
        { code: "copied_file_unreadable", message: "Migrated copied-file inventory could not be validated" },
      ]),
    ),
  )
}

function validateCopiedFiles(data: string) {
  return Effect.tryPromise({
    try: async () => {
      const dataRoot = await realpath(data)
      const budget = { entries: 0 }
      const sessionBytes = new Map<string, number>()
      const inspect = async (directory: string, depth: number): Promise<ProductMigration.ValidationIssue[]> => {
        if (depth > 4)
          return [{ code: "copied_file_limit", message: "Migrated file nesting exceeds validation limits" }]
        const entries = await readdir(directory, { withFileTypes: true })
        budget.entries += entries.length
        if (budget.entries > 10_000) {
          return [{ code: "copied_file_limit", message: "Migrated file count exceeds validation limits" }]
        }
        const issues: ProductMigration.ValidationIssue[] = []
        for (const entry of entries) {
          const target = path.join(directory, entry.name)
          const info = await lstat(target)
          if (info.isSymbolicLink()) {
            issues.push({ code: "copied_file_unsafe", message: "A migrated file is a symbolic link" })
            continue
          }
          const canonical = await realpath(target)
          const relative = path.relative(dataRoot, canonical)
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            issues.push({ code: "copied_file_unsafe", message: "A migrated file is outside Graph Vibe data" })
            continue
          }
          if (info.isDirectory()) {
            issues.push(...(await inspect(target, depth + 1)))
            continue
          }
          if (!info.isFile()) {
            issues.push({ code: "copied_file_unsafe", message: "A migrated file is not a regular file" })
            continue
          }
          if (info.size > ProductMigrationFile.referencedFileMaxBytes) {
            issues.push({ code: "copied_file_limit", message: "A migrated file exceeds validation limits" })
            continue
          }
          const session = path.relative(path.join(dataRoot, "product-migration"), target).split(path.sep)[0] ?? ""
          const total = (sessionBytes.get(session) ?? 0) + info.size
          sessionBytes.set(session, total)
          if (total > ProductMigrationFile.referencedSessionMaxBytes) {
            issues.push({ code: "copied_file_limit", message: "Migrated session files exceed validation limits" })
            continue
          }
          const name = /^([0-9a-f]{16})-.+$/.exec(entry.name)
          if (!name) {
            issues.push({ code: "copied_file_name", message: "A migrated file name is not content addressed" })
            continue
          }
          const digest = await ProductMigrationFile.hashContainedFile({
            file: target,
            root: dataRoot,
            maxBytes: ProductMigrationFile.referencedFileMaxBytes,
          })
          if (!digest.sha256.startsWith(name[1]!)) {
            issues.push({ code: "copied_file_hash", message: "A migrated file does not match its content address" })
          }
        }
        return issues
      }
      return inspect(path.join(dataRoot, "product-migration"), 0)
    },
    catch: () => new Error("Migrated files could not be validated"),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed([{ code: "copied_file_unreadable", message: "Migrated files could not be validated" }]),
    ),
  )
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    ProductMigrationState.node,
    ProductMigrationSource.node,
    ProductMigrationConfig.node,
    ProductMigrationSession.node,
    ProductMigrationGraph.node,
    Npm.node,
    FSUtil.node,
    Global.node,
    ProductMigrationSourceRoots.node,
  ],
})
