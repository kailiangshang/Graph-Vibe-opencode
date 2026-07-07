import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../../database/schema.sql"
import { ProjectTable } from "../../project/sql"
import { SessionTable } from "../../session/sql"
import { GraphNodeTable } from "../sql"
import type { ProjectV2 } from "../../project"
import type { NodeID } from "../storage"

export type DraftStatus = "open" | "sealed" | "applied" | "cancelled"

export interface StoredDraftChunk {
  readonly index: number
  readonly content: string
}

export interface StoredDraftFile {
  readonly path: string
  readonly expectedChunks?: number
  readonly expectedSha256?: string
  readonly chunks: ReadonlyArray<StoredDraftChunk>
}

export const GraphArtifactDraftTable = sqliteTable(
  "graph_artifact_draft",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    node_id: text()
      .$type<NodeID>()
      .notNull()
      .references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    status: text().$type<DraftStatus>().notNull(),
    test: text().notNull(),
    files: text({ mode: "json" }).$type<ReadonlyArray<StoredDraftFile>>().notNull(),
    ...Timestamps,
  },
  (t) => [
    index("graph_artifact_draft_project_session_idx").on(t.project_id, t.session_id),
    index("graph_artifact_draft_node_idx").on(t.node_id),
    index("graph_artifact_draft_status_idx").on(t.status),
  ],
)
