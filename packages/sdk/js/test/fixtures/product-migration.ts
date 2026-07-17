import type {
  ProductMigrationDiscoverData,
  ProductMigrationExecuteData,
  ProductMigrationFinalizeData,
  ProductMigrationFreshStartData,
  ProductMigrationItem,
  ProductMigrationPauseData,
  ProductMigrationProjection,
  ProductMigrationRetryData,
  ProductMigrationSkipData,
  ProductMigrationUpdateDraftData,
  ProductMigrationValidateData,
} from "../../src/v2/gen/types.gen.js"
import { ProductMigration } from "../../src/v2/gen/sdk.gen.js"

const projection: ProductMigrationProjection = {
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

const item: ProductMigrationItem = {
  itemID: "category:config",
  category: "config",
  sourceID: null,
  targetID: null,
  status: "pending",
  selected: true,
  estimatedBytes: 0,
  error: null,
}

void projection
void item

const migration = new ProductMigration()
migration.discover({ productMigrationDiscoverPayload: { expectedRevision: 0 } })
migration.execute({ productMigrationRevisionPayload: { expectedRevision: 1 } })
// @ts-expect-error migration mutations require a request body
migration.discover()
// @ts-expect-error migration mutations require a request body
migration.execute()

type RequireBody<T extends { body: unknown }> = T
type MutationData =
  | RequireBody<ProductMigrationDiscoverData>
  | RequireBody<ProductMigrationUpdateDraftData>
  | RequireBody<ProductMigrationExecuteData>
  | RequireBody<ProductMigrationPauseData>
  | RequireBody<ProductMigrationRetryData>
  | RequireBody<ProductMigrationSkipData>
  | RequireBody<ProductMigrationValidateData>
  | RequireBody<ProductMigrationFinalizeData>
  | RequireBody<ProductMigrationFreshStartData>

void (undefined as unknown as MutationData)

// @ts-expect-error migration mutations require a request body
migration.updateDraft()
// @ts-expect-error migration mutations require a request body
migration.pause()
// @ts-expect-error migration mutations require a request body
migration.retry()
// @ts-expect-error migration mutations require a request body
migration.skip()
// @ts-expect-error migration mutations require a request body
migration.validate()
// @ts-expect-error migration mutations require a request body
migration.finalize()
// @ts-expect-error migration mutations require a request body
migration.freshStart()
