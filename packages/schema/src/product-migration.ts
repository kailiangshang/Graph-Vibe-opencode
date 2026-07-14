export * as ProductMigration from "./product-migration"

import { Schema } from "effect"

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

export class RevisionConflict extends Schema.TaggedErrorClass<RevisionConflict>()("ProductMigrationRevisionConflict", {
  expectedRevision: Schema.Number,
  actualRevision: Schema.Number,
}) {}

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()(
  "ProductMigrationInvalidTransition",
  {
    status: Status,
    target: Status,
  },
) {}

export class Required extends Schema.TaggedErrorClass<Required>()("ProductMigrationRequired", {}) {}

export class Finalized extends Schema.TaggedErrorClass<Finalized>()("ProductMigrationFinalized", {}) {}
