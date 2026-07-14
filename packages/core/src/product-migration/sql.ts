import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Timestamps } from "../database/schema.sql"

export const ProductMigrationTable = sqliteTable("product_migration", {
  id: text().primaryKey(),
  status: text().$type<ProductMigration.Status>().notNull(),
  source_path: text(),
  source_fingerprint: text(),
  revision: integer().notNull().default(0),
  plan: text(),
  validation: text(),
  finalized_at: integer(),
  ...Timestamps,
})

export const ProductMigrationItemTable = sqliteTable(
  "product_migration_item",
  {
    migration_id: text()
      .notNull()
      .references(() => ProductMigrationTable.id, { onDelete: "cascade" }),
    item_id: text().notNull(),
    category: text().$type<ProductMigration.Category>().notNull(),
    source_id: text(),
    source_fingerprint: text(),
    target_id: text(),
    status: text().$type<ProductMigration.ItemStatus>().notNull().default("pending"),
    selected: integer({ mode: "boolean" }).notNull().default(true),
    estimated_bytes: integer().notNull().default(0),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.migration_id, table.item_id] }),
    index("product_migration_item_status_idx").on(table.migration_id, table.status),
  ],
)

export const ProductMigrationEntityTable = sqliteTable(
  "product_migration_entity",
  {
    migration_id: text()
      .notNull()
      .references(() => ProductMigrationTable.id, { onDelete: "cascade" }),
    entity_type: text().notNull(),
    source_id: text().notNull(),
    source_fingerprint: text().notNull(),
    target_id: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.migration_id, table.entity_type, table.source_id] }),
    uniqueIndex("product_migration_entity_target_idx").on(table.entity_type, table.target_id),
  ],
)
