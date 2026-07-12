import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712140000_recover_legacy_artifact_owners",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        UPDATE graph_workflow_state
        SET active_operation_id = NULL,
            active_operation_kind = NULL,
            active_operation_started_at = NULL,
            checkpoint_kind = 'failure',
            checkpoint_scope_node_id = current_node_id,
            checkpoint_status = 'pending',
            checkpoint_reason = 'legacy artifact apply reservation recovered during owner fencing upgrade',
            revision = revision + 1
        WHERE active_operation_id IS NOT NULL
          AND active_operation_kind = 'artifact_apply'
          AND active_operation_process_id IS NULL
          AND active_operation_runtime_id IS NULL
      `)
    })
  },
} satisfies DatabaseMigration.Migration
