import { ProductMigrationService } from "@opencode-ai/core/product-migration/service"
import { Product } from "@opencode-ai/core/product"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Effect, Ref } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RootHttpApi } from "../api"
import { ProductMigrationUnavailable } from "../groups/product-migration"

export const productMigrationHandlers = HttpApiBuilder.group(RootHttpApi, "productMigration", (handlers) =>
  Effect.gen(function* () {
    const migration = yield* ProductMigrationService.Service
    const events = yield* EventV2Bridge.Service
    const product = yield* Product.Service
    const publications = KeyedMutex.makeUnsafe<string>()
    const publishedRevision = Ref.makeUnsafe(0)

    const available = Effect.fnUntraced(function* () {
      if (product.profile !== Product.GraphVibe) return yield* new ProductMigrationUnavailable()
    })

    const mutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        yield* available()
        const before = yield* migration.get()
        const result = yield* Effect.result(effect)
        const after = yield* migration.get()
        const updated =
          after.status !== "undiscovered" && after.revision > before.revision
            ? { status: after.status, revision: after.revision }
            : undefined
        if (updated) {
          yield* publications.withLock("product-migration")(
            Effect.gen(function* () {
              if (updated.revision <= (yield* Ref.get(publishedRevision))) return
              yield* events.publish(ProductMigration.Event.Updated, updated)
              yield* Ref.set(publishedRevision, updated.revision)
            }),
          )
        }
        if (result._tag === "Failure") return yield* Effect.fail(result.failure)
        return result.success
      })

    return handlers
      .handle("get", () => available().pipe(Effect.andThen(migration.get())))
      .handle("discover", (ctx) => mutation(migration.discover(ctx.payload)))
      .handle("updateDraft", (ctx) => mutation(migration.updateDraft(ctx.payload)))
      .handle("execute", (ctx) => mutation(migration.execute(ctx.payload)))
      .handle("pause", (ctx) => mutation(migration.pause(ctx.payload)))
      .handle("retry", (ctx) => mutation(migration.retry(ctx.payload)))
      .handle("skip", (ctx) => mutation(migration.skip(ctx.payload)))
      .handle("validate", (ctx) => mutation(migration.validate(ctx.payload)))
      .handle("finalize", (ctx) => mutation(migration.finalize(ctx.payload)))
      .handle("freshStart", (ctx) => mutation(migration.freshStart(ctx.payload)))
  }),
)
