import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260710153207_graph_collaboration",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`graph_workflow_state\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`mode\` text,
          \`current_node_id\` text,
          \`checkpoint_kind\` text,
          \`checkpoint_scope_node_id\` text,
          \`checkpoint_status\` text DEFAULT 'none' NOT NULL,
          \`checkpoint_reason\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_graph_workflow_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_workflow_state_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_workflow_state_current_node_id_graph_node_id_fk\` FOREIGN KEY (\`current_node_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_graph_workflow_state_checkpoint_scope_node_id_graph_node_id_fk\` FOREIGN KEY (\`checkpoint_scope_node_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`graph_tool_run\` ADD \`evidence\` text;`)
      yield* tx.run(`ALTER TABLE \`graph_node\` ADD \`verification\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
