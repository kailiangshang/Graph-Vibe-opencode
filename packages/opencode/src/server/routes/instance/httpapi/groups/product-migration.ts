import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const RevisionPayload = Schema.Struct({ expectedRevision: Schema.Number }).annotate({
  identifier: "ProductMigrationRevisionPayload",
})

export const DiscoverPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  source: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  currentProject: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
}).annotate({ identifier: "ProductMigrationDiscoverPayload" })

export const DraftPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  categories: Schema.Array(Schema.Struct({ category: ProductMigration.Category, selected: Schema.Boolean })).check(
    Schema.isMaxLength(16),
  ),
  sessionsEnabled: Schema.Boolean,
  sessions: Schema.Array(
    Schema.Struct({
      projectID: Schema.String.check(Schema.isMaxLength(256)),
      sessionID: Schema.String.check(Schema.isMaxLength(256)),
      selected: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(2_000)),
  currentProject: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
}).annotate({ identifier: "ProductMigrationDraftPayload" })

export const ItemPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  itemID: Schema.String.check(Schema.isMaxLength(256)),
}).annotate({ identifier: "ProductMigrationItemPayload" })

export class ProductMigrationUnavailable extends Schema.TaggedErrorClass<ProductMigrationUnavailable>()(
  "ProductMigrationUnavailable",
  {},
  { httpApiStatus: 404 },
) {}

const MutationErrors = [
  ProductMigrationUnavailable,
  ProductMigration.Required,
  ProductMigration.RevisionConflict,
  ProductMigration.InvalidTransition,
  ProductMigration.Finalized,
  ProductMigration.SourceError,
  ProductMigration.ValidationFailed,
  ProductMigration.Conflict,
  ProductMigration.InsufficientSpace,
  ProductMigration.ItemNotFound,
] as const

export const ProductMigrationPaths = {
  get: "/global/product-migration",
  discover: "/global/product-migration/discover",
  updateDraft: "/global/product-migration/draft",
  execute: "/global/product-migration/execute",
  pause: "/global/product-migration/pause",
  retry: "/global/product-migration/retry",
  skip: "/global/product-migration/skip",
  validate: "/global/product-migration/validate",
  finalize: "/global/product-migration/finalize",
  freshStart: "/global/product-migration/fresh-start",
} as const

export const ProductMigrationGroup = HttpApiGroup.make("productMigration")
  .add(
    HttpApiEndpoint.get("get", ProductMigrationPaths.get, {
      success: described(ProductMigration.Projection, "Migration projection"),
      error: [ProductMigrationUnavailable, ProductMigration.SourceError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "productMigration.get",
        summary: "Get product migration",
        description: "Get the current Graph Vibe product migration projection.",
      }),
    ),
    HttpApiEndpoint.post("discover", ProductMigrationPaths.discover, {
      payload: DiscoverPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "productMigration.discover", summary: "Discover migration source" }),
    ),
    HttpApiEndpoint.post("updateDraft", ProductMigrationPaths.updateDraft, {
      payload: DraftPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "productMigration.updateDraft", summary: "Update migration draft" }),
    ),
    HttpApiEndpoint.post("execute", ProductMigrationPaths.execute, {
      payload: RevisionPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "productMigration.execute", summary: "Execute or resume migration" }),
    ),
    HttpApiEndpoint.post("pause", ProductMigrationPaths.pause, {
      payload: RevisionPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(OpenApi.annotations({ identifier: "productMigration.pause", summary: "Pause migration" })),
    HttpApiEndpoint.post("retry", ProductMigrationPaths.retry, {
      payload: ItemPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(OpenApi.annotations({ identifier: "productMigration.retry", summary: "Retry migration item" })),
    HttpApiEndpoint.post("skip", ProductMigrationPaths.skip, {
      payload: ItemPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(OpenApi.annotations({ identifier: "productMigration.skip", summary: "Skip migration item" })),
    HttpApiEndpoint.post("validate", ProductMigrationPaths.validate, {
      payload: RevisionPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(OpenApi.annotations({ identifier: "productMigration.validate", summary: "Validate migration" })),
    HttpApiEndpoint.post("finalize", ProductMigrationPaths.finalize, {
      payload: RevisionPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(OpenApi.annotations({ identifier: "productMigration.finalize", summary: "Finalize migration" })),
    HttpApiEndpoint.post("freshStart", ProductMigrationPaths.freshStart, {
      payload: RevisionPayload,
      success: ProductMigration.Projection,
      error: MutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "productMigration.freshStart", summary: "Start Graph Vibe without import" }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "productMigration", description: "One-time Graph Vibe product migration routes." }),
  )
