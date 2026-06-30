import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260630062453_graph",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`graph_edge\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`source_id\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`relation\` text NOT NULL,
          \`confidence\` real DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_graph_edge_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_edge_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_edge_source_id_graph_node_id_fk\` FOREIGN KEY (\`source_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_edge_target_id_graph_node_id_fk\` FOREIGN KEY (\`target_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`graph_node\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`type\` text NOT NULL,
          \`name\` text NOT NULL,
          \`level\` text NOT NULL,
          \`priority\` text,
          \`category\` text,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`desc\` text,
          \`content\` text,
          \`code_hash\` text,
          \`test_status\` text DEFAULT 'none' NOT NULL,
          \`confidence\` real DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_graph_node_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_node_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`graph_version\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`version_number\` integer NOT NULL,
          \`message\` text,
          \`snapshot\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_graph_version_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_version_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`graph_edge_src_tgt_rel_idx\` ON \`graph_edge\` (\`source_id\`,\`target_id\`,\`relation\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_edge_project_idx\` ON \`graph_edge\` (\`project_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`graph_edge_project_session_idx\` ON \`graph_edge\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_edge_source_relation_idx\` ON \`graph_edge\` (\`source_id\`,\`relation\`);`)
      yield* tx.run(`CREATE INDEX \`graph_edge_target_idx\` ON \`graph_edge\` (\`target_id\`);`)
      yield* tx.run(`CREATE INDEX \`graph_node_project_idx\` ON \`graph_node\` (\`project_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`graph_node_project_session_idx\` ON \`graph_node\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_node_project_type_idx\` ON \`graph_node\` (\`project_id\`,\`type\`);`)
      yield* tx.run(`CREATE INDEX \`graph_node_project_status_idx\` ON \`graph_node\` (\`project_id\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`graph_node_session_idx\` ON \`graph_node\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`graph_version_project_number_idx\` ON \`graph_version\` (\`project_id\`,\`version_number\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`graph_version_project_created_idx\` ON \`graph_version\` (\`project_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
