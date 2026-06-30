import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import type {
  NodeID,
  EdgeID,
  VersionID,
  NodeType,
  Level,
  Priority,
  NodeStatus,
  TestStatus,
  EdgeRelation,
  NodeContent,
} from "@opencode-ai/schema/graph"

export const GraphNodeTable = sqliteTable(
  "graph_node",
  {
    id: text().$type<NodeID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<string>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<NodeType>().notNull(),
    name: text().notNull(),
    level: text().$type<Level>().notNull(),
    priority: text().$type<Priority>(),
    category: text(),
    status: text().$type<NodeStatus>().notNull().default("pending"),
    desc: text(),
    content: text({ mode: "json" }).$type<NodeContent>(),
    code_hash: text(),
    test_status: text().$type<TestStatus>().notNull().default("none"),
    confidence: real().notNull().default(1),
    ...Timestamps,
  },
  (t) => [
    index("graph_node_project_idx").on(t.project_id),
    index("graph_node_project_session_idx").on(t.project_id, t.session_id),
    index("graph_node_project_type_idx").on(t.project_id, t.type),
    index("graph_node_project_status_idx").on(t.project_id, t.status),
    index("graph_node_session_idx").on(t.session_id),
  ],
)

export const GraphEdgeTable = sqliteTable(
  "graph_edge",
  {
    id: text().$type<EdgeID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<string>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_id: text()
      .$type<NodeID>()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    target_id: text()
      .$type<NodeID>()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    relation: text().$type<EdgeRelation>().notNull(),
    confidence: real().notNull().default(1),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (t) => [
    uniqueIndex("graph_edge_src_tgt_rel_idx").on(t.source_id, t.target_id, t.relation),
    index("graph_edge_project_idx").on(t.project_id),
    index("graph_edge_project_session_idx").on(t.project_id, t.session_id),
    index("graph_edge_source_relation_idx").on(t.source_id, t.relation),
    index("graph_edge_target_idx").on(t.target_id),
  ],
)

export const GraphVersionTable = sqliteTable(
  "graph_version",
  {
    id: text().$type<VersionID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<string>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    version_number: integer().notNull(),
    message: text(),
    snapshot: text({ mode: "json" }).$type<{ nodes: unknown[]; edges: unknown[] }>().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (t) => [
    uniqueIndex("graph_version_project_number_idx").on(t.project_id, t.version_number),
    index("graph_version_project_created_idx").on(t.project_id, t.time_created),
  ],
)
