import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712134131_lazy_skin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`graph_workflow_state\` ADD \`active_operation_process_id\` integer;`)
      yield* tx.run(`ALTER TABLE \`graph_workflow_state\` ADD \`active_operation_runtime_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
