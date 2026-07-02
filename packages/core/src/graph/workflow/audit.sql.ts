import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../../project/sql"
import { SessionTable } from "../../session/sql"
import { GraphNodeTable } from "../sql"
import type { ProjectV2 } from "../../project"
import type { NodeID } from "../storage"
import type { GateResult } from "./gate"

export type ToolRunStatus = "succeeded" | "failed" | "blocked" | "dry_run"
export type ToolRunType = "graph" | "local" | "mcp" | "permission" | "artifact" | "diagnostics"
export type GenerationExecutor = "agent" | "template" | "manual"
export type GenerationRunStatus = "succeeded" | "failed" | "blocked" | "dry_run"

export const GraphToolRunTable = sqliteTable(
  "graph_tool_run",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "cascade" }),
    node_id: text()
      .$type<NodeID>()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    tool_name: text().notNull(),
    tool_type: text().$type<ToolRunType>().notNull(),
    input_summary: text(),
    output_summary: text(),
    status: text().$type<ToolRunStatus>().notNull(),
    error: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (t) => [
    index("graph_tool_run_project_session_idx").on(t.project_id, t.session_id),
    index("graph_tool_run_node_idx").on(t.node_id),
    index("graph_tool_run_created_idx").on(t.time_created),
  ],
)

export const GraphGenerationRunTable = sqliteTable(
  "graph_generation_run",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().references(() => SessionTable.id, { onDelete: "cascade" }),
    node_id: text()
      .$type<NodeID>()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    executor: text().$type<GenerationExecutor>().notNull(),
    backend: text(),
    model: text(),
    context_snapshot_hash: text(),
    status: text().$type<GenerationRunStatus>().notNull(),
    gate_result: text({ mode: "json" }).$type<GateResult>().notNull(),
    artifact_summary: text(),
    diagnostics_summary: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (t) => [
    index("graph_generation_run_project_session_idx").on(t.project_id, t.session_id),
    index("graph_generation_run_node_idx").on(t.node_id),
    index("graph_generation_run_created_idx").on(t.time_created),
  ],
)
