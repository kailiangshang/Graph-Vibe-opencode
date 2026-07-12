import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { CheckpointKind, CheckpointStatus, ExecutionMode, NodeID } from "@opencode-ai/schema/graph"
import { Timestamps } from "../../database/schema.sql"
import type { ProjectV2 } from "../../project"
import { ProjectTable } from "../../project/sql"
import { SessionTable } from "../../session/sql"
import { GraphNodeTable } from "../sql"

export const GraphWorkflowStateTable = sqliteTable("graph_workflow_state", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  project_id: text()
    .$type<ProjectV2.ID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  mode: text().$type<ExecutionMode>(),
  current_node_id: text()
    .$type<NodeID>()
    .references(() => GraphNodeTable.id, { onDelete: "set null" }),
  checkpoint_kind: text().$type<CheckpointKind>(),
  checkpoint_scope_node_id: text()
    .$type<NodeID>()
    .references(() => GraphNodeTable.id, { onDelete: "set null" }),
  checkpoint_status: text().$type<CheckpointStatus>().notNull().default("none"),
  checkpoint_reason: text(),
  revision: integer().notNull().default(0),
  active_operation_id: text(),
  active_operation_kind: text().$type<"artifact_apply">(),
  active_operation_started_at: integer(),
  ...Timestamps,
})
