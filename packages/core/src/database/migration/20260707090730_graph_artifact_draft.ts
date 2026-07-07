import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260707090730_graph_artifact_draft",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`graph_artifact_draft\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`test\` text NOT NULL,
          \`files\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_graph_artifact_draft_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_artifact_draft_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_artifact_draft_node_id_graph_node_id_fk\` FOREIGN KEY (\`node_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`graph_artifact_draft_project_session_idx\` ON \`graph_artifact_draft\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_artifact_draft_node_idx\` ON \`graph_artifact_draft\` (\`node_id\`);`)
      yield* tx.run(`CREATE INDEX \`graph_artifact_draft_status_idx\` ON \`graph_artifact_draft\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
