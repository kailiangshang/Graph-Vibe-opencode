export * as GraphStorage from "./storage"

import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { GraphNodeTable, GraphEdgeTable, GraphVersionTable } from "./sql"
import * as Graph from "@opencode-ai/schema/graph"
import type {
  NodeType,
  Level,
  Priority,
  NodeStatus,
  TestStatus,
  EdgeRelation,
  NodeContent,
} from "@opencode-ai/schema/graph"

export const NodeID = Graph.NodeID
export type NodeID = typeof NodeID.Type
export const EdgeID = Graph.EdgeID
export type EdgeID = typeof EdgeID.Type
export const VersionID = Graph.VersionID
export type VersionID = typeof VersionID.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("GraphV2.NotFoundError", {
  kind: Schema.Literals(["node", "edge", "version"]),
  id: Schema.String,
}) {}

export interface NodeRow {
  readonly id: NodeID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string | null
  readonly type: NodeType
  readonly name: string
  readonly level: Level
  readonly priority: Priority | null
  readonly category: string | null
  readonly status: NodeStatus
  readonly desc: string | null
  readonly content: NodeContent | null
  readonly codeHash: string | null
  readonly testStatus: TestStatus
  readonly confidence: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface EdgeRow {
  readonly id: EdgeID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string | null
  readonly sourceID: NodeID
  readonly targetID: NodeID
  readonly relation: EdgeRelation
  readonly confidence: number
  readonly timeCreated: number
}

export interface VersionRow {
  readonly id: VersionID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string | null
  readonly versionNumber: number
  readonly message: string | null
  readonly snapshot: { nodes: unknown[]; edges: unknown[] }
  readonly timeCreated: number
}

export interface GraphView {
  readonly nodes: ReadonlyArray<NodeRow>
  readonly edges: ReadonlyArray<EdgeRow>
}

export const NodeCreate = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String.pipe(Schema.optional),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Graph.Priority.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  status: Graph.NodeStatus.pipe(Schema.optional),
  desc: Schema.String.pipe(Schema.optional),
  content: Graph.NodeContent.pipe(Schema.optional),
  codeHash: Schema.String.pipe(Schema.optional),
  testStatus: Graph.TestStatus.pipe(Schema.optional),
  confidence: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.NodeCreate" })
export type NodeCreate = typeof NodeCreate.Type

export const NodePatch = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  priority: Graph.Priority.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  status: Graph.NodeStatus.pipe(Schema.optional),
  desc: Schema.String.pipe(Schema.optional),
  content: Graph.NodeContent.pipe(Schema.optional),
  codeHash: Schema.String.pipe(Schema.optional),
  testStatus: Graph.TestStatus.pipe(Schema.optional),
  confidence: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.NodePatch" })
export type NodePatch = typeof NodePatch.Type

export const NodeFilter = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String.pipe(Schema.optional),
  type: Graph.NodeType.pipe(Schema.optional),
  status: Graph.NodeStatus.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.NodeFilter" })
export type NodeFilter = typeof NodeFilter.Type

export const EdgeCreate = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String.pipe(Schema.optional),
  sourceID: NodeID,
  targetID: NodeID,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.EdgeCreate" })
export type EdgeCreate = typeof EdgeCreate.Type

export const EdgeFilter = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String.pipe(Schema.optional),
  sourceID: NodeID.pipe(Schema.optional),
  targetID: NodeID.pipe(Schema.optional),
  relation: Graph.EdgeRelation.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.EdgeFilter" })
export type EdgeFilter = typeof EdgeFilter.Type

export const PromoteInput = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "GraphStorage.PromoteInput" })
export type PromoteInput = typeof PromoteInput.Type

export interface PromoteResult {
  readonly versionID: VersionID
  readonly versionNumber: number
  readonly nodes: number
  readonly edges: number
}

export interface Interface {
  readonly node: {
    readonly create: (input: NodeCreate) => Effect.Effect<NodeID>
    readonly get: (id: NodeID) => Effect.Effect<NodeRow, NotFoundError>
    readonly update: (id: NodeID, patch: NodePatch) => Effect.Effect<void, NotFoundError>
    readonly delete: (id: NodeID) => Effect.Effect<void>
    readonly list: (filter: NodeFilter) => Effect.Effect<ReadonlyArray<NodeRow>>
  }
  readonly edge: {
    readonly create: (input: EdgeCreate) => Effect.Effect<EdgeID>
    readonly get: (id: EdgeID) => Effect.Effect<EdgeRow, NotFoundError>
    readonly delete: (id: EdgeID) => Effect.Effect<void>
    readonly list: (filter: EdgeFilter) => Effect.Effect<ReadonlyArray<EdgeRow>>
  }
  readonly main: (input: { projectID: ProjectV2.ID }) => Effect.Effect<GraphView>
  readonly currentPlan: (input: { sessionID: string }) => Effect.Effect<GraphView>
  readonly promote: (input: PromoteInput) => Effect.Effect<PromoteResult>
  readonly version: {
    readonly list: (input: { projectID: ProjectV2.ID }) => Effect.Effect<ReadonlyArray<VersionRow>>
    readonly get: (input: { projectID: ProjectV2.ID; versionNumber: number }) => Effect.Effect<VersionRow, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphStorage") {}

const nodeRow = (r: typeof GraphNodeTable.$inferSelect): NodeRow => ({
  id: r.id,
  projectID: r.project_id,
  sessionID: r.session_id,
  type: r.type,
  name: r.name,
  level: r.level,
  priority: r.priority,
  category: r.category,
  status: r.status,
  desc: r.desc,
  content: r.content,
  codeHash: r.code_hash,
  testStatus: r.test_status,
  confidence: r.confidence,
  timeCreated: r.time_created,
  timeUpdated: r.time_updated,
})

const edgeRow = (r: typeof GraphEdgeTable.$inferSelect): EdgeRow => ({
  id: r.id,
  projectID: r.project_id,
  sessionID: r.session_id,
  sourceID: r.source_id,
  targetID: r.target_id,
  relation: r.relation,
  confidence: r.confidence,
  timeCreated: r.time_created,
})

const versionRow = (r: typeof GraphVersionTable.$inferSelect): VersionRow => ({
  id: r.id,
  projectID: r.project_id,
  sessionID: r.session_id,
  versionNumber: r.version_number,
  message: r.message,
  snapshot: r.snapshot,
  timeCreated: r.time_created,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const nodeCreate = Effect.fn("GraphStorage.node.create")(function* (input: NodeCreate) {
      const id = NodeID.create()
      yield* db
        .insert(GraphNodeTable)
        .values({
          id,
          project_id: input.projectID,
          session_id: input.sessionID ?? null,
          type: input.type,
          name: input.name,
          level: input.level,
          priority: input.priority ?? null,
          category: input.category ?? null,
          status: input.status ?? "pending",
          desc: input.desc ?? null,
          content: input.content ?? null,
          code_hash: input.codeHash ?? null,
          test_status: input.testStatus ?? "none",
          confidence: input.confidence ?? 1,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const nodeGet = Effect.fn("GraphStorage.node.get")(function* (id: NodeID) {
      const r = yield* db.select().from(GraphNodeTable).where(eq(GraphNodeTable.id, id)).get().pipe(Effect.orDie)
      if (!r) return yield* new NotFoundError({ kind: "node", id })
      return nodeRow(r)
    })

    const nodeUpdate = Effect.fn("GraphStorage.node.update")(function* (id: NodeID, patch: NodePatch) {
      const set: Record<string, unknown> = {}
      if (patch.name !== undefined) set.name = patch.name
      if (patch.priority !== undefined) set.priority = patch.priority
      if (patch.category !== undefined) set.category = patch.category
      if (patch.status !== undefined) set.status = patch.status
      if (patch.desc !== undefined) set.desc = patch.desc
      if (patch.content !== undefined) set.content = patch.content
      if (patch.codeHash !== undefined) set.code_hash = patch.codeHash
      if (patch.testStatus !== undefined) set.test_status = patch.testStatus
      if (patch.confidence !== undefined) set.confidence = patch.confidence
      const r = yield* db
        .update(GraphNodeTable)
        .set(set)
        .where(eq(GraphNodeTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!r) return yield* new NotFoundError({ kind: "node", id })
    })

    const nodeDelete = Effect.fn("GraphStorage.node.delete")(function* (id: NodeID) {
      yield* db.delete(GraphNodeTable).where(eq(GraphNodeTable.id, id)).run().pipe(Effect.orDie)
    })

    const nodeList = Effect.fn("GraphStorage.node.list")(function* (filter: NodeFilter) {
      const conds = [eq(GraphNodeTable.project_id, filter.projectID)]
      if (filter.sessionID !== undefined) conds.push(eq(GraphNodeTable.session_id, filter.sessionID))
      if (filter.type !== undefined) conds.push(eq(GraphNodeTable.type, filter.type))
      if (filter.status !== undefined) conds.push(eq(GraphNodeTable.status, filter.status))
      const rows = yield* db.select().from(GraphNodeTable).where(and(...conds)).all().pipe(Effect.orDie)
      return rows.map(nodeRow)
    })

    return Service.of({
      node: { create: nodeCreate, get: nodeGet, update: nodeUpdate, delete: nodeDelete, list: nodeList },
    } as any)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
