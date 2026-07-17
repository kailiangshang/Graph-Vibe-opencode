export * as ProductMigration from "./product-migration"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"

export const Status = Schema.Literals([
  "draft",
  "copying",
  "paused",
  "validating",
  "ready_to_finalize",
  "failed",
  "completed",
])
export type Status = typeof Status.Type

export const ItemStatus = Schema.Literals(["pending", "copying", "completed", "failed", "skipped"])
export type ItemStatus = typeof ItemStatus.Type

export const Category = Schema.Literals(["config", "credentials", "mcp", "project", "session", "graph"])
export type Category = typeof Category.Type

export class RevisionConflict extends Schema.TaggedErrorClass<RevisionConflict>()(
  "ProductMigrationRevisionConflict",
  {
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()(
  "ProductMigrationInvalidTransition",
  {
    status: Status,
    target: Status,
  },
  { httpApiStatus: 409 },
) {}

export class Required extends Schema.TaggedErrorClass<Required>()(
  "ProductMigrationRequired",
  {},
  { httpApiStatus: 404 },
) {}

export class Finalized extends Schema.TaggedErrorClass<Finalized>()(
  "ProductMigrationFinalized",
  {},
  { httpApiStatus: 409 },
) {}

const BoundedID = Schema.String.check(Schema.isMaxLength(256))
const BoundedText = Schema.String.check(Schema.isMaxLength(512))
const BoundedPath = Schema.String.check(Schema.isMaxLength(4_096))

export const SourceSummary = Schema.Struct({
  database: BoundedPath,
  databaseBytes: Schema.Number,
  mixedGraph: Schema.Boolean,
  sessionCount: Schema.Number,
}).annotate({ identifier: "ProductMigrationSourceSummary" })
export interface SourceSummary extends Schema.Schema.Type<typeof SourceSummary> {}

export const CategorySelection = Schema.Struct({
  category: Category,
  available: Schema.Boolean,
  selected: Schema.Boolean,
  estimatedBytes: Schema.Number,
}).annotate({ identifier: "ProductMigrationCategorySelection" })
export interface CategorySelection extends Schema.Schema.Type<typeof CategorySelection> {}

export const SessionSelection = Schema.Struct({
  id: BoundedID,
  title: Schema.String.check(Schema.isMaxLength(256)),
  updatedAt: Schema.Number,
  estimatedBytes: Schema.Number,
  hasGraph: Schema.Boolean,
  archived: optional(Schema.Boolean),
  selected: Schema.Boolean,
}).annotate({ identifier: "ProductMigrationSessionSelection" })
export interface SessionSelection extends Schema.Schema.Type<typeof SessionSelection> {}

export const ProjectSelection = Schema.Struct({
  id: BoundedID,
  path: BoundedPath,
  sessionCount: Schema.Number,
  estimatedBytes: Schema.Number,
  current: Schema.Boolean,
  sessions: Schema.Array(SessionSelection).check(Schema.isMaxLength(2_000)),
}).annotate({ identifier: "ProductMigrationProjectSelection" })
export interface ProjectSelection extends Schema.Schema.Type<typeof ProjectSelection> {}

export const Plan = Schema.Struct({
  revision: Schema.Number,
  sourceFingerprint: BoundedID,
  categories: Schema.Array(CategorySelection).check(Schema.isMaxLength(16)),
  sessionsEnabled: Schema.Boolean,
  projects: Schema.Array(ProjectSelection).check(Schema.isMaxLength(1_000)),
  requiredBytes: Schema.Number,
}).annotate({ identifier: "ProductMigrationPlan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Item = Schema.Struct({
  itemID: BoundedID,
  category: Category,
  sourceID: Schema.NullOr(BoundedID),
  targetID: Schema.NullOr(BoundedID),
  status: ItemStatus,
  selected: Schema.Boolean,
  estimatedBytes: Schema.Number,
  error: Schema.NullOr(BoundedText),
}).annotate({ identifier: "ProductMigrationItem" })
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const ValidationIssue = Schema.Struct({
  code: BoundedID,
  message: BoundedText,
}).annotate({ identifier: "ProductMigrationValidationIssue" })
export interface ValidationIssue extends Schema.Schema.Type<typeof ValidationIssue> {}

export const Validation = Schema.Struct({
  valid: Schema.Boolean,
  issues: Schema.Array(ValidationIssue).check(Schema.isMaxLength(32)),
}).annotate({ identifier: "ProductMigrationValidation" })
export interface Validation extends Schema.Schema.Type<typeof Validation> {}

export const Projection = Schema.Struct({
  status: Schema.Union([Schema.Literal("undiscovered"), Status]),
  revision: Schema.Number,
  source: Schema.NullOr(SourceSummary),
  plan: Schema.NullOr(Plan),
  items: Schema.Array(Item).check(Schema.isMaxLength(2_016)),
  validation: Schema.NullOr(Validation),
  completedItems: Schema.Number,
  totalItems: Schema.Number,
  canFinalize: Schema.Boolean,
}).annotate({ identifier: "ProductMigrationProjection" })
export interface Projection extends Schema.Schema.Type<typeof Projection> {}

export class SourceError extends Schema.TaggedErrorClass<SourceError>()(
  "ProductMigrationSourceError",
  {
    code: Schema.Literals(["not_found", "unsupported", "changed", "unreadable", "invalid_root", "limit"]),
    message: BoundedText,
  },
  { httpApiStatus: 422 },
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()(
  "ProductMigrationValidationFailed",
  { issues: Schema.Array(ValidationIssue).check(Schema.isMaxLength(32)) },
  { httpApiStatus: 422 },
) {}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()(
  "ProductMigrationConflict",
  {
    itemID: Schema.optional(BoundedID),
    message: BoundedText,
  },
  { httpApiStatus: 409 },
) {}

export class InsufficientSpace extends Schema.TaggedErrorClass<InsufficientSpace>()(
  "ProductMigrationInsufficientSpace",
  {
    requiredBytes: Schema.Number,
    availableBytes: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export class ItemNotFound extends Schema.TaggedErrorClass<ItemNotFound>()(
  "ProductMigrationItemNotFound",
  { itemID: BoundedID },
  { httpApiStatus: 404 },
) {}

const Updated = define({ type: "product.migration.updated", schema: { status: Status, revision: Schema.Number } })
export const Event = { Updated, Definitions: inventory(Updated) }
