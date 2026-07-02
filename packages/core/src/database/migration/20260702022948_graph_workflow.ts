import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260702022948_graph_workflow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`graph_generation_run\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`node_id\` text NOT NULL,
          \`executor\` text NOT NULL,
          \`backend\` text,
          \`model\` text,
          \`context_snapshot_hash\` text,
          \`status\` text NOT NULL,
          \`gate_result\` text NOT NULL,
          \`artifact_summary\` text,
          \`diagnostics_summary\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_graph_generation_run_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_generation_run_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_generation_run_node_id_graph_node_id_fk\` FOREIGN KEY (\`node_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`graph_tool_run\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`node_id\` text,
          \`tool_name\` text NOT NULL,
          \`tool_type\` text NOT NULL,
          \`input_summary\` text,
          \`output_summary\` text,
          \`status\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_graph_tool_run_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_tool_run_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_graph_tool_run_node_id_graph_node_id_fk\` FOREIGN KEY (\`node_id\`) REFERENCES \`graph_node\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`graph_generation_run_project_session_idx\` ON \`graph_generation_run\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_generation_run_node_idx\` ON \`graph_generation_run\` (\`node_id\`);`)
      yield* tx.run(`CREATE INDEX \`graph_generation_run_created_idx\` ON \`graph_generation_run\` (\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`graph_tool_run_project_session_idx\` ON \`graph_tool_run\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`graph_tool_run_node_idx\` ON \`graph_tool_run\` (\`node_id\`);`)
      yield* tx.run(`CREATE INDEX \`graph_tool_run_created_idx\` ON \`graph_tool_run\` (\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
