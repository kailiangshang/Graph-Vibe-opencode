import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Product } from "@opencode-ai/core/product"
import { Database } from "@opencode-ai/core/database/database"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"

const layer = ProductMigrationState.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:")))

describe("ProductMigrationState", () => {
  test("enforces revisioned migration lifecycle", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationState.Service
        const draft = yield* migration.initialize({ sourcePath: "/source/opencode", sourceFingerprint: "source-1" })
        expect(draft).toMatchObject({ status: "draft", revision: 0, finalizedAt: null })

        const copying = yield* migration.start({ expectedRevision: draft.revision })
        const paused = yield* migration.pause({ expectedRevision: copying.revision })
        const resumed = yield* migration.start({ expectedRevision: paused.revision })
        const validating = yield* migration.validate({ expectedRevision: resumed.revision })
        const ready = yield* migration.validationSucceeded({ expectedRevision: validating.revision })
        const completed = yield* migration.finalize({ expectedRevision: ready.revision })

        expect(completed.status).toBe("completed")
        expect(completed.finalizedAt).toBeNumber()
        expect(completed.revision).toBe(6)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("rejects stale revisions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationState.Service
        yield* migration.initialize({ sourcePath: "/source/opencode", sourceFingerprint: "source-1" })
        const result = yield* migration.start({ expectedRevision: 1 }).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(String(result.cause)).toContain("RevisionConflict")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("fresh start permanently satisfies the Graph Vibe gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationState.Service
        expect(Exit.isFailure(yield* migration.requireCompleted(Product.GraphVibe).pipe(Effect.exit))).toBe(true)
        yield* migration.requireCompleted(Product.OpenCode)

        const completed = yield* migration.freshStart()
        expect(completed).toMatchObject({ status: "completed", sourcePath: null, sourceFingerprint: null })
        yield* migration.requireCompleted(Product.GraphVibe)
      }).pipe(Effect.provide(layer)),
    )
  })
})
