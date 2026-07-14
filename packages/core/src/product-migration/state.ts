export * as ProductMigrationState from "./state"

import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { Product } from "../product"
import { ProductMigrationTable } from "./sql"

const ID = "opencode-first-import"

export interface State {
  readonly id: string
  readonly status: ProductMigration.Status
  readonly sourcePath: string | null
  readonly sourceFingerprint: string | null
  readonly revision: number
  readonly finalizedAt: number | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface Interface {
  readonly get: () => Effect.Effect<State | undefined>
  readonly initialize: (input: {
    readonly sourcePath: string
    readonly sourceFingerprint: string
  }) => Effect.Effect<State, ProductMigration.Finalized>
  readonly start: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<
    State,
    ProductMigration.Required | ProductMigration.RevisionConflict | ProductMigration.InvalidTransition
  >
  readonly pause: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<
    State,
    ProductMigration.Required | ProductMigration.RevisionConflict | ProductMigration.InvalidTransition
  >
  readonly validate: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<
    State,
    ProductMigration.Required | ProductMigration.RevisionConflict | ProductMigration.InvalidTransition
  >
  readonly validationSucceeded: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<
    State,
    ProductMigration.Required | ProductMigration.RevisionConflict | ProductMigration.InvalidTransition
  >
  readonly finalize: (input: {
    readonly expectedRevision: number
  }) => Effect.Effect<
    State,
    ProductMigration.Required | ProductMigration.RevisionConflict | ProductMigration.InvalidTransition
  >
  readonly freshStart: () => Effect.Effect<State>
  readonly requireCompleted: (profile: Product.Profile) => Effect.Effect<void, ProductMigration.Required>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationState") {}

function state(row: typeof ProductMigrationTable.$inferSelect): State {
  return {
    id: row.id,
    status: row.status,
    sourcePath: row.source_path,
    sourceFingerprint: row.source_fingerprint,
    revision: row.revision,
    finalizedAt: row.finalized_at,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const get = Effect.fn("ProductMigrationState.get")(function* () {
      const row = yield* db
        .select()
        .from(ProductMigrationTable)
        .where(eq(ProductMigrationTable.id, ID))
        .get()
        .pipe(Effect.orDie)
      return row ? state(row) : undefined
    })
    const transition = Effect.fnUntraced(function* (
      expectedRevision: number,
      allowed: ProductMigration.Status[],
      target: ProductMigration.Status,
      finalizedAt?: number,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(ProductMigrationTable)
              .where(eq(ProductMigrationTable.id, ID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new ProductMigration.Required()
            if (row.revision !== expectedRevision) {
              return yield* new ProductMigration.RevisionConflict({ expectedRevision, actualRevision: row.revision })
            }
            if (!allowed.includes(row.status)) {
              return yield* new ProductMigration.InvalidTransition({ status: row.status, target })
            }
            const next = yield* tx
              .update(ProductMigrationTable)
              .set({ status: target, revision: row.revision + 1, finalized_at: finalizedAt })
              .where(eq(ProductMigrationTable.id, ID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            return state(next)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({
      get,
      initialize: Effect.fn("ProductMigrationState.initialize")(function* (input) {
        const current = yield* get()
        if (current?.status === "completed") return yield* new ProductMigration.Finalized()
        if (current) return current
        const row = yield* db
          .insert(ProductMigrationTable)
          .values({
            id: ID,
            status: "draft",
            source_path: input.sourcePath,
            source_fingerprint: input.sourceFingerprint,
          })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return state(row)
      }),
      start: Effect.fn("ProductMigrationState.start")((input) =>
        transition(input.expectedRevision, ["draft", "paused", "failed"], "copying"),
      ),
      pause: Effect.fn("ProductMigrationState.pause")((input) =>
        transition(input.expectedRevision, ["copying"], "paused"),
      ),
      validate: Effect.fn("ProductMigrationState.validate")((input) =>
        transition(input.expectedRevision, ["copying"], "validating"),
      ),
      validationSucceeded: Effect.fn("ProductMigrationState.validationSucceeded")((input) =>
        transition(input.expectedRevision, ["validating"], "ready_to_finalize"),
      ),
      finalize: Effect.fn("ProductMigrationState.finalize")(function* (input) {
        return yield* transition(
          input.expectedRevision,
          ["ready_to_finalize"],
          "completed",
          yield* Clock.currentTimeMillis,
        )
      }),
      freshStart: Effect.fn("ProductMigrationState.freshStart")(function* () {
        const current = yield* get()
        if (current?.status === "completed") return current
        const now = yield* Clock.currentTimeMillis
        if (current) {
          const row = yield* db
            .update(ProductMigrationTable)
            .set({ status: "completed", revision: current.revision + 1, finalized_at: now })
            .where(eq(ProductMigrationTable.id, ID))
            .returning()
            .get()
            .pipe(Effect.orDie)
          return state(row)
        }
        const row = yield* db
          .insert(ProductMigrationTable)
          .values({ id: ID, status: "completed", finalized_at: now })
          .returning()
          .get()
          .pipe(Effect.orDie)
        return state(row)
      }),
      requireCompleted: Effect.fn("ProductMigrationState.requireCompleted")(function* (profile) {
        if (profile !== Product.GraphVibe) return
        if ((yield* get())?.status === "completed") return
        return yield* new ProductMigration.Required()
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
