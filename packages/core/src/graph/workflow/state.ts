export * as GraphWorkflowState from "./state"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { CheckpointKind, CheckpointStatus, ExecutionMode } from "@opencode-ai/schema/graph"
import { Database } from "../../database/database"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import * as GraphStorage from "../storage"
import type { GraphView, NodeID } from "../storage"
import { nearestCompositeIDs, orderedAtomicNodes } from "./order"
import { GraphWorkflowStateTable } from "./state.sql"

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
  readonly approve: (input: { readonly sessionID: string; readonly expectedRevision: number }) => Effect.Effect<State, RevisionConflict>
  readonly pause: (input: {
    readonly sessionID: string
    readonly expectedRevision: number
    readonly reason?: string
  }) => Effect.Effect<State, RevisionConflict>
  readonly advanceVerified: (input: {
    readonly sessionID: string
    readonly nodeID: NodeID
    readonly graph: GraphView
  }) => Effect.Effect<State, ModuleScopeError>
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
            return fromRow(row)
          }),
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
            const currentNodeID = ordered[0]?.id ?? null
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
            return fromRow(row)
          }),
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
            const current = yield* requireState(get, input.sessionID, input.expectedRevision)
            if (current.checkpointStatus === "approved") return current
            const row = yield* database.db
              .update(GraphWorkflowStateTable)
              .set({ checkpoint_status: "approved" })
              .where(eq(GraphWorkflowStateTable.session_id, input.sessionID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            return fromRow(row)
          }),
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
            return fromRow(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const advanceVerified = Effect.fn("GraphWorkflowState.advanceVerified")(function* (input: {
      readonly sessionID: string
      readonly nodeID: NodeID
      readonly graph: GraphView
    }) {
      return yield* database.db
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* get(input.sessionID)
            if (!current) return yield* Effect.die(new Error(`Workflow state not found: ${input.sessionID}`))
            const verified = input.graph.nodes.find((node) => node.id === input.nodeID)
            if (current.currentNodeID !== input.nodeID || verified?.status !== "verified" || verified.testStatus !== "passed") {
              return current
            }
            const ordered = orderedAtomicNodes(input.graph)
            const remaining = ordered
              .slice(ordered.findIndex((node) => node.id === input.nodeID) + 1)
              .filter((node) => node.status !== "verified")
            const next = current.mode === "module"
              ? yield* nextModuleTask(input.graph, input.nodeID, ordered.filter((node) => node.status !== "verified"))
              : remaining[0]
            const transition = yield* advancement(input.graph, current, input.nodeID, next?.id ?? null)
            const row = yield* database.db
              .update(GraphWorkflowStateTable)
              .set({ ...transition, revision: current.revision + 1 })
              .where(eq(GraphWorkflowStateTable.session_id, input.sessionID))
              .returning()
              .get()
              .pipe(Effect.orDie)
            return fromRow(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ get, setMode, resetPlan, approve, pause, advanceVerified })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, GraphStorage.node] })

export const defaultLayer = layer.pipe(
  Layer.provide(GraphStorage.defaultLayer),
  Layer.provide(Database.layerFromPath(Database.path())),
)

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
