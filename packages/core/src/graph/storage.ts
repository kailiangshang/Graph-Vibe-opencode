export * as GraphStorage from "./storage"

import { and, desc, eq, isNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { ProjectV2 } from "../project"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { GraphNodeTable, GraphEdgeTable, GraphVersionTable } from "./sql"
import { GraphHash } from "./hash"
import { Graph } from "@opencode-ai/schema/graph"
import type {
  NodeType,
  Level,
  Priority,
  NodeStatus,
  TestStatus,
  EdgeRelation,
  NodeContent,
  VerificationSpec,
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

export class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "GraphV2.SnapshotDecodeError",
  { message: Schema.String },
) {}

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
  readonly verification: VerificationSpec | null
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

export interface SessionPlanView extends GraphView {
  readonly source: "currentPlan" | "version"
  readonly versionNumber: number | null
  readonly publishedAt: number | null
  readonly planHash: string
}

export interface SessionVersion extends Omit<VersionRow, "snapshot"> {
  readonly snapshot: GraphView
}

const CanonicalNodeRow = Schema.Struct({
  id: NodeID,
  projectID: ProjectV2.ID,
  sessionID: Schema.NullOr(Schema.String),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Schema.NullOr(Graph.Priority),
  category: Schema.NullOr(Schema.String),
  status: Graph.NodeStatus,
  desc: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Graph.NodeContent),
  verification: Schema.NullOr(Graph.VerificationSpec),
  codeHash: Schema.NullOr(Schema.String),
  testStatus: Graph.TestStatus,
  confidence: Schema.Number,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})

const PersistedNodeRow = Schema.Struct({
  id: NodeID,
  project_id: ProjectV2.ID,
  session_id: Schema.NullOr(Schema.String),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Schema.NullOr(Graph.Priority),
  category: Schema.NullOr(Schema.String),
  status: Graph.NodeStatus,
  desc: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Graph.NodeContent),
  verification: Schema.NullOr(Graph.VerificationSpec),
  code_hash: Schema.NullOr(Schema.String),
  test_status: Graph.TestStatus,
  confidence: Schema.Number,
  time_created: Schema.Number,
  time_updated: Schema.Number,
})

const CanonicalEdgeRow = Schema.Struct({
  id: EdgeID,
  projectID: ProjectV2.ID,
  sessionID: Schema.NullOr(Schema.String),
  sourceID: NodeID,
  targetID: NodeID,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number,
  timeCreated: Schema.Number,
})

const PersistedEdgeRow = Schema.Struct({
  id: EdgeID,
  project_id: ProjectV2.ID,
  session_id: Schema.NullOr(Schema.String),
  source_id: NodeID,
  target_id: NodeID,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number,
  time_created: Schema.Number,
})

const Snapshot = Schema.Struct({
  nodes: Schema.Array(Schema.Union([CanonicalNodeRow, PersistedNodeRow])),
  edges: Schema.Array(Schema.Union([CanonicalEdgeRow, PersistedEdgeRow])),
})

const SessionEnhancementMetadata = Schema.Struct({
  productMigration: Schema.Struct({
    graphEnhancement: Schema.Struct({ id: Schema.String, versionID: VersionID }),
  }),
})
const sessionEnhancementMetadata = Schema.decodeUnknownOption(SessionEnhancementMetadata)

function migrationEnhancementVersionID(sessionID: string, metadata: unknown) {
  const decoded = sessionEnhancementMetadata(metadata)
  if (Option.isNone(decoded)) return undefined
  const enhancement = decoded.value.productMigration.graphEnhancement
  if (enhancement.id !== deterministicMigrationID("geh", sessionID)) return undefined
  if (enhancement.versionID !== deterministicMigrationID("gvr", enhancement.id)) return undefined
  return enhancement.versionID
}

function deterministicMigrationID(prefix: "geh" | "gvr", identity: string) {
  return `${prefix}_${new Bun.CryptoHasher("sha256").update(`${prefix}\0${identity}`).digest("hex")}`
}

export const NodeCreate = Schema.Struct({
  projectID: ProjectV2.ID,
  sessionID: Schema.String.pipe(Schema.optional),
  id: Schema.String.pipe(Schema.optional),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Graph.Priority.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  status: Graph.NodeStatus.pipe(Schema.optional),
  desc: Schema.String.pipe(Schema.optional),
  content: Graph.NodeContent.pipe(Schema.optional),
  verification: Graph.VerificationSpec.pipe(Schema.optional),
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
  verification: Graph.VerificationSpec.pipe(Schema.optional),
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
  id: Schema.String.pipe(Schema.optional),
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
  expectedRevision: Schema.Number.pipe(Schema.optional),
  expectedPlanHash: Schema.String.pipe(Schema.optional),
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
  readonly planView: (input: { projectID: ProjectV2.ID; sessionID: string }) => Effect.Effect<SessionPlanView, SnapshotDecodeError>
  readonly promote: (input: PromoteInput) => Effect.Effect<PromoteResult>
  readonly version: {
    readonly list: (input: { projectID: ProjectV2.ID }) => Effect.Effect<ReadonlyArray<VersionRow>>
    readonly get: (input: { projectID: ProjectV2.ID; versionNumber: number }) => Effect.Effect<VersionRow, NotFoundError>
    readonly latestForSession: (input: {
      projectID: ProjectV2.ID
      sessionID: string
    }) => Effect.Effect<SessionVersion | undefined, SnapshotDecodeError>
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
  verification: r.verification,
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

const decodeSnapshot = (input: unknown): Effect.Effect<GraphView, SnapshotDecodeError> =>
  Schema.decodeUnknownEffect(Snapshot)(input).pipe(
    Effect.map((snapshot) => ({
      nodes: snapshot.nodes.map((row): NodeRow => "project_id" in row ? {
        id: row.id,
        projectID: row.project_id,
        sessionID: row.session_id,
        type: row.type,
        name: row.name,
        level: row.level,
        priority: row.priority,
        category: row.category,
        status: row.status,
        desc: row.desc,
        content: row.content,
        verification: row.verification,
        codeHash: row.code_hash,
        testStatus: row.test_status,
        confidence: row.confidence,
        timeCreated: row.time_created,
        timeUpdated: row.time_updated,
      } : row),
      edges: snapshot.edges.map((row): EdgeRow => "project_id" in row ? {
        id: row.id,
        projectID: row.project_id,
        sessionID: row.session_id,
        sourceID: row.source_id,
        targetID: row.target_id,
        relation: row.relation,
        confidence: row.confidence,
        timeCreated: row.time_created,
      } : row),
    })),
    Effect.mapError((cause) => new SnapshotDecodeError({ message: String(cause) })),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const nodeCreate = Effect.fn("GraphStorage.node.create")(function* (input: NodeCreate) {
      const id = (input.id ?? NodeID.create()) as NodeID
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
          verification: input.verification ?? null,
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
      if (patch.verification !== undefined) set.verification = patch.verification
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

    const edgeCreate = Effect.fn("GraphStorage.edge.create")(function* (input: EdgeCreate) {
      const id = (input.id ?? EdgeID.create()) as EdgeID
      yield* db
        .insert(GraphEdgeTable)
        .values({
          id,
          project_id: input.projectID,
          session_id: input.sessionID ?? null,
          source_id: input.sourceID,
          target_id: input.targetID,
          relation: input.relation,
          confidence: input.confidence ?? 1,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const edgeGet = Effect.fn("GraphStorage.edge.get")(function* (id: EdgeID) {
      const r = yield* db.select().from(GraphEdgeTable).where(eq(GraphEdgeTable.id, id)).get().pipe(Effect.orDie)
      if (!r) return yield* new NotFoundError({ kind: "edge", id })
      return edgeRow(r)
    })

    const edgeDelete = Effect.fn("GraphStorage.edge.delete")(function* (id: EdgeID) {
      yield* db.delete(GraphEdgeTable).where(eq(GraphEdgeTable.id, id)).run().pipe(Effect.orDie)
    })

    const edgeList = Effect.fn("GraphStorage.edge.list")(function* (filter: EdgeFilter) {
      const conds = [eq(GraphEdgeTable.project_id, filter.projectID)]
      if (filter.sessionID !== undefined) conds.push(eq(GraphEdgeTable.session_id, filter.sessionID))
      if (filter.sourceID !== undefined) conds.push(eq(GraphEdgeTable.source_id, filter.sourceID))
      if (filter.targetID !== undefined) conds.push(eq(GraphEdgeTable.target_id, filter.targetID))
      if (filter.relation !== undefined) conds.push(eq(GraphEdgeTable.relation, filter.relation))
      const rows = yield* db.select().from(GraphEdgeTable).where(and(...conds)).all().pipe(Effect.orDie)
      return rows.map(edgeRow)
    })

    const main = Effect.fn("GraphStorage.main")(function* (input: { projectID: ProjectV2.ID }) {
      const nodes = yield* db
        .select()
        .from(GraphNodeTable)
        .where(and(eq(GraphNodeTable.project_id, input.projectID), isNull(GraphNodeTable.session_id)))
        .all()
        .pipe(Effect.orDie)
      const edges = yield* db
        .select()
        .from(GraphEdgeTable)
        .where(and(eq(GraphEdgeTable.project_id, input.projectID), isNull(GraphEdgeTable.session_id)))
        .all()
        .pipe(Effect.orDie)
      return { nodes: nodes.map(nodeRow), edges: edges.map(edgeRow) }
    })

    const currentPlan = Effect.fn("GraphStorage.currentPlan")(function* (input: { sessionID: string }) {
      const nodes = yield* db
        .select()
        .from(GraphNodeTable)
        .where(eq(GraphNodeTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      const edges = yield* db
        .select()
        .from(GraphEdgeTable)
        .where(eq(GraphEdgeTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      return { nodes: nodes.map(nodeRow), edges: edges.map(edgeRow) }
    })

    const promote = Effect.fn("GraphStorage.promote")(function* (input: PromoteInput) {
      return yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              const planNodes = yield* db
                .select()
                .from(GraphNodeTable)
                .where(and(eq(GraphNodeTable.project_id, input.projectID), eq(GraphNodeTable.session_id, input.sessionID)))
                .all()
                .pipe(Effect.orDie)
              const planEdges = yield* db
                .select()
                .from(GraphEdgeTable)
                .where(and(eq(GraphEdgeTable.project_id, input.projectID), eq(GraphEdgeTable.session_id, input.sessionID)))
                .all()
                .pipe(Effect.orDie)

              if (planNodes.length > 0) {
                yield* db
                  .update(GraphNodeTable)
                  .set({ session_id: null })
                  .where(eq(GraphNodeTable.session_id, input.sessionID))
                  .run()
                  .pipe(Effect.orDie)
              }
              if (planEdges.length > 0) {
                yield* db
                  .update(GraphEdgeTable)
                  .set({ session_id: null })
                  .where(eq(GraphEdgeTable.session_id, input.sessionID))
                  .run()
                  .pipe(Effect.orDie)
              }

              const maxRow = yield* db
                .select()
                .from(GraphVersionTable)
                .where(eq(GraphVersionTable.project_id, input.projectID))
                .all()
                .pipe(Effect.orDie)
              const versionNumber = maxRow.reduce((m, r) => Math.max(m, r.version_number), 0) + 1
              const versionID = VersionID.create()
              yield* db
                .insert(GraphVersionTable)
                .values({
                  id: versionID,
                  project_id: input.projectID,
                  session_id: input.sessionID,
                  version_number: versionNumber,
                  message: input.message ?? null,
                  snapshot: { nodes: planNodes, edges: planEdges },
                })
                .run()
                .pipe(Effect.orDie)

              return {
                versionID,
                versionNumber,
                nodes: planNodes.length,
                edges: planEdges.length,
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const versionList = Effect.fn("GraphStorage.version.list")(function* (input: { projectID: ProjectV2.ID }) {
      const rows = yield* db
        .select()
        .from(GraphVersionTable)
        .where(eq(GraphVersionTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      return rows.map(versionRow)
    })

    const versionGet = Effect.fn("GraphStorage.version.get")(function* (input: {
      projectID: ProjectV2.ID
      versionNumber: number
    }) {
      const r = yield* db
        .select()
        .from(GraphVersionTable)
        .where(and(eq(GraphVersionTable.project_id, input.projectID), eq(GraphVersionTable.version_number, input.versionNumber)))
        .get()
        .pipe(Effect.orDie)
      if (!r) return yield* new NotFoundError({ kind: "version", id: String(input.versionNumber) })
      return versionRow(r)
    })

    const versionLatestForSession = Effect.fn("GraphStorage.version.latestForSession")(function* (input: {
      projectID: ProjectV2.ID
      sessionID: string
    }) {
      const session = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(and(
          eq(SessionTable.id, SessionSchema.ID.make(input.sessionID)),
          eq(SessionTable.project_id, input.projectID),
        ))
        .get()
        .pipe(Effect.orDie)
      const enhancementVersionID = migrationEnhancementVersionID(input.sessionID, session?.metadata)
      const r = yield* db
        .select()
        .from(GraphVersionTable)
        .where(and(
          eq(GraphVersionTable.project_id, input.projectID),
          eq(GraphVersionTable.session_id, input.sessionID),
          ...(enhancementVersionID
            ? [or(ne(GraphVersionTable.id, enhancementVersionID), ne(GraphVersionTable.time_created, 0))]
            : []),
        ))
        .orderBy(desc(GraphVersionTable.version_number))
        .get()
        .pipe(Effect.orDie)
      if (!r) return undefined
      return { ...versionRow(r), snapshot: yield* decodeSnapshot(r.snapshot) }
    })

    const planView = Effect.fn("GraphStorage.planView")(function* (input: {
      projectID: ProjectV2.ID
      sessionID: string
    }) {
      const nodes = yield* nodeList({ projectID: input.projectID, sessionID: input.sessionID })
      if (nodes.length > 0) {
        const edges = yield* edgeList({ projectID: input.projectID, sessionID: input.sessionID })
        return {
          nodes,
          edges,
          source: "currentPlan" as const,
          versionNumber: null,
          publishedAt: null,
          planHash: GraphHash.digest({ nodes, edges }),
        }
      }
      const version = yield* versionLatestForSession(input)
      if (version) {
        return {
          ...version.snapshot,
          source: "version" as const,
          versionNumber: version.versionNumber,
          publishedAt: version.timeCreated,
          planHash: GraphHash.digest(version.snapshot),
        }
      }
      const graph = { nodes: [], edges: [] }
      return {
        ...graph,
        source: "currentPlan" as const,
        versionNumber: null,
        publishedAt: null,
        planHash: GraphHash.digest(graph),
      }
    })

    return Service.of({
      node: { create: nodeCreate, get: nodeGet, update: nodeUpdate, delete: nodeDelete, list: nodeList },
      edge: { create: edgeCreate, get: edgeGet, delete: edgeDelete, list: edgeList },
      main,
      currentPlan,
      planView,
      promote,
      version: { list: versionList, get: versionGet, latestForSession: versionLatestForSession },
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.layerFromPath(Database.path())))
