import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712132753_serious_blue_shield",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`graph_workflow_state\` ADD \`active_operation_id\` text;`)
      yield* tx.run(`ALTER TABLE \`graph_workflow_state\` ADD \`active_operation_kind\` text;`)
      yield* tx.run(`ALTER TABLE \`graph_workflow_state\` ADD \`active_operation_started_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
