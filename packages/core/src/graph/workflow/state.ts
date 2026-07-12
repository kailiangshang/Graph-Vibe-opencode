export * as GraphWorkflowState from "./state"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { ArtifactEvidence, CheckpointKind, CheckpointStatus, ExecutionMode, VerificationEvidence } from "@opencode-ai/schema/graph"
import { Database } from "../../database/database"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import * as GraphStorage from "../storage"
import type { GraphView, NodeID } from "../storage"
import { GraphNodeTable } from "../sql"
import { nearestCompositeIDs, orderedAtomicNodes } from "./order"
import { GraphWorkflowStateTable } from "./state.sql"
import * as GraphAudit from "./audit"

export interface State {
  readonly sessionID: string
  readonly projectID: ProjectV2.ID
  readonly mode: ExecutionMode | null
  readonly currentNodeID: NodeID | null
  readonly checkpointKind: CheckpointKind | null
  readonly checkpointScopeNodeID: NodeID | null
  readonly checkpointStatus: CheckpointStatus
  readonly checkpointReason: string | null
  readonly revision: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

export class RevisionConflict extends Schema.TaggedErrorClass<RevisionConflict>()(
  "GraphWorkflowState.RevisionConflict",
  { expectedRevision: Schema.Number, actualRevision: Schema.Number },
) {}

export class ActiveWorkflowError extends Schema.TaggedErrorClass<ActiveWorkflowError>()(
  "GraphWorkflowState.ActiveWorkflowError",
  { sessionID: Schema.String },
) {}

export class ModuleScopeError extends Schema.TaggedErrorClass<ModuleScopeError>()(
  "GraphWorkflowState.ModuleScopeError",
  { nodeID: Schema.String, moduleIDs: Schema.Array(Schema.String) },
) {}

export class CheckpointNotPending extends Schema.TaggedErrorClass<CheckpointNotPending>()(
  "GraphWorkflowState.CheckpointNotPending",
  { status: Schema.Literals(["none", "approved"]) },
) {}

export class PromotionBlocked extends Schema.TaggedErrorClass<PromotionBlocked>()(
  "GraphWorkflowState.PromotionBlocked",
  { reason: Schema.Literals(["mode_required", "checkpoint_pending", "workflow_incomplete"]) },
) {}

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<State | undefined>
  readonly setMode: (input: {
    readonly sessionID: string
    readonly projectID: ProjectV2.ID
    readonly mode: ExecutionMode
    readonly expectedRevision: number
  }) => Effect.Effect<State, RevisionConflict | ActiveWorkflowError | ModuleScopeError>
  readonly resetPlan: (input: {
    readonly sessionID: string
    readonly projectID: ProjectV2.ID
    readonly graph: GraphView
  }) => Effect.Effect<State, ModuleScopeError>
  readonly approve: (input: {
    readonly sessionID: string
    readonly expectedRevision: number
  }) => Effect.Effect<State, RevisionConflict | CheckpointNotPending>
  readonly pause: (input: {
    readonly sessionID: string
    readonly expectedRevision: number
    readonly reason?: string
  }) => Effect.Effect<State, RevisionConflict>
  readonly advanceVerified: (input: {
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly graph: GraphView
    readonly expectedRevision: number
  }) => Effect.Effect<State, RevisionConflict | ModuleScopeError>
  readonly completeVerification: (input: {
    readonly projectID: ProjectV2.ID
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly expectedRevision: number
    readonly evidence: VerificationEvidence
    readonly inputSummary?: string
    readonly outputSummary?: string
  }) => Effect.Effect<State, RevisionConflict | ModuleScopeError>
  readonly artifactApplied: (input: {
    readonly projectID: ProjectV2.ID
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly evidence: ArtifactEvidence
    readonly inputSummary?: string
    readonly outputSummary?: string
  }) => Effect.Effect<State>
  readonly failVerification: (input: {
    readonly projectID: ProjectV2.ID
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly expectedRevision: number
    readonly evidence: VerificationEvidence
    readonly inputSummary?: string
    readonly outputSummary?: string
  }) => Effect.Effect<State, RevisionConflict>
  readonly fail: (input: {
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly reason: string
  }) => Effect.Effect<State>
  readonly promote: (input: GraphStorage.PromoteInput) => Effect.Effect<GraphStorage.PromoteResult, PromotionBlocked>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphWorkflowState") {}

const fromRow = (row: typeof GraphWorkflowStateTable.$inferSelect): State => ({
  sessionID: row.session_id,
  projectID: row.project_id,
  mode: row.mode,
  currentNodeID: row.current_node_id,
  checkpointKind: row.checkpoint_kind,
  checkpointScopeNodeID: row.checkpoint_scope_node_id,
  checkpointStatus: row.checkpoint_status,
  checkpointReason: row.checkpoint_reason,
  revision: row.revision,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service

    const recordTransition = (input: {
      readonly state: State
      readonly toolName: string
      readonly nodeID?: NodeID
      readonly status?: GraphAudit.ToolRunCreate["status"]
      readonly inputSummary?: string
      readonly outputSummary?: string
    }) => audit.tool.record({
      projectID: input.state.projectID,
      sessionID: input.state.sessionID,
      nodeID: input.nodeID,
      toolName: input.toolName,
      toolType: "graph",
      status: input.status ?? "succeeded",
      inputSummary: input.inputSummary?.slice(0, 1_024),
      outputSummary: input.outputSummary?.slice(0, 1_024),
    })

    const get = Effect.fn("GraphWorkflowState.get")(function* (sessionID: string) {
      const row = yield* database.db
        .select()
        .from(GraphWorkflowStateTable)
        .where(eq(GraphWorkflowStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const setMode = Effect.fn("GraphWorkflowState.setMode")(function* (input: {
      readonly sessionID: string
      readonly projectID: ProjectV2.ID
      readonly mode: ExecutionMode
      readonly expectedRevision: number
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            const revision = current?.revision ?? 0
            if (revision !== input.expectedRevision) {
              return yield* new RevisionConflict({ expectedRevision: input.expectedRevision, actualRevision: revision })
            }
            if (
              current &&
              current.mode !== null &&
              current.currentNodeID !== null &&
              current.checkpointStatus !== "pending"
            ) {
              return yield* new ActiveWorkflowError({ sessionID: input.sessionID })
            }
            const graph = current?.currentNodeID
              ? yield* storage.currentPlan({ sessionID: input.sessionID })
              : undefined
            if (input.mode === "module" && graph) {
              yield* Effect.forEach(orderedAtomicNodes(graph), (node) => requireModule(graph, node.id), { discard: true })
            }
            const scope = current?.currentNodeID
              ? input.mode === "module"
                ? yield* requireModule(graph ?? { nodes: [], edges: [] }, current.currentNodeID)
                : input.mode === "atomic"
                  ? current.currentNodeID
                  : null
              : null
            const initialSelection = current?.mode === null
            const checkpointStatus = current?.currentNodeID
              ? initialSelection
                ? input.mode === "autopilot" ? "none" : "approved"
                : current.checkpointStatus
              : "none"
            const hardCheckpoint = current?.checkpointKind === "pause" || current?.checkpointKind === "decision" || current?.checkpointKind === "failure"
            const checkpointKind = current?.currentNodeID
              ? initialSelection
                ? input.mode === "autopilot" ? null : input.mode
                : hardCheckpoint || input.mode === "autopilot" ? current?.checkpointKind ?? null : input.mode
              : null
            const row = yield* database.db
              .insert(GraphWorkflowStateTable)
              .values({
                session_id: input.sessionID,
                project_id: input.projectID,
                mode: input.mode,
                checkpoint_kind: checkpointKind,
                checkpoint_scope_node_id: scope,
                checkpoint_status: checkpointStatus,
                revision: revision + 1,
              })
              .onConflictDoUpdate({
                target: GraphWorkflowStateTable.session_id,
                set: {
                  mode: input.mode,
                  checkpoint_kind: checkpointKind,
                  checkpoint_scope_node_id: scope,
                  checkpoint_status: checkpointStatus,
                  revision: revision + 1,
                },
              })
              .returning()
              .get()
              .pipe(Effect.orDie)
            const state = fromRow(row)
            yield* recordTransition({
              state,
              toolName: "graph.workflow.mode.changed",
              nodeID: state.currentNodeID ?? undefined,
              inputSummary: `mode=${current?.mode ?? "none"}`,
              outputSummary: `mode=${state.mode} revision=${state.revision}`,
            })
            return state
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const resetPlan = Effect.fn("GraphWorkflowState.resetPlan")(function* (input: {
      readonly sessionID: string
      readonly projectID: ProjectV2.ID
      readonly graph: GraphView
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            const ordered = orderedAtomicNodes(input.graph)
            if (current?.mode === "module") {
              yield* Effect.forEach(ordered, (node) => requireModule(input.graph, node.id), { discard: true })
            }
            const currentNodeID = ordered.find((node) => isReady(input.graph, node.id))?.id ?? null
            const scope = current?.mode === "module" && currentNodeID
              ? yield* requireModule(input.graph, currentNodeID)
              : current?.mode === "atomic"
                ? currentNodeID
                : null
            const checkpointKind = currentNodeID && current?.mode !== "autopilot" ? current?.mode ?? null : null
            const checkpointStatus = currentNodeID && current?.mode ? current.mode === "autopilot" ? "none" : "approved" : "none"
            const row = yield* database.db
              .insert(GraphWorkflowStateTable)
              .values({
                session_id: input.sessionID,
                project_id: input.projectID,
                mode: current?.mode ?? null,
                current_node_id: currentNodeID,
                checkpoint_kind: checkpointKind,
                checkpoint_scope_node_id: scope,
                checkpoint_status: checkpointStatus,
                checkpoint_reason: null,
                revision: (current?.revision ?? 0) + 1,
              })
              .onConflictDoUpdate({
                target: GraphWorkflowStateTable.session_id,
                set: {
                  project_id: input.projectID,
                  current_node_id: currentNodeID,
                  checkpoint_kind: checkpointKind,
                  checkpoint_scope_node_id: scope,
                  checkpoint_status: checkpointStatus,
                  checkpoint_reason: null,
                  revision: (current?.revision ?? 0) + 1,
                },
              })
              .returning()
              .get()
              .pipe(Effect.orDie)
            const state = fromRow(row)
            if (state.currentNodeID !== current?.currentNodeID) {
              yield* recordTransition({
                state,
                toolName: "graph.workflow.current_task.changed",
                nodeID: state.currentNodeID ?? undefined,
                inputSummary: `from=${current?.currentNodeID ?? "none"}`,
                outputSummary: `to=${state.currentNodeID ?? "none"} revision=${state.revision}`,
              })
            }
            return state
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const approve = Effect.fn("GraphWorkflowState.approve")(function* (input: {
      readonly sessionID: string
      readonly expectedRevision: number
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const existing = yield* get(input.sessionID)
            if (
              existing?.checkpointStatus === "approved" &&
              existing.revision === input.expectedRevision + 1
            ) {
              const records = yield* audit.tool.list({ projectID: existing.projectID, sessionID: input.sessionID })
              if (records.some((record) =>
                record.toolName === "graph.workflow.checkpoint.approved" &&
                record.outputSummary === `revision=${existing.revision}`
              )) return existing
            }
            const current = yield* requireState(get, input.sessionID, input.expectedRevision)
            if (current.checkpointStatus === "approved") return current
            if (current.checkpointStatus !== "pending") {
              return yield* new CheckpointNotPending({ status: current.checkpointStatus })
            }
            const row = yield* database.db
              .update(GraphWorkflowStateTable)
              .set({ checkpoint_status: "approved", revision: current.revision + 1 })
              .where(eq(GraphWorkflowStateTable.session_id, input.sessionID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            const state = fromRow(row)
            yield* recordTransition({
              state,
              toolName: "graph.workflow.checkpoint.approved",
              nodeID: state.currentNodeID ?? undefined,
              inputSummary: `kind=${state.checkpointKind ?? "none"}`,
              outputSummary: `revision=${state.revision}`,
            })
            return state
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const pause = Effect.fn("GraphWorkflowState.pause")(function* (input: {
      readonly sessionID: string
      readonly expectedRevision: number
      readonly reason?: string
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* requireState(get, input.sessionID, input.expectedRevision)
            const row = yield* database.db
              .update(GraphWorkflowStateTable)
              .set({
                checkpoint_kind: "pause",
                checkpoint_scope_node_id: current.checkpointScopeNodeID ?? current.currentNodeID,
                checkpoint_status: "pending",
                checkpoint_reason: input.reason ?? null,
                revision: current.revision + 1,
              })
              .where(eq(GraphWorkflowStateTable.session_id, input.sessionID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            const state = fromRow(row)
            yield* recordTransition({
              state,
              toolName: "graph.workflow.paused",
              nodeID: state.currentNodeID ?? undefined,
              inputSummary: input.reason,
              outputSummary: `revision=${state.revision}`,
            })
            yield* recordTransition({
              state,
              toolName: "graph.workflow.checkpoint.requested",
              nodeID: state.checkpointScopeNodeID ?? undefined,
              inputSummary: "kind=pause",
              outputSummary: `revision=${state.revision}`,
            })
            return state
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const advance = (current: State, nodeID: NodeID, graph: GraphView) => Effect.gen(function* () {
      const ordered = orderedAtomicNodes(graph)
      const ready = ordered.filter((node) => isReady(graph, node.id))
      const next = current.mode === "module"
        ? yield* nextModuleTask(graph, nodeID, ready)
        : ready[0]
      const transition = yield* advancement(graph, current, nodeID, next?.id ?? null)
      const row = yield* database.db
        .update(GraphWorkflowStateTable)
        .set({ ...transition, revision: current.revision + 1 })
        .where(and(
          eq(GraphWorkflowStateTable.session_id, current.sessionID),
          eq(GraphWorkflowStateTable.revision, current.revision),
        ))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const latest = yield* get(current.sessionID)
        return yield* new RevisionConflict({
          expectedRevision: current.revision,
          actualRevision: latest?.revision ?? 0,
        })
      }
      const state = fromRow(row)
      yield* recordTransition({
        state,
        toolName: "graph.workflow.task.verified",
        nodeID,
        outputSummary: `revision=${state.revision}`,
      })
      if (state.currentNodeID !== current.currentNodeID) {
        yield* recordTransition({
          state,
          toolName: "graph.workflow.current_task.changed",
          nodeID: state.currentNodeID ?? undefined,
          inputSummary: `from=${current.currentNodeID}`,
          outputSummary: `to=${state.currentNodeID ?? "none"} revision=${state.revision}`,
        })
      }
      if (current.mode === "module") {
        const completedModule = yield* requireModule(graph, nodeID)
        const nextModule = state.currentNodeID ? yield* requireModule(graph, state.currentNodeID) : undefined
        if (moduleComplete(graph, completedModule)) {
          yield* recordTransition({
            state,
            toolName: "graph.workflow.module.completed",
            nodeID: completedModule,
            outputSummary: `next=${nextModule ?? "none"} revision=${state.revision}`,
          })
        }
      }
      if (state.checkpointStatus === "pending") {
        yield* recordTransition({
          state,
          toolName: "graph.workflow.checkpoint.requested",
          nodeID: state.checkpointScopeNodeID ?? undefined,
          inputSummary: `kind=${state.checkpointKind ?? "none"}`,
          outputSummary: `revision=${state.revision}`,
        })
      }
      return state
    })

    const advanceVerified = Effect.fn("GraphWorkflowState.advanceVerified")(function* (input: {
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly graph: GraphView
      readonly expectedRevision: number
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* requireState(get, input.sessionID, input.expectedRevision)
            const verified = input.graph.nodes.find((node) => node.id === input.nodeID)
            if (current.currentNodeID !== input.nodeID || verified?.status !== "verified" || verified.testStatus !== "passed") {
              return current
            }
            return yield* advance(current, input.nodeID, input.graph)
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const completeVerification = Effect.fn("GraphWorkflowState.completeVerification")(function* (input: {
      readonly projectID: ProjectV2.ID
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly expectedRevision: number
      readonly evidence: VerificationEvidence
      readonly inputSummary?: string
      readonly outputSummary?: string
    }) {
      const evidence = GraphAudit.sanitizeEvidence(input.evidence) as VerificationEvidence
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            if (!current || current.revision !== input.expectedRevision) {
              if (current) {
                const target = yield* storage.node.get(input.nodeID).pipe(Effect.orDie)
                const records = yield* audit.tool.list({
                  projectID: input.projectID,
                  sessionID: input.sessionID,
                  nodeID: input.nodeID,
                })
                if (
                  target.status === "verified" &&
                  target.testStatus === "passed" &&
                  records.some((record) =>
                    record.toolName === "graph.diagnostics.run" &&
                    record.status === "succeeded" &&
                    JSON.stringify(record.evidence) === JSON.stringify(evidence)
                  )
                ) return current
              }
              return yield* new RevisionConflict({
                expectedRevision: input.expectedRevision,
                actualRevision: current?.revision ?? 0,
              })
            }
            if (current.currentNodeID !== input.nodeID) return current
            yield* database.db
              .update(GraphNodeTable)
              .set({ status: "verified", test_status: "passed" })
              .where(eq(GraphNodeTable.id, input.nodeID))
              .run()
              .pipe(Effect.orDie)
            yield* audit.tool.record({
              projectID: input.projectID,
              sessionID: input.sessionID,
              nodeID: input.nodeID,
              toolName: "graph.diagnostics.run",
              toolType: "diagnostics",
              status: "succeeded",
              inputSummary: input.inputSummary?.slice(0, 1_024),
              outputSummary: input.outputSummary?.slice(0, 1_024),
              evidence,
            })
            return yield* advance(
              current,
              input.nodeID,
              yield* storage.currentPlan({ sessionID: input.sessionID }),
            )
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const artifactApplied = Effect.fn("GraphWorkflowState.artifactApplied")(function* (input: {
      readonly projectID: ProjectV2.ID
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly evidence: ArtifactEvidence
      readonly inputSummary?: string
      readonly outputSummary?: string
    }) {
      return yield* database.db.transaction(() => Effect.gen(function* () {
        const current = yield* get(input.sessionID)
        if (!current) return yield* Effect.die(new Error(`Workflow state not found: ${input.sessionID}`))
        yield* database.db.update(GraphNodeTable).set({ status: "implemented", test_status: "pending" })
          .where(eq(GraphNodeTable.id, input.nodeID)).run().pipe(Effect.orDie)
        const row = yield* database.db.update(GraphWorkflowStateTable).set({ revision: current.revision + 1 })
          .where(eq(GraphWorkflowStateTable.session_id, input.sessionID)).returning().get().pipe(Effect.orDie)
        yield* audit.tool.record({
          projectID: input.projectID, sessionID: input.sessionID, nodeID: input.nodeID,
          toolName: "graph.artifact.apply", toolType: "artifact", status: "succeeded",
          inputSummary: input.inputSummary, outputSummary: input.outputSummary, evidence: input.evidence,
        })
        return fromRow(row)
      }), { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const failVerification = Effect.fn("GraphWorkflowState.failVerification")(function* (input: {
      readonly projectID: ProjectV2.ID
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly expectedRevision: number
      readonly evidence: VerificationEvidence
      readonly inputSummary?: string
      readonly outputSummary?: string
    }) {
      return yield* database.db.transaction(() => Effect.gen(function* () {
        const current = yield* requireState(get, input.sessionID, input.expectedRevision)
        yield* database.db.update(GraphNodeTable).set({ test_status: "failed" })
          .where(eq(GraphNodeTable.id, input.nodeID)).run().pipe(Effect.orDie)
        yield* audit.tool.record({
          projectID: input.projectID, sessionID: input.sessionID, nodeID: input.nodeID,
          toolName: "graph.diagnostics.run", toolType: "diagnostics", status: "failed",
          inputSummary: input.inputSummary, outputSummary: input.outputSummary, evidence: input.evidence,
        })
        return current
      }), { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const fail = Effect.fn("GraphWorkflowState.fail")(function* (input: {
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly reason: string
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            if (!current) return yield* Effect.die(new Error(`Workflow state not found: ${input.sessionID}`))
            const reason = input.reason.slice(0, 1_024)
            const row = yield* database.db
              .update(GraphWorkflowStateTable)
              .set({
                checkpoint_kind: "failure",
                checkpoint_scope_node_id: input.nodeID,
                checkpoint_status: "pending",
                checkpoint_reason: reason,
                revision: current.revision + 1,
              })
              .where(eq(GraphWorkflowStateTable.session_id, input.sessionID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            const state = fromRow(row)
            yield* recordTransition({
              state,
              toolName: "graph.workflow.failed",
              nodeID: input.nodeID,
              status: "failed",
              inputSummary: reason,
              outputSummary: `revision=${state.revision}`,
            })
            yield* recordTransition({
              state,
              toolName: "graph.workflow.checkpoint.requested",
              nodeID: input.nodeID,
              inputSummary: "kind=failure",
              outputSummary: `revision=${state.revision}`,
            })
            return state
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const promote = Effect.fn("GraphWorkflowState.promote")(function* (input: GraphStorage.PromoteInput) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            if (current?.checkpointStatus === "pending") {
              return yield* new PromotionBlocked({ reason: "checkpoint_pending" })
            }
            if (!current?.mode) return yield* new PromotionBlocked({ reason: "mode_required" })
            const graph = yield* storage.currentPlan({ sessionID: input.sessionID })
            const tasks = orderedAtomicNodes(graph)
            if (
              current.currentNodeID !== null ||
              tasks.length === 0 ||
              tasks.some((node) => node.status !== "verified" || node.testStatus !== "passed")
            ) {
              return yield* new PromotionBlocked({ reason: "workflow_incomplete" })
            }
            return yield* storage.promote(input)
          }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ get, setMode, resetPlan, approve, pause, advanceVerified, completeVerification, artifactApplied, failVerification, fail, promote })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, GraphStorage.node, GraphAudit.node],
})

export const layerFromDatabase = (database: Layer.Layer<Database.Service>) => {
  const storage = GraphStorage.layer.pipe(Layer.provideMerge(database))
  const audit = GraphAudit.layer.pipe(Layer.provideMerge(storage))
  return layer.pipe(Layer.provideMerge(audit))
}

export const defaultLayer = layerFromDatabase(Database.layerFromPath(Database.path()))

function requireState(
  get: Interface["get"],
  sessionID: string,
  expectedRevision: number,
): Effect.Effect<State, RevisionConflict> {
  return Effect.gen(function* () {
    const current = yield* get(sessionID)
    if (!current || current.revision !== expectedRevision) {
      return yield* new RevisionConflict({ expectedRevision, actualRevision: current?.revision ?? 0 })
    }
    return current
  })
}

function requireModule(graph: GraphView, nodeID: NodeID) {
  const modules = nearestCompositeIDs(graph, nodeID)
  if (modules.length !== 1) return new ModuleScopeError({ nodeID, moduleIDs: modules })
  return Effect.succeed(modules[0])
}

function advancement(graph: GraphView, state: State, completedNodeID: NodeID, nextNodeID: NodeID | null) {
  if (!nextNodeID) {
    return Effect.succeed({
      current_node_id: null,
      checkpoint_kind: null,
      checkpoint_scope_node_id: null,
      checkpoint_status: "none" as const,
      checkpoint_reason: null,
    })
  }
  if (state.mode === "atomic") {
    return Effect.succeed({
      current_node_id: nextNodeID,
      checkpoint_kind: "atomic" as const,
      checkpoint_scope_node_id: nextNodeID,
      checkpoint_status: "pending" as const,
      checkpoint_reason: null,
    })
  }
  if (state.mode === "module") {
    return Effect.gen(function* () {
      const completedModule = yield* requireModule(graph, completedNodeID)
      const nextModule = yield* requireModule(graph, nextNodeID)
      return {
        current_node_id: nextNodeID,
        checkpoint_kind: "module" as const,
        checkpoint_scope_node_id: nextModule,
        checkpoint_status: completedModule === nextModule ? "approved" as const : "pending" as const,
        checkpoint_reason: null,
      }
    })
  }
  return Effect.succeed({
    current_node_id: nextNodeID,
    checkpoint_kind: null,
    checkpoint_scope_node_id: null,
    checkpoint_status: "none" as const,
    checkpoint_reason: null,
  })
}

function nextModuleTask(graph: GraphView, completedNodeID: NodeID, candidates: ReadonlyArray<GraphStorage.NodeRow>) {
  return Effect.gen(function* () {
    const completedModule = yield* requireModule(graph, completedNodeID)
    const scoped = yield* Effect.forEach(candidates, (node) =>
      Effect.map(requireModule(graph, node.id), (moduleID) => ({ node, moduleID })),
    )
    return scoped.find((item) => item.moduleID === completedModule)?.node ?? scoped[0]?.node
  })
}

function isReady(graph: GraphView, nodeID: NodeID) {
  const node = graph.nodes.find((item) => item.id === nodeID)
  if (!node || node.status === "verified" || node.status === "deprecated") return false
  return graph.edges
    .filter((edge) => edge.relation === "blocks" && edge.targetID === nodeID)
    .every((edge) => graph.nodes.find((item) => item.id === edge.sourceID)?.status === "verified")
}

function moduleComplete(graph: GraphView, moduleID: NodeID) {
  const tasks = orderedAtomicNodes(graph).filter((node) => nearestCompositeIDs(graph, node.id)[0] === moduleID)
  return tasks.length > 0 && tasks.every((node) => node.status === "verified")
}
