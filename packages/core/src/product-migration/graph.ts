export * as ProductMigrationGraph from "./graph"

import { createHash, randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LLM, Message, SystemPart } from "@opencode-ai/llm"
import { Graph } from "@opencode-ai/schema/graph"
import { Model } from "@opencode-ai/schema/model"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { ProductMigrationSnapshot } from "./snapshot"
import { ProductMigrationSource } from "./source"

type DatabaseService = Database.Interface["db"]
type QueryDatabase = Pick<DatabaseService, "all" | "get" | "run">
type Row = Record<string, unknown>

export interface ImportInput {
  readonly migrationID: string
  readonly sourceDatabase: string
  readonly snapshotDirectory?: string
  readonly snapshot?: ProductMigrationSnapshot.Snapshot
  readonly sourceSessionIDs: ReadonlyArray<string>
  readonly sourceFingerprint?: string
  readonly databaseFingerprint: string
}

export interface ImportedGraph {
  readonly sourceSessionID: string
  readonly targetSessionID: string
  readonly strategy: "legacy" | "reconstructed"
  readonly status: "ready" | "needs_attention"
  readonly versionID: string
  readonly nodeCount: number
  readonly edgeCount: number
}

export interface ImportResult {
  readonly sessions: ReadonlyArray<ImportedGraph>
}

export interface QueueEnhancementInput {
  readonly migrationID: string
  readonly sourceSessionID: string
}

export interface EnhancementRequest {
  readonly enhancementID: string
  readonly targetSessionID: string
  readonly model: Model.Ref | undefined
  readonly sourceMessageIDs: ReadonlyArray<string>
  readonly bounds: { readonly maxMessages: number; readonly maxBytes: number }
  readonly truncation: {
    readonly truncated: boolean
    readonly availableMessages: number
    readonly selectedMessages: number
    readonly selectedBytes: number
  }
  readonly request: Omit<LLM.RequestInput, "model">
}

export interface EnhancementFact {
  readonly sourceMessageIDs: ReadonlyArray<string>
  readonly confidence: number
}

export interface ApplyEnhancementInput {
  readonly enhancementID: string
  readonly model: Model.Ref
  readonly goal?: EnhancementFact & { readonly text: string }
  readonly modules: ReadonlyArray<
    EnhancementFact & { readonly name: string; readonly taskSourceIDs: ReadonlyArray<string> }
  >
  readonly dependencies: ReadonlyArray<
    EnhancementFact & { readonly sourceTaskID: string; readonly targetTaskID: string }
  >
}

export interface EnhancementResult {
  readonly versionID: string
  readonly versionNumber: number
  readonly replaced: boolean
}

interface MappingContext {
  readonly migrationID: string
  readonly sourceFingerprint: string
}

interface TargetSession {
  readonly sourceID: string
  readonly targetID: string
  readonly projectID: string
  readonly metadata: Row
  readonly model: Model.Ref | undefined
}

interface LegacyGraph {
  readonly nodes: ReadonlyArray<Row>
  readonly edges: ReadonlyArray<Row>
  readonly versions: ReadonlyArray<Row>
  readonly evidence: ReadonlyArray<Row>
  readonly workflow: Row | undefined
  readonly drafts: ReadonlyArray<Row>
  readonly generations: ReadonlyArray<Row>
}

interface SourceGraphSnapshot {
  readonly known: boolean
  readonly sessions: ReadonlyMap<string, LegacyGraph | undefined>
  readonly sessionCount: number
  readonly versionNumbers: ReadonlyMap<string, number>
  readonly warnings: ReadonlyMap<string, ReadonlyArray<string>>
}

interface NormalizedNode {
  readonly sourceID: string
  readonly id: string
  readonly projectID: string
  readonly sessionID: string
  readonly type: Graph.NodeType
  readonly name: string
  readonly level: Graph.Level
  readonly priority: Graph.Priority | null
  readonly category: string | null
  readonly status: Graph.NodeStatus
  readonly desc: string | null
  readonly content: Row
  readonly verification: Graph.VerificationSpec | null
  readonly codeHash: string | null
  readonly testStatus: Graph.TestStatus
  readonly confidence: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

interface NormalizedEdge {
  readonly sourceID: string
  readonly id: string
  readonly projectID: string
  readonly sessionID: string
  readonly sourceNodeID: string
  readonly targetNodeID: string
  readonly relation: Graph.EdgeRelation
  readonly confidence: number
  readonly timeCreated: number
}

interface NormalizedEvidence {
  readonly sourceID: string
  readonly id: string
  readonly nodeID: string | null
  readonly toolName: string
  readonly toolType: "graph" | "local" | "mcp" | "permission" | "artifact" | "diagnostics"
  readonly inputSummary: string | null
  readonly outputSummary: string | null
  readonly status: "succeeded" | "failed" | "blocked" | "dry_run"
  readonly error: string | null
  readonly evidence: Graph.ToolEvidence | null
  readonly timeCreated: number
}

interface ReconstructedNode {
  readonly sourceID: string
  readonly id: string
  readonly type: Graph.NodeType
  readonly name: string
  readonly level: Graph.Level
  readonly verification: Graph.VerificationSpec | null
  readonly content: Row
  readonly confidence: number
}

interface ReconstructedEdge {
  readonly sourceID: string
  readonly id: string
  readonly sourceNodeID: string
  readonly targetNodeID: string
  readonly relation: Graph.EdgeRelation
  readonly confidence: number
}

interface HistoryEntry {
  readonly id: string
  readonly targetID: string
  readonly type: string
  readonly text: string
  readonly seq: number
}

interface ExtractedFact {
  readonly value: string
  readonly messageID: string
}

interface ExtractedTask extends ExtractedFact {
  readonly sourceID: string
  readonly seq: number
  readonly artifactPaths: string[]
  readonly diagnostics: Array<{
    readonly name: Graph.DiagnosticName
    readonly command: string
    readonly paths: string[]
  }>
}

export class ImportError extends Schema.TaggedErrorClass<ImportError>()("ProductMigrationGraphImportError", {
  operation: Schema.String,
  sourceID: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation}${this.sourceID ? ` ${this.sourceID}` : ""}: ${detail}`
  }
}

export interface Interface {
  readonly import: (input: ImportInput) => Effect.Effect<ImportResult, ImportError>
  readonly queueEnhancement: (input: QueueEnhancementInput) => Effect.Effect<EnhancementRequest, ImportError>
  readonly applyEnhancement: (input: ApplyEnhancementInput) => Effect.Effect<EnhancementResult, ImportError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationGraph") {}

const nodeType = Schema.decodeUnknownOption(Graph.NodeType)
const level = Schema.decodeUnknownOption(Graph.Level)
const priority = Schema.decodeUnknownOption(Graph.Priority)
const nodeStatus = Schema.decodeUnknownOption(Graph.NodeStatus)
const testStatus = Schema.decodeUnknownOption(Graph.TestStatus)
const edgeRelation = Schema.decodeUnknownOption(Graph.EdgeRelation)
const verification = Schema.decodeUnknownOption(Graph.VerificationSpec)
const evidence = Schema.decodeUnknownOption(Graph.ToolEvidence)
const modelRef = Schema.decodeUnknownOption(Model.Ref)
const relativePath = Schema.decodeUnknownOption(Graph.RelativePath)
const executionMode = Schema.decodeUnknownOption(Graph.ExecutionMode)
const checkpointKind = Schema.decodeUnknownOption(Graph.CheckpointKind)
const checkpointStatus = Schema.decodeUnknownOption(Graph.CheckpointStatus)

const Confidence = Schema.Number.check(
  Schema.makeFilter((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
    expected: "a confidence between 0 and 1",
  }),
)
const EnhancementText = Schema.String.check(Schema.isMaxLength(1_024))
const EnhancementID = Schema.String.check(Schema.isMaxLength(256))
const EnhancementFactSchema = Schema.Struct({
  sourceMessageIDs: Schema.Array(EnhancementID).check(Schema.isMaxLength(64)),
  confidence: Confidence,
})
const ApplyEnhancementSchema = Schema.Struct({
  enhancementID: EnhancementID,
  model: Model.Ref,
  goal: Schema.optional(Schema.Struct({ ...EnhancementFactSchema.fields, text: EnhancementText })),
  modules: Schema.Array(
    Schema.Struct({
      ...EnhancementFactSchema.fields,
      name: EnhancementText,
      taskSourceIDs: Schema.Array(EnhancementID).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(64)),
  dependencies: Schema.Array(
    Schema.Struct({
      ...EnhancementFactSchema.fields,
      sourceTaskID: EnhancementID,
      targetTaskID: EnhancementID,
    }),
  ).check(Schema.isMaxLength(256)),
})
const QueuedEnhancementSchema = Schema.Struct({
  id: EnhancementID,
  versionID: EnhancementID,
  model: Schema.NullOr(Model.Ref),
  request: Schema.Unknown,
  messages: Schema.Array(
    Schema.Struct({ sourceID: EnhancementID, targetID: EnhancementID }),
  ).check(Schema.isMaxLength(64)),
  bounds: Schema.Struct({ maxMessages: Schema.Number, maxBytes: Schema.Number }),
  truncation: Schema.Struct({
    truncated: Schema.Boolean,
    availableMessages: Schema.Number,
    selectedMessages: Schema.Number,
    selectedBytes: Schema.Number,
  }),
})

const ENHANCEMENT_MAX_MESSAGES = 64
const ENHANCEMENT_MAX_BYTES = 65_536
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024

class SnapshotLimitError extends Error {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sqlite = yield* Effect.promise(() => import("bun:sqlite"))

    const importGraph = Effect.fn("ProductMigrationGraph.import")(function* (input: ImportInput) {
      const journal = yield* migrationJournal(db, input.migrationID)
      const sourceDatabase = yield* canonicalSource(input.sourceDatabase)
      if (journal.sourcePath !== sourceDatabase) {
        return yield* new ImportError({
          operation: "verify migration source",
          sourceID: input.migrationID,
          cause: new Error("Migration journal source path does not match the canonical source database"),
        })
      }
      const readSnapshot = (copy: ProductMigrationSnapshot.Snapshot) =>
        readSourceGraphs(sqlite, copy.database, input.sourceSessionIDs).pipe(
          Effect.map((source) => ({ ...source, identity: copy.identity })),
        )
      const source = yield* (
        input.snapshot
          ? readSnapshot(input.snapshot)
          : ProductMigrationSnapshot.use({ database: sourceDatabase, directory: input.snapshotDirectory }, readSnapshot)
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof ImportError ? cause : new ImportError({ operation: "snapshot Graph source", cause }),
        ),
      )
      const sourceFingerprint = ProductMigrationSource.fingerprint({
        database: sourceDatabase,
        databaseBytes: source.identity.size,
        sessionCount: source.sessionCount,
        identity: source.identity,
      })
      if (!input.databaseFingerprint || input.databaseFingerprint !== sourceFingerprint) {
        return yield* new ImportError({
          operation: "verify migration source",
          sourceID: input.migrationID,
          cause: new Error("Migration source fingerprint changed"),
        })
      }
      const context = {
        migrationID: input.migrationID,
        sourceFingerprint: input.sourceFingerprint ?? journal.sourceFingerprint,
      }
      const versionNumbers = yield* targetVersionNumbers(db, context, source).pipe(
        Effect.mapError((cause) =>
          cause instanceof ImportError
            ? cause
            : new ImportError({ operation: "number imported Graph versions", sourceID: input.migrationID, cause }),
        ),
      )
      const requestedSessionIDs = [...new Set(input.sourceSessionIDs)]
      const importedSessions = yield* Effect.forEach(
        requestedSessionIDs.toSorted(
          (left, right) =>
            Number((source.sessions.get(right)?.versions.length ?? 0) > 0) -
            Number((source.sessions.get(left)?.versions.length ?? 0) > 0),
        ),
        (sourceSessionID) =>
          db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const target = yield* targetSession(tx, context, sourceSessionID)
                  const legacy = source.known ? source.sessions.get(sourceSessionID) : undefined
                  const imported = legacy
                    ? yield* importLegacy(tx, context, target, legacy, versionNumbers)
                    : yield* reconstruct(tx, context, target)
                  yield* Effect.forEach(
                    source.warnings.get(sourceSessionID) ?? [],
                    (warning) => writeMigrationWarning(tx, context, target, warning),
                    { discard: true },
                  )
                  const status = yield* updateSessionStatus(tx, target)
                  return { ...imported, status }
                }),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof ImportError
                  ? cause
                  : new ImportError({ operation: "import graph", sourceID: sourceSessionID, cause }),
              ),
            ),
        { concurrency: 1 },
      )
      const importedBySourceID = new Map(importedSessions.map((session) => [session.sourceSessionID, session]))
      const sessions = requestedSessionIDs.flatMap((sourceSessionID) => {
        const session = importedBySourceID.get(sourceSessionID)
        return session ? [session] : []
      })
      if (sessions.length !== requestedSessionIDs.length) {
        return yield* new ImportError({
          operation: "order imported Graph sessions",
          sourceID: input.migrationID,
          cause: new Error("An imported Graph session result is missing"),
        })
      }
      return { sessions }
    })

    const queueEnhancement = Effect.fn("ProductMigrationGraph.queueEnhancement")(
      function* (input: QueueEnhancementInput) {
        const journal = yield* migrationJournal(db, input.migrationID)
        const target = yield* targetSession(
          db,
          { migrationID: input.migrationID, sourceFingerprint: journal.sourceFingerprint },
          input.sourceSessionID,
        )
        const history = yield* copiedHistory(db, target.targetID)
        const available = history.filter(
          (entry) =>
            entry.type === "user" || entry.type === "shell" || (entry.type === "assistant" && useful(entry.text)),
        )
        const selected = boundedEnhancementHistory(available)
        const enhancementID = destinationID("geh", target.targetID)
        const request = {
          system: [
            SystemPart.make(
              "Analyze only the copied history supplied by Graph Vibe. Return structured goal, module, and dependency enrichment. Do not infer implementation or verification status and do not request secrets or execute commands.",
            ),
          ],
          messages: [
            Message.user(
              JSON.stringify(
                selected.entries.map((entry) => ({ source_message_id: entry.id, role: entry.type, text: entry.text })),
              ),
            ),
          ],
          tools: [],
          toolChoice: "none" as const,
          responseFormat: {
            type: "json" as const,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["modules", "dependencies"],
              properties: {
                goal: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text", "sourceMessageIDs", "confidence"],
                  properties: {
                    text: { type: "string" },
                    sourceMessageIDs: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                  },
                },
                modules: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "taskSourceIDs", "sourceMessageIDs", "confidence"],
                    properties: {
                      name: { type: "string" },
                      taskSourceIDs: { type: "array", items: { type: "string" } },
                      sourceMessageIDs: { type: "array", items: { type: "string" } },
                      confidence: { type: "number" },
                    },
                  },
                },
                dependencies: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["sourceTaskID", "targetTaskID", "sourceMessageIDs", "confidence"],
                    properties: {
                      sourceTaskID: { type: "string" },
                      targetTaskID: { type: "string" },
                      sourceMessageIDs: { type: "array", items: { type: "string" } },
                      confidence: { type: "number" },
                    },
                  },
                },
              },
            },
          },
          metadata: {
            purpose: "product-migration-graph-enhancement",
            enhancementID,
            sessionID: target.targetID,
            bounds: selected.bounds,
            truncation: selected.truncation,
          },
        } satisfies Omit<LLM.RequestInput, "model">
        const queued = {
          id: enhancementID,
          versionID: destinationID("gvr", enhancementID),
          model: target.model ?? null,
          request,
          messages: selected.entries.map((entry) => ({ sourceID: entry.id, targetID: entry.targetID })),
          bounds: selected.bounds,
          truncation: selected.truncation,
        }
        const metadata = {
          ...target.metadata,
          productMigration: {
            ...record(target.metadata.productMigration),
            graphEnhancement: queued,
          },
        }
        yield* db.run(sql`UPDATE session SET metadata = ${JSON.stringify(metadata)} WHERE id = ${target.targetID}`)
        return {
          enhancementID,
          targetSessionID: target.targetID,
          model: target.model,
          sourceMessageIDs: selected.entries.map((entry) => entry.id),
          bounds: selected.bounds,
          truncation: selected.truncation,
          request,
        }
      },
      Effect.mapError((cause) =>
        cause instanceof ImportError ? cause : new ImportError({ operation: "queue graph enhancement", cause }),
      ),
    )

    const applyEnhancement = Effect.fn("ProductMigrationGraph.applyEnhancement")(function* (
      raw: ApplyEnhancementInput,
    ) {
      const input = yield* Schema.decodeUnknownEffect(ApplyEnhancementSchema)(raw).pipe(
        Effect.mapError((cause) => new ImportError({ operation: "validate graph enhancement", cause })),
      )
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const target = yield* queuedEnhancement(tx, input.enhancementID)
              const graph = yield* currentGraph(tx, target.sessionID)
              const sourceNodes = new Map(
                graph.nodes.flatMap((node) => {
                  const sourceID = migrationContent(node.content).sourceID
                  return sourceID ? [[sourceID, node] as const] : []
                }),
              )
              const copiedMessages = new Set(
                (
                  yield* tx.all<{ id: string }>(sql`
                    SELECT id FROM session_message WHERE session_id = ${target.sessionID}
                  `)
                ).map((row) => row.id),
              )
              const missingCopiedMessage = target.queued.messages.find(
                (message) => !copiedMessages.has(message.targetID),
              )
              if (missingCopiedMessage) {
                return yield* new ImportError({
                  operation: "validate graph enhancement destination history",
                  sourceID: missingCopiedMessage.targetID,
                  cause: new Error("Queued destination message is missing"),
                })
              }
              const selectedSourceIDs = new Set(target.queued.messages.map((message) => message.sourceID))
              const facts = [...(input.goal ? [input.goal] : []), ...input.modules, ...input.dependencies]
              const unknownMessageID = facts
                .flatMap((fact) => fact.sourceMessageIDs)
                .find((sourceMessageID) => !selectedSourceIDs.has(sourceMessageID))
              if (unknownMessageID || facts.some((fact) => fact.sourceMessageIDs.length === 0)) {
                return yield* new ImportError({
                  operation: "validate graph enhancement provenance",
                  sourceID: unknownMessageID,
                  cause: new Error(
                    unknownMessageID
                      ? "Enhancement references history outside the queued subset"
                      : "Enhancement fact has no source messages",
                  ),
                })
              }
              const taskSourceIDs = new Set(
                [...sourceNodes.entries()].filter(([, node]) => node.type === "atomic").map(([sourceID]) => sourceID),
              )
              const unknownTaskID = [
                ...input.modules.flatMap((module) => module.taskSourceIDs),
                ...input.dependencies.flatMap((dependency) => [dependency.sourceTaskID, dependency.targetTaskID]),
              ].find((sourceID) => !taskSourceIDs.has(sourceID))
              if (unknownTaskID) {
                return yield* new ImportError({
                  operation: "validate graph enhancement task reference",
                  sourceID: unknownTaskID,
                  cause: new Error("Enhancement references an unknown deterministic task"),
                })
              }
              const nodes = graph.nodes.map((node) => {
                if (!input.goal || node.type !== "prd") return snapshotNode(node)
                return {
                  ...snapshotNode(node),
                  name: input.goal.text,
                  content: {
                    ...node.content,
                    migration: inferredProvenance(input.goal, input.model),
                  },
                }
              })
              const inferredNodes = yield* Effect.forEach(input.modules, (module, index) =>
                Effect.gen(function* () {
                  const sourceID = `enhancement:module:${input.enhancementID}:${index}`
                  return {
                    id: destinationID("gnd", sourceID),
                    project_id: target.projectID,
                    session_id: target.sessionID,
                    type: "composite" as const,
                    name: module.name,
                    level: "L1" as const,
                    priority: null,
                    category: null,
                    status: "pending" as const,
                    desc: null,
                    content: { migration: { ...inferredProvenance(module, input.model), source_id: sourceID } },
                    verification: null,
                    code_hash: null,
                    test_status: "none" as const,
                    confidence: boundedConfidence(module.confidence),
                    time_created: 0,
                    time_updated: 0,
                  }
                }),
              )
              const moduleEdges = yield* Effect.forEach(
                input.modules.flatMap((module, moduleIndex) =>
                  module.taskSourceIDs.map((taskSourceID) => ({ module, moduleIndex, taskSourceID })),
                ),
                (item, index) =>
                  Effect.gen(function* () {
                    const targetNode = sourceNodes.get(item.taskSourceID)
                    if (!targetNode) return undefined
                    const sourceID = `enhancement:contains:${input.enhancementID}:${item.moduleIndex}:${index}`
                    return {
                      id: destinationID("ged", sourceID),
                      project_id: target.projectID,
                      session_id: target.sessionID,
                      source_id: inferredNodes[item.moduleIndex]?.id ?? "",
                      target_id: targetNode.id,
                      relation: "contains" as const,
                      confidence: boundedConfidence(item.module.confidence),
                      time_created: 0,
                      content: { migration: inferredProvenance(item.module, input.model) },
                    }
                  }),
              )
              const dependencyEdges = yield* Effect.forEach(input.dependencies, (dependency, index) =>
                Effect.gen(function* () {
                  const sourceNode = sourceNodes.get(dependency.sourceTaskID)
                  const targetNode = sourceNodes.get(dependency.targetTaskID)
                  if (!sourceNode || !targetNode) return undefined
                  const sourceID = `enhancement:blocks:${input.enhancementID}:${index}`
                  return {
                    id: destinationID("ged", sourceID),
                    project_id: target.projectID,
                    session_id: target.sessionID,
                    source_id: sourceNode.id,
                    target_id: targetNode.id,
                    relation: "blocks" as const,
                    confidence: boundedConfidence(dependency.confidence),
                    time_created: 0,
                    content: { migration: inferredProvenance(dependency, input.model) },
                  }
                }),
              )
              const existing = yield* tx.get<{ version_number: number }>(sql`
                SELECT version_number FROM graph_version WHERE id = ${target.queued.versionID}
              `)
              const versionNumber = existing?.version_number ?? (yield* nextVersionNumber(tx, target.projectID))
              const snapshot = {
                nodes: [...nodes, ...inferredNodes],
                edges: [
                  ...graph.edges.map(snapshotEdge),
                  ...moduleEdges.filter((edge): edge is NonNullable<typeof edge> => edge !== undefined),
                  ...dependencyEdges.filter((edge): edge is NonNullable<typeof edge> => edge !== undefined),
                ],
              }
              yield* tx.run(sql`
                INSERT INTO graph_version
                  (id, project_id, session_id, version_number, message, snapshot, time_created)
                VALUES
                  (${target.queued.versionID}, ${target.projectID}, ${target.sessionID}, ${versionNumber},
                   ${`product-migration:enhancement:${input.enhancementID}`}, ${JSON.stringify(snapshot)}, 0)
                ON CONFLICT(id) DO UPDATE SET
                  message = excluded.message, snapshot = excluded.snapshot
              `)
              return { versionID: target.queued.versionID, versionNumber, replaced: existing !== undefined }
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ImportError
              ? cause
              : new ImportError({ operation: "apply graph enhancement", sourceID: raw.enhancementID, cause }),
          ),
        )
    })

    return Service.of({ import: importGraph, queueEnhancement, applyEnhancement })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

function migrationJournal(db: QueryDatabase, migrationID: string) {
  return Effect.gen(function* () {
    const row = yield* db.get<{ source_path: string | null; source_fingerprint: string | null }>(sql`
      SELECT source_path, source_fingerprint FROM product_migration WHERE id = ${migrationID}
    `)
    if (!row?.source_path || !row.source_fingerprint) {
      return yield* new ImportError({
        operation: "read migration journal",
        sourceID: migrationID,
        cause: new Error("Migration source identity is missing"),
      })
    }
    return { sourcePath: row.source_path, sourceFingerprint: row.source_fingerprint }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ImportError
        ? cause
        : new ImportError({ operation: "read migration journal", sourceID: migrationID, cause }),
    ),
  )
}

function canonicalSource(sourceDatabase: string) {
  return Effect.tryPromise({
    try: () => realpath(sourceDatabase),
    catch: (cause) => new ImportError({ operation: "resolve source database", sourceID: sourceDatabase, cause }),
  })
}

function readSourceGraphs(
  sqlite: typeof import("bun:sqlite"),
  snapshotDatabase: string,
  sourceSessionIDs: ReadonlyArray<string>,
) {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        return ProductMigrationSource.openReadTransaction(
          () => new sqlite.Database(snapshotDatabase, { readonly: true, strict: true }),
        )
      },
      catch: (cause) => new ImportError({ operation: "open read-only Graph source", cause }),
    }),
    (source) =>
      Effect.gen(function* () {
        const base = yield* Effect.try({
          try: () => {
            const tables = new Set(
              source
                .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map((row) => row.name),
            )
            const sessionCount = tables.has("session")
              ? (source.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0)
              : 0
            return { tables, sessionCount }
          },
          catch: (cause) => new ImportError({ operation: "read Graph source schema", cause }),
        })
        const incompatible = incompatibleGraphTables(source, base.tables)
        if (!knownGraphSchema(source, base.tables)) {
          const warning = incompatible.length > 0 ? [`Unsupported Graph table schema: ${incompatible.join(", ")}`] : []
          return {
            known: false,
            sessions: new Map(),
            sessionCount: base.sessionCount,
            versionNumbers: new Map(),
            warnings: new Map(sourceSessionIDs.map((sessionID) => [sessionID, warning])),
          } satisfies SourceGraphSnapshot
        }
        if (incompatible.length > 0) {
          const warning = [`Unsupported Graph table schema: ${incompatible.join(", ")}`]
          return {
            known: true,
            sessions: new Map(sourceSessionIDs.map((sessionID) => [sessionID, undefined])),
            sessionCount: base.sessionCount,
            versionNumbers: new Map(),
            warnings: new Map(sourceSessionIDs.map((sessionID) => [sessionID, warning])),
          } satisfies SourceGraphSnapshot
        }
        const entries = yield* Effect.forEach([...new Set(sourceSessionIDs)], (sessionID) =>
          Effect.try({
            try: () => {
              const graph = readLegacyGraph(source, base.tables, sessionID)
              validateLegacyGraph(graph)
              return graph
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.map((graph) => ({ graph: hasLegacyGraph(graph) ? graph : undefined, warnings: Array<string>() })),
            Effect.catch((cause) =>
              cause instanceof SnapshotLimitError
                ? Effect.fail(new ImportError({ operation: "read Graph source snapshot", sourceID: sessionID, cause }))
                : Effect.succeed({ graph: undefined, warnings: ["Corrupt Graph rows or snapshots"] }),
            ),
            Effect.map((result) => [sessionID, result] as const),
          ),
        )
        const sessions = new Map(entries.map(([sessionID, result]) => [sessionID, result.graph]))
        return {
          known: true,
          sessions,
          sessionCount: base.sessionCount,
          versionNumbers: orderedVersionNumbers(sessions),
          warnings: new Map(entries.map(([sessionID, result]) => [sessionID, result.warnings])),
        } satisfies SourceGraphSnapshot
      }),
    (source) => Effect.sync(() => source.close(false)),
  )
}

function knownGraphSchema(source: import("bun:sqlite").Database, tables: ReadonlySet<string>) {
  if (!tables.has("graph_node") || !tables.has("graph_edge")) return false
  return (
    compatibleTable(source, "graph_node", ["id", "project_id", "session_id", "type", "name", "level"]) &&
    compatibleTable(source, "graph_edge", ["id", "project_id", "session_id", "source_id", "target_id", "relation"])
  )
}

function incompatibleGraphTables(source: import("bun:sqlite").Database, tables: ReadonlySet<string>) {
  const requirements = [
    ["graph_node", ["id", "project_id", "session_id", "type", "name", "level"]],
    ["graph_edge", ["id", "project_id", "session_id", "source_id", "target_id", "relation"]],
    ["graph_version", ["id", "project_id", "session_id", "version_number", "snapshot", "time_created"]],
    [
      "graph_workflow_state",
      ["session_id", "project_id", "checkpoint_status", "revision", "time_created", "time_updated"],
    ],
    [
      "graph_artifact_draft",
      ["id", "project_id", "session_id", "node_id", "status", "test", "files", "time_created", "time_updated"],
    ],
    [
      "graph_tool_run",
      ["id", "project_id", "session_id", "node_id", "tool_name", "tool_type", "status", "time_created"],
    ],
    [
      "graph_generation_run",
      ["id", "project_id", "session_id", "node_id", "executor", "status", "gate_result", "time_created"],
    ],
  ] as const
  return requirements.flatMap(([table, columns]) =>
    tables.has(table) && !compatibleTable(source, table, columns) ? [table] : [],
  )
}

function readLegacyGraph(
  source: import("bun:sqlite").Database,
  tables: ReadonlySet<string>,
  sessionID: string,
): LegacyGraph {
  const bytes = [
    ["graph_node", 100_000],
    ["graph_edge", 500_000],
    ["graph_version", 10_000],
    ["graph_tool_run", 100_000],
    ["graph_workflow_state", 1],
    ["graph_artifact_draft", 10_000],
    ["graph_generation_run", 100_000],
  ] as const
  const payloadBytes = bytes
    .flatMap(([table, maxRows]) => (tables.has(table) ? [sourceBounds(source, table, sessionID, maxRows)] : []))
    .reduce((total, bound) => total + bound.bytes, 0)
  if (payloadBytes > SNAPSHOT_MAX_BYTES) {
    throw new SnapshotLimitError(`Selected Graph snapshot exceeds ${SNAPSHOT_MAX_BYTES} encoded payload bytes`)
  }
  const nodes = source
    .query<Row, [string]>("SELECT * FROM graph_node WHERE session_id = ? ORDER BY id")
    .all(sessionID)
  const edges = source
    .query<Row, [string]>("SELECT * FROM graph_edge WHERE session_id = ? ORDER BY id")
    .all(sessionID)
  const versions =
    tables.has("graph_version") &&
    compatibleTable(source, "graph_version", [
      "id",
      "project_id",
      "session_id",
      "version_number",
      "snapshot",
      "time_created",
    ])
      ? source
          .query<Row, [string]>("SELECT * FROM graph_version WHERE session_id = ? ORDER BY version_number")
          .all(sessionID)
      : []
  const evidence =
    tables.has("graph_tool_run") &&
    compatibleTable(source, "graph_tool_run", [
      "id",
      "project_id",
      "session_id",
      "node_id",
      "tool_name",
      "tool_type",
      "status",
      "time_created",
    ])
      ? source.query<Row, [string]>("SELECT * FROM graph_tool_run WHERE session_id = ? ORDER BY id").all(sessionID)
      : []
  const workflow =
    tables.has("graph_workflow_state") &&
    compatibleTable(source, "graph_workflow_state", [
      "session_id",
      "project_id",
      "checkpoint_status",
      "revision",
      "time_created",
      "time_updated",
    ])
      ? (source.query<Row, [string]>("SELECT * FROM graph_workflow_state WHERE session_id = ?").get(sessionID) ??
        undefined)
      : undefined
  const drafts =
    tables.has("graph_artifact_draft") &&
    compatibleTable(source, "graph_artifact_draft", [
      "id",
      "project_id",
      "session_id",
      "node_id",
      "status",
      "test",
      "files",
      "time_created",
      "time_updated",
    ])
      ? source
          .query<Row, [string]>("SELECT * FROM graph_artifact_draft WHERE session_id = ? ORDER BY id")
          .all(sessionID)
      : []
  const generations =
    tables.has("graph_generation_run") &&
    compatibleTable(source, "graph_generation_run", [
      "id",
      "project_id",
      "session_id",
      "node_id",
      "executor",
      "status",
      "gate_result",
      "time_created",
    ])
      ? source
          .query<Row, [string]>("SELECT * FROM graph_generation_run WHERE session_id = ? ORDER BY id")
          .all(sessionID)
      : []
  return { nodes, edges, versions, evidence, workflow, drafts, generations }
}

function sourceBounds(source: import("bun:sqlite").Database, table: string, sessionID: string, maxRows: number) {
  const columns = source.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all()
  if (columns.length > 256) throw new SnapshotLimitError(`${table} column limit exceeded`)
  const payload = columns
    .map((column) => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)), 0)`)
    .join(" + ")
  const result = source
    .query<{ count: number; bytes: number | null }, [string]>(
      `SELECT COUNT(*) AS count, SUM(${payload || "0"}) AS bytes
       FROM "${table}" WHERE session_id = ?`,
    )
    .get(sessionID)
  const count = result?.count ?? 0
  if (count > maxRows) throw new SnapshotLimitError(`${table} row limit exceeded: ${count} > ${maxRows}`)
  return { count, bytes: result?.bytes ?? 0 }
}

function validateLegacyGraph(graph: LegacyGraph) {
  const snapshots = graph.versions.map((version) => versionSnapshot(version, graph.nodes, graph.edges))
  const allNodes = [...graph.nodes, ...snapshots.flatMap((snapshot) => snapshot.nodes)]
  const nodeIDs = new Set(
    allNodes.map((row) => {
      const id = text(row, "id")
      if (Option.isNone(nodeType(row.type)) || Option.isNone(level(row.level))) {
        throw new Error(`Invalid legacy Graph node ${id}`)
      }
      if (row.content !== null && row.content !== undefined) record(row.content)
      if (row.verification !== null && row.verification !== undefined) json(row.verification)
      return id
    }),
  )
  graph.edges.forEach((row) => {
    if (
      Option.isNone(edgeRelation(row.relation)) ||
      !nodeIDs.has(text(row, "source_id")) ||
      !nodeIDs.has(text(row, "target_id"))
    ) {
      throw new Error(`Invalid legacy Graph edge ${text(row, "id")}`)
    }
  })
  graph.versions.forEach((row) => {
    if (!Number.isSafeInteger(number(row, "version_number", Number.NaN))) {
      throw new Error(`Invalid legacy Graph version ${text(row, "id")}`)
    }
  })
  snapshots
    .flatMap((snapshot) => snapshot.edges)
    .forEach((row) => {
      if (
        Option.isNone(edgeRelation(row.relation)) ||
        !nodeIDs.has(text(row, "source_id")) ||
        !nodeIDs.has(text(row, "target_id"))
      )
        throw new Error(`Invalid legacy Graph snapshot edge ${text(row, "id")}`)
    })
  graph.evidence.forEach((row) => {
    if (!toolRunType(text(row, "tool_type")) || !toolRunStatus(text(row, "status"))) {
      throw new Error(`Invalid legacy Graph tool run ${text(row, "id")}`)
    }
    if (row.evidence !== null && row.evidence !== undefined) json(row.evidence)
  })
  if (graph.workflow) {
    if (
      graph.workflow.mode !== null &&
      graph.workflow.mode !== undefined &&
      Option.isNone(executionMode(graph.workflow.mode))
    ) {
      throw new Error("Invalid legacy Graph workflow mode")
    }
    if (
      graph.workflow.checkpoint_kind !== null &&
      graph.workflow.checkpoint_kind !== undefined &&
      Option.isNone(checkpointKind(graph.workflow.checkpoint_kind))
    )
      throw new Error("Invalid legacy Graph checkpoint kind")
    if (Option.isNone(checkpointStatus(graph.workflow.checkpoint_status)))
      throw new Error("Invalid legacy Graph checkpoint")
  }
  graph.drafts.forEach((row) => {
    if (
      !["open", "sealed", "applied", "cancelled"].includes(text(row, "status")) ||
      !nodeIDs.has(text(row, "node_id"))
    ) {
      throw new Error(`Invalid legacy Graph artifact draft ${text(row, "id")}`)
    }
  })
  graph.generations.forEach((row) => {
    if (
      !["agent", "template", "manual"].includes(text(row, "executor")) ||
      !toolRunStatus(text(row, "status")) ||
      !nodeIDs.has(text(row, "node_id")) ||
      !validGateResult(json(row.gate_result))
    )
      throw new Error(`Invalid legacy Graph generation run ${text(row, "id")}`)
  })
}

function compatibleTable(source: import("bun:sqlite").Database, table: string, required: ReadonlyArray<string>) {
  const columns = new Set(
    source
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  )
  return required.every((name) => columns.has(name))
}

function versionSnapshot(version: Row, currentNodes: ReadonlyArray<Row> = [], currentEdges: ReadonlyArray<Row> = []) {
  const snapshot = record(version.snapshot)
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    throw new Error(`Invalid legacy Graph version snapshot ${text(version, "id")}`)
  }
  const nodes = new Map(currentNodes.map((row) => [text(row, "id"), row]))
  const edges = new Map(currentEdges.map((row) => [text(row, "id"), row]))
  const snapshotNodes = snapshot.nodes.map((value) => {
    const row = record(value)
    return { ...(nodes.get(text(row, "id")) ?? {}), ...row }
  })
  const snapshotEdges = snapshot.edges.map((value) => {
    const row = record(value)
    return { ...(edges.get(text(row, "id")) ?? {}), ...row }
  })
  const selectedNodeIDs = new Set(snapshotNodes.map((row) => text(row, "id")))
  const missingEndpoints = snapshotEdges
    .flatMap((row) => [text(row, "source_id"), text(row, "target_id")])
    .filter((id) => !selectedNodeIDs.has(id))
    .flatMap((id) => {
      const row = nodes.get(id)
      return row ? [row] : []
    })
  return {
    nodes: [...snapshotNodes, ...missingEndpoints],
    edges: snapshotEdges,
  }
}

function orderedVersionNumbers(sessions: ReadonlyMap<string, LegacyGraph | undefined>) {
  const versions = [...sessions.values()]
    .flatMap((graph) => graph?.versions ?? [])
    .sort(
      (left, right) =>
        ProductMigrationSource.ordinal(text(left, "project_id"), text(right, "project_id")) ||
        number(left, "version_number", 0) - number(right, "version_number", 0) ||
        integer(left, "time_created", 0) - integer(right, "time_created", 0) ||
        ProductMigrationSource.ordinal(text(left, "id"), text(right, "id")),
    )
  const counters = new Map<string, number>()
  return new Map(
    versions.map((version) => {
      const projectID = text(version, "project_id")
      const versionNumber = (counters.get(projectID) ?? 0) + 1
      counters.set(projectID, versionNumber)
      return [text(version, "id"), versionNumber] as const
    }),
  )
}

function targetVersionNumbers(db: QueryDatabase, context: MappingContext, source: SourceGraphSnapshot) {
  return Effect.gen(function* () {
    const versions = [...source.sessions.values()].flatMap((graph) => graph?.versions ?? [])
    if (versions.length === 0) return new Map<string, number>()
    const versionMappings = yield* db.all<{ source_id: string; target_id: string }>(sql`
      SELECT source_id, target_id FROM product_migration_entity
      WHERE migration_id = ${context.migrationID} AND entity_type = 'graph_version'
    `)
    const importedTargetIDs = new Set(
      versionMappings
        .filter((mapping) => source.versionNumbers.has(mapping.source_id))
        .map((mapping) => mapping.target_id),
    )
    const sourceProjects = [...new Set(versions.map((version) => text(version, "project_id")))]
    const bases = new Map(
      yield* Effect.forEach(sourceProjects, (sourceProjectID) =>
        Effect.gen(function* () {
          const project = yield* db.get<{ target_id: string }>(sql`
            SELECT target_id FROM product_migration_entity
            WHERE migration_id = ${context.migrationID} AND entity_type = 'project' AND source_id = ${sourceProjectID}
          `)
          if (!project) {
            return yield* new ImportError({
              operation: "resolve Graph version project",
              sourceID: sourceProjectID,
              cause: new Error("Durable project mapping is missing"),
            })
          }
          const existing = yield* db.all<{ id: string; version_number: number }>(sql`
            SELECT id, version_number FROM graph_version WHERE project_id = ${project.target_id}
          `)
          const base = existing
            .filter((version) => !importedTargetIDs.has(version.id))
            .reduce((maximum, version) => Math.max(maximum, version.version_number), 0)
          return [sourceProjectID, base] as const
        }),
      ),
    )
    return new Map(
      versions.map((version) => {
        const sourceID = text(version, "id")
        return [
          sourceID,
          (bases.get(text(version, "project_id")) ?? 0) + (source.versionNumbers.get(sourceID) ?? 0),
        ] as const
      }),
    )
  })
}

function validGateResult(value: unknown) {
  const result = record(value)
  return (
    typeof result.allowed === "boolean" && Array.isArray(result.issues) && Array.isArray(result.requiredPermissions)
  )
}

const gateIssueCodes = new Set([
  "target_not_in_current_plan",
  "target_status_blocked",
  "execution_mode_required",
  "checkpoint_pending",
  "current_task_mismatch",
  "target_not_atomic",
  "module_scope_ambiguous",
  "dependency_not_verified",
  "verification_spec_missing",
  "verification_evidence_incomplete",
  "current_plan_invalid",
  "conflict_detected",
  "stale_intent",
  "structural_drift",
  "missing_code_reference",
  "invalid_artifact",
  "artifact_apply_active",
])

function boundedGateResult(value: unknown) {
  const result = record(value)
  const issues = Array.isArray(result.issues)
    ? result.issues
        .flatMap((value) => {
          const issue = record(value)
          if (
            typeof issue.code !== "string" ||
            !gateIssueCodes.has(issue.code) ||
            (issue.severity !== "block" && issue.severity !== "warn") ||
            typeof issue.message !== "string"
          )
            return []
          return [
            {
              code: issue.code,
              severity: issue.severity,
              ...(typeof issue.nodeID === "string" ? { nodeID: boundedID(issue.nodeID) } : {}),
              message: truncateUtf8(redactHistory(issue.message), 512),
            },
          ]
        })
        .slice(0, 32)
    : []
  const requiredPermissions = Array.isArray(result.requiredPermissions)
    ? [...new Set(result.requiredPermissions.filter(gatePermission))].slice(0, 2)
    : []
  return { allowed: result.allowed === true, issues, requiredPermissions }
}

function gatePermission(value: unknown): value is "artifact_write" | "diagnostics_run" {
  return value === "artifact_write" || value === "diagnostics_run"
}

function hasLegacyGraph(graph: LegacyGraph) {
  return (
    graph.nodes.length > 0 ||
    graph.edges.length > 0 ||
    graph.versions.length > 0 ||
    graph.evidence.length > 0 ||
    graph.workflow !== undefined ||
    graph.drafts.length > 0 ||
    graph.generations.length > 0
  )
}

function targetSession(db: QueryDatabase, context: MappingContext, sourceSessionID: string) {
  return Effect.gen(function* () {
    const mapping = yield* db.get<{ target_id: string; source_fingerprint: string }>(sql`
      SELECT target_id, source_fingerprint FROM product_migration_entity
      WHERE migration_id = ${context.migrationID} AND entity_type = 'session' AND source_id = ${sourceSessionID}
    `)
    if (!mapping || mapping.source_fingerprint !== context.sourceFingerprint) {
      return yield* new ImportError({
        operation: "resolve imported session",
        sourceID: sourceSessionID,
        cause: new Error("Durable session mapping is missing or belongs to another source snapshot"),
      })
    }
    const row = yield* db.get<{ project_id: string; metadata: unknown; model: unknown }>(sql`
      SELECT project_id, metadata, model FROM session WHERE id = ${mapping.target_id}
    `)
    if (!row) {
      return yield* new ImportError({
        operation: "resolve imported session",
        sourceID: sourceSessionID,
        cause: new Error("Copied target session is missing"),
      })
    }
    return {
      sourceID: sourceSessionID,
      targetID: mapping.target_id,
      projectID: row.project_id,
      metadata: record(row.metadata),
      model: Option.getOrUndefined(modelRef(json(row.model))),
    } satisfies TargetSession
  })
}

function queuedEnhancement(db: QueryDatabase, enhancementID: string) {
  return Effect.gen(function* () {
    const row = yield* db.get<{ id: string; project_id: string; metadata: unknown }>(sql`
      SELECT id, project_id, metadata FROM session
      WHERE json_extract(metadata, '$.productMigration.graphEnhancement.id') = ${enhancementID}
    `)
    const queued = row
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(QueuedEnhancementSchema)(
            record(record(row.metadata).productMigration).graphEnhancement,
          ),
        )
      : undefined
    if (
      !row ||
      !queued ||
      queued.id !== destinationID("geh", row.id) ||
      queued.versionID !== destinationID("gvr", queued.id)
    ) {
      return yield* new ImportError({
        operation: "resolve queued graph enhancement",
        sourceID: enhancementID,
        cause: new Error("Destination enhancement metadata is missing or invalid"),
      })
    }
    return { sessionID: row.id, projectID: row.project_id, queued }
  })
}

function importLegacy(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  legacy: LegacyGraph,
  versionNumbers: ReadonlyMap<string, number>,
): Effect.Effect<ImportedGraph, ImportError> {
  return Effect.gen(function* () {
    const parsedEvidence = legacy.evidence.map(parseLegacyEvidence)
    const nodes = yield* Effect.forEach(legacy.nodes, (row) =>
      normalizeLegacyNode(db, context, target, row, parsedEvidence),
    )
    const nodeIDs = new Map(nodes.map((node) => [node.sourceID, node.id]))
    const edges = yield* Effect.forEach(legacy.edges, (row) => normalizeLegacyEdge(db, context, target, row, nodeIDs))
    const historical = yield* Effect.forEach(legacy.versions, (version) =>
      Effect.gen(function* () {
        const snapshot = versionSnapshot(version, legacy.nodes, legacy.edges)
        const snapshotNodes = yield* Effect.forEach(snapshot.nodes, (row) =>
          normalizeLegacyNode(db, context, target, row, parsedEvidence),
        )
        const snapshotNodeIDs = new Map(snapshotNodes.map((node) => [node.sourceID, node.id]))
        const snapshotEdges = yield* Effect.forEach(snapshot.edges, (row) =>
          normalizeLegacyEdge(db, context, target, row, snapshotNodeIDs),
        )
        return { version, nodes: snapshotNodes, edges: snapshotEdges }
      }),
    )
    const allNodeIDs = new Map(
      [...nodes, ...historical.flatMap((version) => version.nodes)].map((node) => [node.sourceID, node.id]),
    )
    const importedEvidence = yield* Effect.forEach(parsedEvidence, (item) =>
      normalizeLegacyEvidence(db, context, target, item, allNodeIDs, nodeIDs),
    )
    yield* Effect.forEach(nodes, (node) => writeNode(db, node), { discard: true })
    yield* Effect.forEach(edges, (edge) => writeEdge(db, edge), { discard: true })
    yield* Effect.forEach(importedEvidence, (item) => writeEvidence(db, target, item), { discard: true })
    yield* importWorkflow(db, context, target, legacy.workflow, nodeIDs)
    yield* Effect.forEach(legacy.drafts, (draft) => importDraftAudit(db, context, target, draft, nodeIDs), {
      discard: true,
    })
    yield* Effect.forEach(
      legacy.generations,
      (generation) => importGeneration(db, context, target, generation, nodeIDs),
      { discard: true },
    )
    const importedVersions =
      legacy.versions.length > 0
        ? yield* Effect.forEach(historical, (item) =>
            writeVersion(db, context, target, {
              sourceID: text(item.version, "id"),
              message: nullableText(item.version, "message") ?? "Imported legacy Graph",
              nodes: item.nodes,
              edges: item.edges,
              timeCreated: integer(item.version, "time_created", 0),
              versionNumber: versionNumbers.get(text(item.version, "id")),
            }),
          )
        : [
            yield* writeVersion(db, context, target, {
              sourceID: `legacy:${target.sourceID}`,
              message: "Imported legacy Graph",
              nodes,
              edges,
              timeCreated: 0,
            }),
          ]
    const latest = importedVersions.toSorted((left, right) => left.versionNumber - right.versionNumber).at(-1)
    if (!latest) {
      return yield* new ImportError({
        operation: "import legacy graph version",
        sourceID: target.sourceID,
        cause: new Error("No Graph version was imported"),
      })
    }
    return {
      sourceSessionID: target.sourceID,
      targetSessionID: target.targetID,
      strategy: "legacy",
      status: "ready",
      versionID: latest.versionID,
      nodeCount: new Set([...nodes, ...historical.flatMap((version) => version.nodes)].map((node) => node.id)).size,
      edgeCount: new Set([...edges, ...historical.flatMap((version) => version.edges)].map((edge) => edge.id)).size,
    } satisfies ImportedGraph
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ImportError
        ? cause
        : new ImportError({ operation: "import legacy graph", sourceID: target.sourceID, cause }),
    ),
  )
}

function parseLegacyEvidence(row: Row) {
  const decoded =
    row.evidence === null || row.evidence === undefined
      ? null
      : (Option.getOrUndefined(evidence(json(row.evidence))) ?? null)
  return { row, evidence: decoded }
}

function normalizeLegacyNode(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  row: Row,
  sourceEvidence: ReadonlyArray<{ readonly row: Row; readonly evidence: Graph.ToolEvidence | null }>,
) {
  return Effect.gen(function* () {
    const sourceID = text(row, "id")
    const type = Option.getOrUndefined(nodeType(row.type))
    const nodeLevel = Option.getOrUndefined(level(row.level))
    if (!type || !nodeLevel) throw new Error(`Invalid legacy Graph node ${sourceID}`)
    const importedStatus = Option.getOrUndefined(nodeStatus(row.status ?? "pending")) ?? "pending"
    const durable = sourceEvidence.filter((item) => nullableText(item.row, "node_id") === sourceID)
    const hasVerification = durable.some(authoritativeVerification)
    const hasArtifact = durable.some(authoritativeArtifact)
    const status =
      importedStatus === "deprecated"
        ? "deprecated"
        : importedStatus === "verified" && hasVerification
          ? "verified"
          : importedStatus === "implemented" && hasArtifact
            ? "implemented"
            : "pending"
    const name = text(row, "name")
    const importedVerification = Option.getOrUndefined(verification(json(row.verification)))
    const sourceContent = record(row.content)
    return {
      sourceID,
      id: yield* adoptEntity(db, context, "graph_node", sourceID),
      projectID: target.projectID,
      sessionID: target.targetID,
      type,
      name,
      level: nodeLevel,
      priority: Option.getOrUndefined(priority(row.priority)) ?? null,
      category: nullableText(row, "category"),
      status,
      desc: nullableText(row, "desc"),
      content: {
        ...sourceContent,
        migration: {
          source_id: sourceID,
          source_message_ids: stringArray(sourceContent.source_message_ids),
          provenance: "deterministic",
          confidence: number(row, "confidence", 1),
        },
      },
      verification:
        type === "atomic"
          ? (importedVerification ?? { criteria: [`Verify ${name}`], diagnostics: [{ name: "test" }] })
          : null,
      codeHash: nullableText(row, "code_hash"),
      testStatus:
        status === "verified"
          ? "passed"
          : status === "implemented"
            ? "pending"
            : Option.getOrUndefined(testStatus(row.test_status ?? "none")) === "failed"
              ? "failed"
              : "none",
      confidence: boundedConfidence(number(row, "confidence", 1)),
      timeCreated: integer(row, "time_created", 0),
      timeUpdated: integer(row, "time_updated", 0),
    } satisfies NormalizedNode
  })
}

function normalizeLegacyEdge(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  row: Row,
  nodeIDs: ReadonlyMap<string, string>,
) {
  return Effect.gen(function* () {
    const sourceID = text(row, "id")
    const sourceNodeID = nodeIDs.get(text(row, "source_id"))
    const targetNodeID = nodeIDs.get(text(row, "target_id"))
    const relation = Option.getOrUndefined(edgeRelation(row.relation))
    if (!sourceNodeID || !targetNodeID || !relation) throw new Error(`Invalid legacy Graph edge ${sourceID}`)
    return {
      sourceID,
      id: yield* adoptEntity(db, context, "graph_edge", sourceID),
      projectID: target.projectID,
      sessionID: target.targetID,
      sourceNodeID,
      targetNodeID,
      relation,
      confidence: boundedConfidence(number(row, "confidence", 1)),
      timeCreated: integer(row, "time_created", 0),
    } satisfies NormalizedEdge
  })
}

function normalizeLegacyEvidence(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  item: { readonly row: Row; readonly evidence: Graph.ToolEvidence | null },
  structuralNodeIDs: ReadonlyMap<string, string>,
  liveNodeIDs: ReadonlyMap<string, string>,
) {
  return Effect.gen(function* () {
    const sourceID = text(item.row, "id")
    const sourceNodeID = nullableText(item.row, "node_id")
    const nodeID = sourceNodeID ? (liveNodeIDs.get(sourceNodeID) ?? null) : null
    const toolType = text(item.row, "tool_type", item.evidence?.kind ?? "graph")
    const status = text(item.row, "status", "succeeded")
    if (!toolRunType(toolType) || !toolRunStatus(status)) throw new Error(`Invalid legacy evidence ${sourceID}`)
    return {
      sourceID,
      id: yield* adoptEntity(db, context, "graph_evidence", sourceID),
      nodeID,
      toolName: text(item.row, "tool_name", item.evidence?.kind ?? "graph"),
      toolType,
      inputSummary:
        sourceNodeID && structuralNodeIDs.has(sourceNodeID) && !nodeID
          ? `source_node=${boundedID(sourceNodeID)} ${nullableText(item.row, "input_summary") ?? ""}`.trim()
          : nullableText(item.row, "input_summary"),
      outputSummary: nullableText(item.row, "output_summary"),
      status,
      error: nullableText(item.row, "error"),
      evidence: item.evidence
        ? {
            ...item.evidence,
            nodeID:
              nodeID && item.evidence.nodeID === sourceNodeID
                ? nodeID
                : `source:${boundedID(item.evidence.nodeID || sourceNodeID || "unknown")}`,
          }
        : null,
      timeCreated: integer(item.row, "time_created", 0),
    } satisfies NormalizedEvidence
  })
}

function authoritativeVerification(item: { readonly row: Row; readonly evidence: Graph.ToolEvidence | null }) {
  if (
    text(item.row, "status") !== "succeeded" ||
    text(item.row, "tool_name") !== "graph.diagnostics.run" ||
    text(item.row, "tool_type") !== "diagnostics" ||
    item.evidence?.nodeID !== nullableText(item.row, "node_id") ||
    item.evidence?.kind !== "diagnostics"
  )
    return false
  return (
    item.evidence.complete &&
    item.evidence.passed &&
    item.evidence.commands.length > 0 &&
    item.evidence.commands.every((command) => !command.timedOut && command.passed && command.exitCode === 0)
  )
}

function authoritativeArtifact(item: { readonly row: Row; readonly evidence: Graph.ToolEvidence | null }) {
  return (
    text(item.row, "status") === "succeeded" &&
    text(item.row, "tool_name") === "graph.artifact.apply" &&
    text(item.row, "tool_type") === "artifact" &&
    item.evidence?.nodeID === nullableText(item.row, "node_id") &&
    item.evidence?.kind === "artifact" &&
    item.evidence.artifactPaths.length > 0
  )
}

function importWorkflow(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  workflow: Row | undefined,
  nodeIDs: ReadonlyMap<string, string>,
) {
  if (!workflow) return Effect.void
  return Effect.gen(function* () {
    const currentSourceID = nullableText(workflow, "current_node_id")
    const scopeSourceID = nullableText(workflow, "checkpoint_scope_node_id")
    const currentNodeID = currentSourceID ? nodeIDs.get(currentSourceID) : undefined
    const checkpointScopeNodeID = scopeSourceID ? nodeIDs.get(scopeSourceID) : undefined
    if ((currentSourceID && !currentNodeID) || (scopeSourceID && !checkpointScopeNodeID)) {
      yield* writeEvidence(db, target, {
        sourceID: `workflow:${target.sourceID}`,
        id: yield* adoptEntity(db, context, "graph_evidence", `workflow:${target.sourceID}`),
        nodeID: null,
        toolName: "product_migration.graph_workflow_state",
        toolType: "graph",
        inputSummary: "Historical workflow references nodes outside the imported current plan",
        outputSummary: null,
        status: "blocked",
        error: "Workflow state retained as audit because its current node is only present in a historical snapshot",
        evidence: null,
        timeCreated: integer(workflow, "time_created", 0),
      })
      return
    }
    yield* db.run(sql`
      INSERT INTO graph_workflow_state
        (session_id, project_id, mode, current_node_id, checkpoint_kind, checkpoint_scope_node_id,
         checkpoint_status, checkpoint_reason, revision, active_operation_id, active_operation_kind,
         active_operation_started_at, active_operation_process_id, active_operation_runtime_id,
         time_created, time_updated)
      VALUES
        (${target.targetID}, ${target.projectID}, ${nullableText(workflow, "mode")}, ${currentNodeID ?? null},
         ${nullableText(workflow, "checkpoint_kind")}, ${checkpointScopeNodeID ?? null},
         ${text(workflow, "checkpoint_status")}, ${nullableText(workflow, "checkpoint_reason")},
         ${integer(workflow, "revision", 0)}, NULL, NULL, NULL, NULL, NULL,
         ${integer(workflow, "time_created", 0)}, ${integer(workflow, "time_updated", 0)})
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id, mode = excluded.mode, current_node_id = excluded.current_node_id,
        checkpoint_kind = excluded.checkpoint_kind,
        checkpoint_scope_node_id = excluded.checkpoint_scope_node_id,
        checkpoint_status = excluded.checkpoint_status, checkpoint_reason = excluded.checkpoint_reason,
        revision = excluded.revision, active_operation_id = NULL, active_operation_kind = NULL,
        active_operation_started_at = NULL, active_operation_process_id = NULL,
        active_operation_runtime_id = NULL, time_created = excluded.time_created,
        time_updated = excluded.time_updated
    `)
  })
}

function importDraftAudit(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  draft: Row,
  nodeIDs: ReadonlyMap<string, string>,
) {
  return Effect.gen(function* () {
    const sourceID = `artifact_draft:${text(draft, "id")}`
    yield* writeEvidence(db, target, {
      sourceID,
      id: yield* adoptEntity(db, context, "graph_evidence", sourceID),
      nodeID: nodeIDs.get(text(draft, "node_id")) ?? null,
      toolName: "product_migration.graph_artifact_draft",
      toolType: "artifact",
      inputSummary: `source_status=${text(draft, "status")}`,
      outputSummary: null,
      status: "blocked",
      error:
        "Historical artifact draft chunks and test commands are audit-only because applying them could write files or execute commands against the current project",
      evidence: null,
      timeCreated: integer(draft, "time_created", 0),
    })
  })
}

function writeMigrationWarning(db: QueryDatabase, context: MappingContext, target: TargetSession, warning: string) {
  return Effect.gen(function* () {
    const sourceID = `warning:${target.sourceID}:${createHash("sha256").update(warning).digest("hex").slice(0, 16)}`
    yield* writeEvidence(db, target, {
      sourceID,
      id: yield* adoptEntity(db, context, "graph_evidence", sourceID),
      nodeID: null,
      toolName: "product_migration.graph_table_unsupported",
      toolType: "graph",
      inputSummary: null,
      outputSummary: null,
      status: "blocked",
      error: warning,
      evidence: null,
      timeCreated: 0,
    })
  })
}

function importGeneration(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  generation: Row,
  nodeIDs: ReadonlyMap<string, string>,
) {
  return Effect.gen(function* () {
    const nodeID = nodeIDs.get(text(generation, "node_id"))
    if (!nodeID) {
      const sourceID = `generation:${text(generation, "id")}`
      yield* writeEvidence(db, target, {
        sourceID,
        id: yield* adoptEntity(db, context, "graph_evidence", sourceID),
        nodeID: null,
        toolName: "product_migration.graph_generation_run",
        toolType: "graph",
        inputSummary: `source_status=${text(generation, "status")}`,
        outputSummary: nullableText(generation, "diagnostics_summary"),
        status: "blocked",
        error:
          "Generation run retained as audit because its node exists only in a historical snapshot and the destination table requires a live Graph node",
        evidence: null,
        timeCreated: integer(generation, "time_created", 0),
      })
      return
    }
    const id = yield* adoptEntity(db, context, "graph_generation", text(generation, "id"))
    yield* db.run(sql`
      INSERT INTO graph_generation_run
        (id, project_id, session_id, node_id, executor, backend, model, context_snapshot_hash,
         status, gate_result, artifact_summary, diagnostics_summary, time_created)
      VALUES
        (${id}, ${target.projectID}, ${target.targetID}, ${nodeID}, ${auditText(text(generation, "executor"))},
         ${auditText(nullableText(generation, "backend"))}, ${auditText(nullableText(generation, "model"))},
         ${auditText(nullableText(generation, "context_snapshot_hash"))}, ${text(generation, "status")},
         ${JSON.stringify(boundedGateResult(json(generation.gate_result)))}, ${auditText(nullableText(generation, "artifact_summary"))},
         ${auditText(nullableText(generation, "diagnostics_summary"))}, ${integer(generation, "time_created", 0)})
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, session_id = excluded.session_id, node_id = excluded.node_id,
        executor = excluded.executor, backend = excluded.backend, model = excluded.model,
        context_snapshot_hash = excluded.context_snapshot_hash, status = excluded.status,
        gate_result = excluded.gate_result, artifact_summary = excluded.artifact_summary,
        diagnostics_summary = excluded.diagnostics_summary, time_created = excluded.time_created
    `)
  })
}

function reconstruct(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
): Effect.Effect<ImportedGraph, ImportError> {
  return Effect.gen(function* () {
    const history = yield* copiedHistory(db, target.targetID)
    const todos = yield* db.all<{ content: string; position: number }>(sql`
      SELECT content, position FROM todo WHERE session_id = ${target.targetID} ORDER BY position
    `)
    const extracted = extract(history, todos, target.sourceID)
    const nodes = yield* Effect.forEach(extracted.nodes, (node) =>
      Effect.gen(function* () {
        return {
          ...node,
          id: yield* adoptEntity(db, context, "graph_node", node.sourceID),
        }
      }),
    )
    const nodeIDs = new Map(nodes.map((node) => [node.sourceID, node.id]))
    const edges = yield* Effect.forEach(extracted.edges, (edge) =>
      Effect.gen(function* () {
        const sourceNodeID = nodeIDs.get(edge.sourceNodeID)
        const targetNodeID = nodeIDs.get(edge.targetNodeID)
        if (!sourceNodeID || !targetNodeID) throw new Error(`Reconstructed edge ${edge.sourceID} is dangling`)
        return {
          ...edge,
          id: yield* adoptEntity(db, context, "graph_edge", edge.sourceID),
          sourceNodeID,
          targetNodeID,
        }
      }),
    )
    const normalizedNodes = nodes.map(
      (node, index): NormalizedNode => ({
        sourceID: node.sourceID,
        id: node.id,
        projectID: target.projectID,
        sessionID: target.targetID,
        type: node.type,
        name: node.name,
        level: node.level,
        priority: null,
        category: null,
        status: "pending",
        desc: null,
        content: node.content,
        verification: node.verification,
        codeHash: null,
        testStatus: "none",
        confidence: node.confidence,
        timeCreated: index,
        timeUpdated: index,
      }),
    )
    const normalizedEdges = edges.map(
      (edge, index): NormalizedEdge => ({
        sourceID: edge.sourceID,
        id: edge.id,
        projectID: target.projectID,
        sessionID: target.targetID,
        sourceNodeID: edge.sourceNodeID,
        targetNodeID: edge.targetNodeID,
        relation: edge.relation,
        confidence: edge.confidence,
        timeCreated: index,
      }),
    )
    yield* Effect.forEach(normalizedNodes, (node) => writeNode(db, node), { discard: true })
    yield* Effect.forEach(normalizedEdges, (edge) => writeEdge(db, edge), { discard: true })
    const version = yield* writeVersion(db, context, target, {
      sourceID: reconstructedSourceID("version", target.sourceID, "current"),
      message: "Deterministic reconstruction from copied session history",
      nodes: normalizedNodes,
      edges: normalizedEdges,
      timeCreated: 0,
    })
    return {
      sourceSessionID: target.sourceID,
      targetSessionID: target.targetID,
      strategy: "reconstructed",
      status: "ready",
      versionID: version.versionID,
      nodeCount: normalizedNodes.length,
      edgeCount: normalizedEdges.length,
    } satisfies ImportedGraph
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ImportError
        ? cause
        : new ImportError({ operation: "reconstruct graph", sourceID: target.sourceID, cause }),
    ),
  )
}

function copiedHistory(db: QueryDatabase, sessionID: string) {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ id: string; type: string; seq: number; data: unknown }>(sql`
      SELECT id, type, seq, data FROM session_message WHERE session_id = ${sessionID} ORDER BY seq
    `)
    const mappings = yield* db.all<{ source_id: string; target_id: string }>(sql`
      SELECT source_id, target_id FROM product_migration_entity
      WHERE entity_type = 'session_message'
        AND target_id IN (SELECT id FROM session_message WHERE session_id = ${sessionID})
    `)
    const sourceIDs = new Map(mappings.map((mapping) => [mapping.target_id, mapping.source_id]))
    return rows.flatMap((row): HistoryEntry[] => {
      const sourceID = sourceIDs.get(row.id)
      if (!sourceID) return []
      const data = record(row.data)
      if (row.type === "user" || row.type === "system" || row.type === "synthetic") {
        const value = typeof data.text === "string" ? data.text : ""
        return value ? [{ id: sourceID, targetID: row.id, type: row.type, text: value, seq: row.seq }] : []
      }
      if (row.type === "shell") {
        const value = typeof data.command === "string" ? data.command : ""
        return value ? [{ id: sourceID, targetID: row.id, type: row.type, text: value, seq: row.seq }] : []
      }
      if (row.type !== "assistant" || !Array.isArray(data.content)) return []
      const value = data.content
        .flatMap((part) => {
          const item = record(part)
          return item.type === "text" && typeof item.text === "string" ? [item.text] : []
        })
        .join("\n")
      return value ? [{ id: sourceID, targetID: row.id, type: row.type, text: value, seq: row.seq }] : []
    })
  }).pipe(
    Effect.mapError(
      (cause) => new ImportError({ operation: "read copied session history", sourceID: sessionID, cause }),
    ),
  )
}

function extract(
  history: ReadonlyArray<HistoryEntry>,
  todos: ReadonlyArray<{ content: string; position: number }>,
  sourceSessionID: string,
) {
  const goals: ExtractedFact[] = []
  const modules: ExtractedFact[] = []
  const tasks: ExtractedTask[] = []
  const dependencies: Array<{ readonly source: string; readonly target: string; readonly messageID: string }> = []
  history
    .filter((entry) => entry.type === "user")
    .forEach((entry) => {
      entry.text.split(/\r?\n/).forEach((raw) => {
        const line = raw.trim().replace(/^[-*]\s+/, "")
        const goal = /^goal\s*:\s*(.+)$/i.exec(line)?.[1]?.trim()
        if (goal) goals.push({ value: goal, messageID: entry.id })
        const module = /^module\s*:\s*(.+)$/i.exec(line)?.[1]?.trim()
        if (module) modules.push({ value: module, messageID: entry.id })
        const task = /^(?:task\s*:|\[[ xX]\]\s*)(.+)$/i.exec(line)?.[1]?.trim()
        if (task) {
          tasks.push({
            sourceID: reconstructedSourceID("task", sourceSessionID, `${entry.id}\0${tasks.length}`),
            value: task,
            messageID: entry.id,
            seq: entry.seq,
            artifactPaths: [],
            diagnostics: [],
          })
        }
        const dependency = /^dependenc(?:y|ies)\s*:\s*(.+?)\s*->\s*(.+)$/i.exec(line)
        if (dependency?.[1] && dependency[2]) {
          dependencies.push({ source: dependency[1].trim(), target: dependency[2].trim(), messageID: entry.id })
        }
        const artifact = /^artifact\s*:\s*(.+)$/i.exec(line)?.[1]?.trim()
        if (artifact && tasks.at(-1) && Option.isSome(relativePath(artifact)))
          tasks.at(-1)?.artifactPaths.push(artifact)
        const diagnostic = /^diagnostic\s*:\s*(.+)$/i.exec(line)?.[1]?.trim()
        const parsed = diagnostic ? diagnosticCommand(diagnostic) : undefined
        if (parsed && tasks.at(-1)) tasks.at(-1)?.diagnostics.push(parsed)
      })
    })
  history
    .filter((entry) => entry.type === "shell")
    .forEach((entry) => {
      const linked = /^task\s*:\s*(.+?)\s*::\s*(.+)$/i.exec(entry.text)
      const linkedTask = linked?.[1] ? tasks.find((task) => task.value === linked[1]?.trim()) : undefined
      const previous = history.filter((item) => item.seq < entry.seq).at(-1)
      const adjacentTask =
        previous?.type === "user" ? tasks.filter((task) => task.messageID === previous.id).at(-1) : undefined
      const task = linkedTask ?? adjacentTask
      const parsed = diagnosticCommand(linked?.[2]?.trim() ?? entry.text)
      if (parsed && task && !task.diagnostics.some((item) => item.command === parsed.command))
        task.diagnostics.push(parsed)
    })
  if (tasks.length === 0) {
    todos.forEach((todo) =>
      tasks.push({
        sourceID: reconstructedSourceID("task", sourceSessionID, `todo\0${todo.position}`),
        value: todo.content,
        messageID: "",
        seq: todo.position,
        artifactPaths: [],
        diagnostics: [],
      }),
    )
  }
  if (tasks.length === 0) {
    tasks.push({
      sourceID: reconstructedSourceID("task", sourceSessionID, `inferred\0${0}`),
      value: "Review imported session",
      messageID: "",
      seq: 0,
      artifactPaths: [],
      diagnostics: [],
    })
  }
  const goal = goals[0] ?? { value: "Continue imported session", messageID: "" }
  const selectedModules = modules.length > 0 ? modules : [{ value: "Imported work", messageID: goal.messageID }]
  const nodes: ReconstructedNode[] = [
    {
      sourceID: reconstructedSourceID("goal", sourceSessionID, goal.messageID || "inferred"),
      id: "",
      type: "prd",
      name: goal.value,
      level: "L1",
      verification: null,
      content: deterministicContent(
        reconstructedSourceID("goal", sourceSessionID, goal.messageID || "inferred"),
        goal.messageID ? [goal.messageID] : [],
        goal.messageID ? 1 : 0.5,
      ),
      confidence: goal.messageID ? 1 : 0.5,
    },
    ...selectedModules.map(
      (module, index): ReconstructedNode => ({
        sourceID: reconstructedSourceID("module", sourceSessionID, `${module.messageID || "inferred"}\0${index}`),
        id: "",
        type: "composite",
        name: module.value,
        level: "L1",
        verification: null,
        content: deterministicContent(
          reconstructedSourceID("module", sourceSessionID, `${module.messageID || "inferred"}\0${index}`),
          module.messageID ? [module.messageID] : [],
          module.messageID ? 1 : 0.5,
        ),
        confidence: module.messageID ? 1 : 0.5,
      }),
    ),
    ...tasks.map(
      (task): ReconstructedNode => ({
        sourceID: task.sourceID,
        id: "",
        type: "atomic",
        name: task.value,
        level: "L2",
        verification: {
          criteria: [`Complete ${task.value}`],
          diagnostics: verificationDiagnostics(task.diagnostics),
        },
        content: {
          artifact_paths: [...new Set(task.artifactPaths)],
          diagnostic_commands: [...new Set(task.diagnostics.map((item) => item.command))],
          ...deterministicContent(task.sourceID, task.messageID ? [task.messageID] : [], task.messageID ? 1 : 0.5),
        },
        confidence: task.messageID ? 1 : 0.5,
      }),
    ),
  ]
  const goalNode = nodes[0]
  const moduleNodes = nodes.filter((node) => node.type === "composite")
  const taskNodes = nodes.filter((node) => node.type === "atomic")
  if (!goalNode || moduleNodes.length === 0) throw new Error("Reconstruction did not create a graph root")
  const edges: ReconstructedEdge[] = [
    ...moduleNodes.map(
      (module, index): ReconstructedEdge => ({
        sourceID: reconstructedSourceID("contains", sourceSessionID, `goal\0${index}\0${module.sourceID}`),
        id: "",
        sourceNodeID: goalNode.sourceID,
        targetNodeID: module.sourceID,
        relation: "contains",
        confidence: Math.min(goalNode.confidence, module.confidence),
      }),
    ),
    ...taskNodes.map(
      (task, index): ReconstructedEdge => ({
        sourceID: reconstructedSourceID("contains", sourceSessionID, `task\0${index}\0${task.sourceID}`),
        id: "",
        sourceNodeID: moduleNodes[0]?.sourceID ?? "",
        targetNodeID: task.sourceID,
        relation: "contains",
        confidence: task.confidence,
      }),
    ),
    ...dependencies.flatMap((dependency, index): ReconstructedEdge[] => {
      const source = taskNodes.find((task) => task.name === dependency.source)
      const target = taskNodes.find((task) => task.name === dependency.target)
      if (!source || !target) return []
      return [
        {
          sourceID: reconstructedSourceID(
            "blocks",
            sourceSessionID,
            `${dependency.messageID}\0${index}\0${source.sourceID}\0${target.sourceID}`,
          ),
          id: "",
          sourceNodeID: source.sourceID,
          targetNodeID: target.sourceID,
          relation: "blocks",
          confidence: 1,
        },
      ]
    }),
  ]
  return { nodes, edges }
}

function diagnosticCommand(command: string) {
  const name = /(?:^|\s)(?:bun\s+)?test(?:\s|$)/i.test(command)
    ? "test"
    : /(?:^|\s)(?:bun\s+)?typecheck(?:\s|$)/i.test(command)
      ? "typecheck"
      : /(?:^|\s)(?:bun\s+)?lint(?:\s|$)/i.test(command)
        ? "lint"
        : undefined
  if (!name) return undefined
  const paths = command
    .split(/\s+/)
    .filter((part) => part.includes("/") && !part.startsWith("-") && Option.isSome(relativePath(part)))
  return { name, command, paths } satisfies {
    readonly name: Graph.DiagnosticName
    readonly command: string
    readonly paths: string[]
  }
}

function verificationDiagnostics(diagnostics: ExtractedTask["diagnostics"]): Graph.VerificationSpec["diagnostics"] {
  const first = diagnostics[0]
  if (!first) return [{ name: "test" }]
  const value = (item: typeof first) => ({
    name: item.name,
    ...(item.paths.length > 0 ? { paths: item.paths } : {}),
  })
  return [value(first), ...diagnostics.slice(1).map(value)]
}

function deterministicContent(sourceID: string, sourceMessageIDs: ReadonlyArray<string>, confidence: number) {
  return {
    migration: {
      source_id: sourceID,
      source_message_ids: [...new Set(sourceMessageIDs)].filter(Boolean),
      provenance: "deterministic",
      confidence: boundedConfidence(confidence),
    },
  }
}

function writeNode(db: QueryDatabase, node: NormalizedNode) {
  return db.run(sql`
    INSERT INTO graph_node
      (id, project_id, session_id, type, name, level, priority, category, status, desc, content,
       verification, code_hash, test_status, confidence, time_created, time_updated)
    VALUES
      (${node.id}, ${node.projectID}, ${node.sessionID}, ${node.type}, ${node.name}, ${node.level},
       ${node.priority}, ${node.category}, ${node.status}, ${node.desc}, ${JSON.stringify(node.content)},
       ${node.verification ? JSON.stringify(node.verification) : null}, ${node.codeHash}, ${node.testStatus},
       ${node.confidence}, ${node.timeCreated}, ${node.timeUpdated})
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id, session_id = excluded.session_id, type = excluded.type,
      name = excluded.name, level = excluded.level, priority = excluded.priority, category = excluded.category,
      status = excluded.status, desc = excluded.desc, content = excluded.content,
      verification = excluded.verification, code_hash = excluded.code_hash,
      test_status = excluded.test_status, confidence = excluded.confidence,
      time_created = excluded.time_created, time_updated = excluded.time_updated
  `)
}

function writeEdge(db: QueryDatabase, edge: NormalizedEdge) {
  return db.run(sql`
    INSERT INTO graph_edge
      (id, project_id, session_id, source_id, target_id, relation, confidence, time_created)
    VALUES
      (${edge.id}, ${edge.projectID}, ${edge.sessionID}, ${edge.sourceNodeID}, ${edge.targetNodeID},
       ${edge.relation}, ${edge.confidence}, ${edge.timeCreated})
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id, session_id = excluded.session_id,
      source_id = excluded.source_id, target_id = excluded.target_id,
      relation = excluded.relation, confidence = excluded.confidence, time_created = excluded.time_created
  `)
}

function writeEvidence(db: QueryDatabase, target: TargetSession, item: NormalizedEvidence) {
  return db.run(sql`
    INSERT INTO graph_tool_run
      (id, project_id, session_id, node_id, tool_name, tool_type, input_summary, output_summary,
       status, error, evidence, time_created)
    VALUES
      (${item.id}, ${target.projectID}, ${target.targetID}, ${item.nodeID}, ${auditText(item.toolName)}, ${item.toolType},
       ${auditText(item.inputSummary)}, ${auditText(item.outputSummary)}, ${item.status}, ${auditText(item.error)},
       ${item.evidence ? redactHistory(JSON.stringify(item.evidence)) : null}, ${item.timeCreated})
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id, session_id = excluded.session_id, node_id = excluded.node_id,
      tool_name = excluded.tool_name, tool_type = excluded.tool_type, input_summary = excluded.input_summary,
      output_summary = excluded.output_summary, status = excluded.status, error = excluded.error,
      evidence = excluded.evidence, time_created = excluded.time_created
  `)
}

function writeVersion(
  db: QueryDatabase,
  context: MappingContext,
  target: TargetSession,
  input: {
    readonly sourceID: string
    readonly message: string
    readonly nodes: ReadonlyArray<NormalizedNode>
    readonly edges: ReadonlyArray<NormalizedEdge>
    readonly timeCreated: number
    readonly versionNumber?: number
  },
) {
  return Effect.gen(function* () {
    const versionID = yield* adoptEntity(db, context, "graph_version", input.sourceID)
    const existing = yield* db.get<{ version_number: number }>(sql`
      SELECT version_number FROM graph_version WHERE id = ${versionID}
    `)
    const versionNumber =
      existing?.version_number ?? input.versionNumber ?? (yield* nextVersionNumber(db, target.projectID))
    const snapshot = {
      nodes: input.nodes.map(snapshotNode),
      edges: input.edges.map(snapshotEdge),
    }
    yield* db.run(sql`
      INSERT INTO graph_version
        (id, project_id, session_id, version_number, message, snapshot, time_created)
      VALUES
        (${versionID}, ${target.projectID}, ${target.targetID}, ${versionNumber}, ${input.message},
         ${JSON.stringify(snapshot)}, ${input.timeCreated})
      ON CONFLICT(id) DO UPDATE SET
        message = excluded.message, snapshot = excluded.snapshot, time_created = excluded.time_created
    `)
    return { versionID, versionNumber }
  })
}

function nextVersionNumber(db: QueryDatabase, projectID: string) {
  return db
    .get<{ version_number: number | null }>(
      sql`
      SELECT MAX(version_number) AS version_number FROM graph_version WHERE project_id = ${projectID}
    `,
    )
    .pipe(Effect.map((row) => (row?.version_number ?? 0) + 1))
}

function snapshotNode(node: NormalizedNode) {
  return {
    id: node.id,
    project_id: node.projectID,
    session_id: node.sessionID,
    type: node.type,
    name: node.name,
    level: node.level,
    priority: node.priority,
    category: node.category,
    status: node.status,
    desc: node.desc,
    content: node.content,
    verification: node.verification,
    code_hash: node.codeHash,
    test_status: node.testStatus,
    confidence: node.confidence,
    time_created: node.timeCreated,
    time_updated: node.timeUpdated,
  }
}

function snapshotEdge(edge: NormalizedEdge) {
  return {
    id: edge.id,
    project_id: edge.projectID,
    session_id: edge.sessionID,
    source_id: edge.sourceNodeID,
    target_id: edge.targetNodeID,
    relation: edge.relation,
    confidence: edge.confidence,
    time_created: edge.timeCreated,
  }
}

function currentGraph(db: QueryDatabase, sessionID: string) {
  return Effect.gen(function* () {
    const currentNodes = yield* db.all<Row>(sql`SELECT * FROM graph_node WHERE session_id = ${sessionID} ORDER BY id`)
    const currentEdges = yield* db.all<Row>(sql`SELECT * FROM graph_edge WHERE session_id = ${sessionID} ORDER BY id`)
    if (currentNodes.length > 0) return graphFromRows(currentNodes, currentEdges)
    const version = yield* db.get<{ snapshot: unknown }>(sql`
      SELECT snapshot FROM graph_version
      WHERE session_id = ${sessionID}
        AND (message IS NULL OR message NOT LIKE 'product-migration:enhancement:%')
      ORDER BY version_number DESC
      LIMIT 1
    `)
    if (!version) return { nodes: [], edges: [] }
    const snapshot = record(version.snapshot)
    if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return { nodes: [], edges: [] }
    return graphFromRows(snapshot.nodes.map(record), snapshot.edges.map(record))
  })
}

function graphFromRows(nodeRows: ReadonlyArray<Row>, edgeRows: ReadonlyArray<Row>) {
  const nodes = nodeRows.map(
    (row): NormalizedNode => ({
      sourceID: migrationContent(record(row.content)).sourceID ?? "",
      id: text(row, "id"),
      projectID: text(row, "project_id"),
      sessionID: text(row, "session_id"),
      type: Option.getOrThrow(nodeType(row.type)),
      name: text(row, "name"),
      level: Option.getOrThrow(level(row.level)),
      priority: Option.getOrUndefined(priority(row.priority)) ?? null,
      category: nullableText(row, "category"),
      status: Option.getOrThrow(nodeStatus(row.status)),
      desc: nullableText(row, "desc"),
      content: record(row.content),
      verification: Option.getOrUndefined(verification(json(row.verification))) ?? null,
      codeHash: nullableText(row, "code_hash"),
      testStatus: Option.getOrThrow(testStatus(row.test_status)),
      confidence: number(row, "confidence", 1),
      timeCreated: integer(row, "time_created", 0),
      timeUpdated: integer(row, "time_updated", 0),
    }),
  )
  const edges = edgeRows.map(
    (row): NormalizedEdge => ({
      sourceID: text(row, "id"),
      id: text(row, "id"),
      projectID: text(row, "project_id"),
      sessionID: text(row, "session_id"),
      sourceNodeID: text(row, "source_id"),
      targetNodeID: text(row, "target_id"),
      relation: Option.getOrThrow(edgeRelation(row.relation)),
      confidence: number(row, "confidence", 1),
      timeCreated: integer(row, "time_created", 0),
    }),
  )
  return { nodes, edges }
}

function updateSessionStatus(db: QueryDatabase, target: TargetSession) {
  const marker = record(target.metadata.productMigration)
  const status: ImportedGraph["status"] =
    marker.detached === true ? "needs_attention" : marker.status === "needs_attention" ? "needs_attention" : "ready"
  const checkpoint = status === "ready" ? "none" : "paused"
  const metadata = {
    ...target.metadata,
    productMigration: { ...marker, status, checkpoint, graphReconstructed: true },
  }
  return db
    .run(sql`UPDATE session SET metadata = ${JSON.stringify(metadata)} WHERE id = ${target.targetID}`)
    .pipe(Effect.as(status))
}

function adoptEntity(
  db: QueryDatabase,
  context: MappingContext,
  entityType: "graph_node" | "graph_edge" | "graph_version" | "graph_evidence" | "graph_generation",
  sourceID: string,
) {
  return Effect.gen(function* () {
    const candidate = targetID(entityType, sourceID)
    yield* db.run(sql`
      INSERT INTO product_migration_entity
        (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
      VALUES
        (${context.migrationID}, ${entityType}, ${sourceID}, ${context.sourceFingerprint}, ${candidate}, 0, 0)
      ON CONFLICT(migration_id, entity_type, source_id) DO NOTHING
    `)
    const row = yield* db.get<{ source_fingerprint: string; target_id: string }>(sql`
      SELECT source_fingerprint, target_id FROM product_migration_entity
      WHERE migration_id = ${context.migrationID} AND entity_type = ${entityType} AND source_id = ${sourceID}
    `)
    if (!row || row.source_fingerprint !== context.sourceFingerprint) {
      return yield* new ImportError({
        operation: "adopt Graph entity mapping",
        sourceID,
        cause: new Error(!row ? "Mapping was not inserted" : "Source fingerprint changed"),
      })
    }
    return row.target_id
  })
}

function targetID(
  entityType: "graph_node" | "graph_edge" | "graph_version" | "graph_evidence" | "graph_generation",
  sourceID: string,
) {
  const digest = createHash("sha256").update(`${entityType}\0${sourceID}\0${randomUUID()}`).digest("hex")
  if (entityType === "graph_node") return `gnd_${digest}`
  if (entityType === "graph_edge") return `ged_${digest}`
  if (entityType === "graph_version") return `gvr_${digest}`
  if (entityType === "graph_generation") return `ggr_${digest}`
  return `gtr_${digest}`
}

function destinationID(prefix: "ged" | "geh" | "gnd" | "gvr", identity: string) {
  return `${prefix}_${createHash("sha256").update(`${prefix}\0${identity}`).digest("hex")}`
}

function reconstructedSourceID(kind: string, sourceSessionID: string, identity: string) {
  const digest = createHash("sha256")
    .update(`product-migration-graph\0${kind}\0${sourceSessionID}\0${identity}`)
    .digest("hex")
  return `reconstructed:${kind}:${digest}`
}

function migrationContent(content: Row) {
  const marker = record(content.migration)
  return { sourceID: typeof marker.source_id === "string" ? marker.source_id : undefined }
}

function inferredProvenance(input: EnhancementFact, model: Model.Ref) {
  return {
    source_message_ids: [...new Set(input.sourceMessageIDs)],
    provenance: "inferred",
    confidence: boundedConfidence(input.confidence),
    model,
  }
}

function useful(text: string) {
  const normalized = text.trim().toLowerCase()
  return (
    normalized.length > 0 &&
    !/^(?:all\s+)?tasks?\s+(?:are\s+)?(?:implemented|complete|completed|done)(?:\s+and\s+verified)?[.!]*$/.test(
      normalized,
    )
  )
}

function boundedEnhancementHistory(history: ReadonlyArray<HistoryEntry>) {
  const selected = history.reduce<{ entries: HistoryEntry[]; bytes: number; truncated: boolean }>(
    (state, entry) => {
      if (state.entries.length >= ENHANCEMENT_MAX_MESSAGES || state.bytes >= ENHANCEMENT_MAX_BYTES) {
        return { ...state, truncated: true }
      }
      const remaining = ENHANCEMENT_MAX_BYTES - state.bytes
      const redacted = redactEnhancementHistory(entry.text)
      const text = truncateUtf8(redacted, remaining)
      if (!text) return { ...state, truncated: true }
      const bytes = Buffer.byteLength(text, "utf8")
      return {
        entries: [...state.entries, { ...entry, text }],
        bytes: state.bytes + bytes,
        truncated: state.truncated || text !== redacted,
      }
    },
    { entries: [], bytes: 0, truncated: false },
  )
  return {
    entries: selected.entries,
    bounds: { maxMessages: ENHANCEMENT_MAX_MESSAGES, maxBytes: ENHANCEMENT_MAX_BYTES },
    truncation: {
      truncated: selected.truncated || selected.entries.length < history.length,
      availableMessages: history.length,
      selectedMessages: selected.entries.length,
      selectedBytes: selected.bytes,
    },
  }
}

function redactEnhancementHistory(value: string) {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g,
      "$1=[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(
      /\b(?:sk|pk|ghp|github_pat|xox[baprs]|sk-ant-api\d+|hf_|npm_|glpat-|pypi-)-?[A-Za-z0-9_-]{8,}\b/gi,
      "[REDACTED TOKEN]",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[REDACTED HIGH ENTROPY]")
}

function redactHistory(value: string) {
  return value
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]*(?:secret|token|password)[A-Za-z0-9_-]{4,}\b/gi, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
}

function auditText(value: string | null) {
  return value === null ? null : truncateUtf8(redactHistory(value), 1_024)
}

function boundedID(value: string) {
  return truncateUtf8(redactHistory(value), 256)
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  return [...value].reduce(
    (result, character) => (Buffer.byteLength(result + character, "utf8") <= maxBytes ? result + character : result),
    "",
  )
}

function record(value: unknown): Row {
  const parsed = json(value)
  return isRecord(parsed) ? parsed : {}
}

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (!value.trim()) return undefined
  return JSON.parse(value)
}

function text(row: Row, key: string, fallback?: string) {
  const value = row[key]
  if (typeof value === "string") return value
  if (fallback !== undefined) return fallback
  throw new Error(`Expected string column ${key}`)
}

function nullableText(row: Row, key: string) {
  const value = row[key]
  return typeof value === "string" ? value : null
}

function number(row: Row, key: string, fallback: number) {
  const value = row[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function integer(row: Row, key: string, fallback: number) {
  return Math.trunc(number(row, key, fallback))
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function boundedConfidence(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function toolRunType(value: string): value is NormalizedEvidence["toolType"] {
  return ["graph", "local", "mcp", "permission", "artifact", "diagnostics"].includes(value)
}

function toolRunStatus(value: string): value is NormalizedEvidence["status"] {
  return ["succeeded", "failed", "blocked", "dry_run"].includes(value)
}
