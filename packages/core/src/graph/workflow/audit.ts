export * as GraphAudit from "./audit"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../../database/database"
import type { ProjectV2 } from "../../project"
import type { NodeID } from "../storage"
import { GraphGenerationRunTable, GraphToolRunTable } from "./audit.sql"
import type { GenerationExecutor, GenerationRunStatus, ToolRunStatus, ToolRunType } from "./audit.sql"
import type { GateResult } from "./gate"

export type ToolRunID = string & { readonly "GraphToolRun.ID": unique symbol }
export type GenerationRunID = string & { readonly "GraphGenerationRun.ID": unique symbol }

export interface ToolRun {
  readonly id: ToolRunID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string | null
  readonly nodeID: NodeID | null
  readonly toolName: string
  readonly toolType: ToolRunType
  readonly inputSummary: string | null
  readonly outputSummary: string | null
  readonly status: ToolRunStatus
  readonly error: string | null
  readonly timeCreated: number
}

export interface GenerationRun {
  readonly id: GenerationRunID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string | null
  readonly nodeID: NodeID
  readonly executor: GenerationExecutor
  readonly backend: string | null
  readonly model: string | null
  readonly contextSnapshotHash: string | null
  readonly status: GenerationRunStatus
  readonly gateResult: GateResult
  readonly artifactSummary: string | null
  readonly diagnosticsSummary: string | null
  readonly timeCreated: number
}

export interface ToolRunCreate {
  readonly projectID: ProjectV2.ID
  readonly sessionID?: string
  readonly nodeID?: NodeID
  readonly toolName: string
  readonly toolType: ToolRunType
  readonly inputSummary?: string
  readonly outputSummary?: string
  readonly status: ToolRunStatus
  readonly error?: string
}

export interface GenerationRunCreate {
  readonly projectID: ProjectV2.ID
  readonly sessionID?: string
  readonly nodeID: NodeID
  readonly executor: GenerationExecutor
  readonly backend?: string
  readonly model?: string
  readonly contextSnapshotHash?: string
  readonly status: GenerationRunStatus
  readonly gateResult: GateResult
  readonly artifactSummary?: string
  readonly diagnosticsSummary?: string
}

export interface AuditFilter {
  readonly projectID: ProjectV2.ID
  readonly sessionID?: string
  readonly nodeID?: NodeID
}

export interface Interface {
  readonly tool: {
    readonly record: (input: ToolRunCreate) => Effect.Effect<ToolRunID>
    readonly list: (input: AuditFilter) => Effect.Effect<ReadonlyArray<ToolRun>>
  }
  readonly generation: {
    readonly record: (input: GenerationRunCreate) => Effect.Effect<GenerationRunID>
    readonly list: (input: AuditFilter) => Effect.Effect<ReadonlyArray<GenerationRun>>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphAudit") {}

const toolRunID = () => `gtr_${crypto.randomUUID()}` as ToolRunID
const generationRunID = () => `ggr_${crypto.randomUUID()}` as GenerationRunID

const toolRun = (row: typeof GraphToolRunTable.$inferSelect): ToolRun => ({
  id: row.id as ToolRunID,
  projectID: row.project_id,
  sessionID: row.session_id,
  nodeID: row.node_id,
  toolName: row.tool_name,
  toolType: row.tool_type,
  inputSummary: row.input_summary,
  outputSummary: row.output_summary,
  status: row.status,
  error: row.error,
  timeCreated: row.time_created,
})

const generationRun = (row: typeof GraphGenerationRunTable.$inferSelect): GenerationRun => ({
  id: row.id as GenerationRunID,
  projectID: row.project_id,
  sessionID: row.session_id,
  nodeID: row.node_id,
  executor: row.executor,
  backend: row.backend,
  model: row.model,
  contextSnapshotHash: row.context_snapshot_hash,
  status: row.status,
  gateResult: row.gate_result,
  artifactSummary: row.artifact_summary,
  diagnosticsSummary: row.diagnostics_summary,
  timeCreated: row.time_created,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const toolRecord = Effect.fn("GraphAudit.tool.record")(function* (input: ToolRunCreate) {
      const id = toolRunID()
      yield* db
        .insert(GraphToolRunTable)
        .values({
          id,
          project_id: input.projectID,
          session_id: input.sessionID ?? null,
          node_id: input.nodeID ?? null,
          tool_name: input.toolName,
          tool_type: input.toolType,
          input_summary: input.inputSummary ?? null,
          output_summary: input.outputSummary ?? null,
          status: input.status,
          error: input.error ?? null,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const toolList = Effect.fn("GraphAudit.tool.list")(function* (input: AuditFilter) {
      const conds = [eq(GraphToolRunTable.project_id, input.projectID)]
      if (input.sessionID !== undefined) conds.push(eq(GraphToolRunTable.session_id, input.sessionID))
      if (input.nodeID !== undefined) conds.push(eq(GraphToolRunTable.node_id, input.nodeID))
      const rows = yield* db
        .select()
        .from(GraphToolRunTable)
        .where(and(...conds))
        .orderBy(asc(GraphToolRunTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toolRun)
    })

    const generationRecord = Effect.fn("GraphAudit.generation.record")(function* (input: GenerationRunCreate) {
      const id = generationRunID()
      yield* db
        .insert(GraphGenerationRunTable)
        .values({
          id,
          project_id: input.projectID,
          session_id: input.sessionID ?? null,
          node_id: input.nodeID,
          executor: input.executor,
          backend: input.backend ?? null,
          model: input.model ?? null,
          context_snapshot_hash: input.contextSnapshotHash ?? null,
          status: input.status,
          gate_result: input.gateResult,
          artifact_summary: input.artifactSummary ?? null,
          diagnostics_summary: input.diagnosticsSummary ?? null,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const generationList = Effect.fn("GraphAudit.generation.list")(function* (input: AuditFilter) {
      const conds = [eq(GraphGenerationRunTable.project_id, input.projectID)]
      if (input.sessionID !== undefined) conds.push(eq(GraphGenerationRunTable.session_id, input.sessionID))
      if (input.nodeID !== undefined) conds.push(eq(GraphGenerationRunTable.node_id, input.nodeID))
      const rows = yield* db
        .select()
        .from(GraphGenerationRunTable)
        .where(and(...conds))
        .orderBy(asc(GraphGenerationRunTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(generationRun)
    })

    return Service.of({
      tool: { record: toolRecord, list: toolList },
      generation: { record: generationRecord, list: generationList },
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.layerFromPath(Database.path())))
