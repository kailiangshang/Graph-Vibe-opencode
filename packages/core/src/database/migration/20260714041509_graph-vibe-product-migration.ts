import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714041509_graph-vibe-product-migration",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`product_migration_entity\` (
          \`migration_id\` text NOT NULL,
          \`entity_type\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`source_fingerprint\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`product_migration_entity_pk\` PRIMARY KEY(\`migration_id\`, \`entity_type\`, \`source_id\`),
          CONSTRAINT \`fk_product_migration_entity_migration_id_product_migration_id_fk\` FOREIGN KEY (\`migration_id\`) REFERENCES \`product_migration\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`product_migration_item\` (
          \`migration_id\` text NOT NULL,
          \`item_id\` text NOT NULL,
          \`category\` text NOT NULL,
          \`source_id\` text,
          \`source_fingerprint\` text,
          \`target_id\` text,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`selected\` integer DEFAULT true NOT NULL,
          \`estimated_bytes\` integer DEFAULT 0 NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`product_migration_item_pk\` PRIMARY KEY(\`migration_id\`, \`item_id\`),
          CONSTRAINT \`fk_product_migration_item_migration_id_product_migration_id_fk\` FOREIGN KEY (\`migration_id\`) REFERENCES \`product_migration\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`product_migration\` (
          \`id\` text PRIMARY KEY,
          \`status\` text NOT NULL,
          \`source_path\` text,
          \`source_fingerprint\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`plan\` text,
          \`validation\` text,
          \`finalized_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`product_migration_entity_target_idx\` ON \`product_migration_entity\` (\`entity_type\`,\`target_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`product_migration_item_status_idx\` ON \`product_migration_item\` (\`migration_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
