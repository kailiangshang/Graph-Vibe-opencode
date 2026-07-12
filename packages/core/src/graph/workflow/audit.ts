export * as GraphAudit from "./audit"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../../database/database"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import type { NodeID } from "../storage"
import { GraphGenerationRunTable, GraphToolRunTable } from "./audit.sql"
import type { GenerationExecutor, GenerationRunStatus, ToolRunStatus, ToolRunType } from "./audit.sql"
import type { GateResult } from "./gate"
import type { ToolEvidence } from "@opencode-ai/schema/graph"

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
  readonly evidence: ToolEvidence | null
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
  readonly evidence?: ToolEvidence
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
  evidence: row.evidence,
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
          input_summary: input.inputSummary?.slice(0, 1_024) ?? null,
          output_summary: input.outputSummary?.slice(0, 1_024) ?? null,
          status: input.status,
          error: input.error?.slice(0, 1_024) ?? null,
          evidence: input.evidence ? sanitizeEvidence(input.evidence) : null,
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
        .orderBy(asc(GraphToolRunTable.time_created), asc(GraphToolRunTable.id))
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
        .orderBy(asc(GraphGenerationRunTable.time_created), asc(GraphGenerationRunTable.id))
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

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.layerFromPath(Database.path())))

export function sanitizeEvidence(evidence: ToolEvidence): ToolEvidence {
  const artifactPaths = boundedPaths(evidence.artifactPaths)
  if (evidence.kind === "artifact") return { ...evidence, nodeID: evidence.nodeID.slice(0, 1_024), artifactPaths }
  return {
    ...evidence,
    nodeID: evidence.nodeID.slice(0, 1_024),
    criteria: evidence.criteria.slice(0, 64).map((criterion) => criterion.slice(0, 1_024)),
    artifactPaths,
    commands: evidence.commands.slice(0, 32).map((command) => ({
      ...command,
      name: command.name.slice(0, 128),
      command: command.command.slice(0, 2_048),
      ...(command.excerpt === undefined ? {} : { excerpt: redact(command.excerpt).slice(0, 8_192) }),
    })),
  }
}

function boundedPaths(paths: ReadonlyArray<string>) {
  return paths.slice(0, 256).map((item) => item.slice(0, 1_024)).reduce(
    (result, item) => JSON.stringify([...result, item]).length <= 16_384 ? [...result, item] : result,
    [] as string[],
  )
}

function redact(value: string) {
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && (secret?.length ?? 0) >= 4)
    .flatMap(([, secret]) => secret ? [secret] : [])
  return secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value)
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
}
