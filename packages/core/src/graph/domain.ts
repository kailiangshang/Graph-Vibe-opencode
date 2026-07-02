export * as GraphDomain from "./domain"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import * as GraphStorage from "./storage"
import type { NodeRow, EdgeRow, NodeID, EdgeID } from "./storage"
import { validateNode, validateEdge, validateSubgraph } from "./validation"
import type { ValidationIssue } from "./validation"
import { detectConflicts as detectConflictsPure } from "./conflict"
import type { Conflict } from "./conflict"
import { assessImpact as assessImpactPure } from "./impact"
import type { ImpactResult } from "./impact"
import { findPath as findPathPure } from "./traversal"

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("GraphV2.ValidationError", {
  rule: Schema.String,
  message: Schema.String,
  context: Schema.Unknown.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly storage: GraphStorage.Interface
  readonly node: {
    readonly create: (input: GraphStorage.NodeCreate) => Effect.Effect<NodeID, ValidationError | GraphStorage.NotFoundError>
    readonly update: (id: NodeID, patch: GraphStorage.NodePatch) => Effect.Effect<void, ValidationError | GraphStorage.NotFoundError>
    readonly get: (id: NodeID) => Effect.Effect<NodeRow, GraphStorage.NotFoundError>
    readonly delete: (id: NodeID) => Effect.Effect<void>
    readonly list: (filter: GraphStorage.NodeFilter) => Effect.Effect<ReadonlyArray<NodeRow>>
  }
  readonly edge: {
    readonly create: (input: GraphStorage.EdgeCreate) => Effect.Effect<EdgeID, ValidationError | GraphStorage.NotFoundError>
    readonly get: (id: EdgeID) => Effect.Effect<EdgeRow, GraphStorage.NotFoundError>
    readonly delete: (id: EdgeID) => Effect.Effect<void>
    readonly list: (filter: GraphStorage.EdgeFilter) => Effect.Effect<ReadonlyArray<EdgeRow>>
  }
  readonly main: (input: { projectID: NodeRow["projectID"] }) => Effect.Effect<GraphStorage.GraphView>
  readonly currentPlan: (input: { sessionID: string }) => Effect.Effect<GraphStorage.GraphView>
  readonly promote: (input: GraphStorage.PromoteInput) => Effect.Effect<GraphStorage.PromoteResult>
  readonly version: {
    readonly list: (input: { projectID: NodeRow["projectID"] }) => Effect.Effect<ReadonlyArray<GraphStorage.VersionRow>>
    readonly get: (input: { projectID: NodeRow["projectID"]; versionNumber: number }) => Effect.Effect<GraphStorage.VersionRow, GraphStorage.NotFoundError>
  }
  readonly detectConflicts: (input: { projectID: NodeRow["projectID"]; sessionID: string }) => Effect.Effect<Conflict[]>
  readonly validateSubgraph: (input: { projectID: NodeRow["projectID"]; sessionID: string }) => Effect.Effect<{ issues: ValidationIssue[]; valid: boolean }>
  readonly assessImpact: (input: { projectID: NodeRow["projectID"]; nodeID: NodeID }) => Effect.Effect<ImpactResult>
  readonly findPath: (input: { projectID: NodeRow["projectID"]; sourceID: NodeID; targetID: NodeID }) => Effect.Effect<NodeID[] | null>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphDomain") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* GraphStorage.Service

    const nodeCreate = Effect.fn("GraphDomain.node.create")(function* (input: GraphStorage.NodeCreate) {
      const tempNode: NodeRow = {
        id: "" as NodeID, projectID: input.projectID, sessionID: input.sessionID ?? null,
        type: input.type, name: input.name, level: input.level, priority: input.priority ?? null,
        category: input.category ?? null, status: input.status ?? "pending", desc: input.desc ?? null,
        content: input.content ?? null, codeHash: input.codeHash ?? null,
        testStatus: input.testStatus ?? "none", confidence: input.confidence ?? 1,
        timeCreated: 0, timeUpdated: 0,
      }
      const issues = validateNode(tempNode)
      if (issues.length > 0) return yield* new ValidationError({ rule: issues[0].rule, message: issues[0].message })
      return yield* storage.node.create(input)
    })

    const nodeUpdate = Effect.fn("GraphDomain.node.update")(function* (id: NodeID, patch: GraphStorage.NodePatch) {
      const existing = yield* storage.node.get(id)
      const merged: NodeRow = { ...existing, ...patch } as NodeRow
      const issues = validateNode(merged)
      if (issues.length > 0) return yield* new ValidationError({ rule: issues[0].rule, message: issues[0].message })
      yield* storage.node.update(id, patch)
    })

    const edgeCreate = Effect.fn("GraphDomain.edge.create")(function* (input: GraphStorage.EdgeCreate) {
      const source = yield* storage.node.get(input.sourceID)
      const target = yield* storage.node.get(input.targetID)
      const tempEdge: EdgeRow = {
        id: "" as EdgeID, projectID: input.projectID, sessionID: input.sessionID ?? null,
        sourceID: input.sourceID, targetID: input.targetID, relation: input.relation,
        confidence: input.confidence ?? 1, timeCreated: 0,
      }
      const issues = validateEdge(source, target, tempEdge)
      if (issues.length > 0) return yield* new ValidationError({ rule: issues[0].rule, message: issues[0].message })
      return yield* storage.edge.create(input)
    })

    const detectConflictsFn = Effect.fn("GraphDomain.detectConflicts")(function* (input: { projectID: NodeRow["projectID"]; sessionID: string }) {
      const main = yield* storage.main({ projectID: input.projectID })
      const plan = yield* storage.currentPlan({ sessionID: input.sessionID })
      return detectConflictsPure(plan, main)
    })

    const validateSubgraphFn = Effect.fn("GraphDomain.validateSubgraph")(function* (input: { projectID: NodeRow["projectID"]; sessionID: string }) {
      const plan = yield* storage.currentPlan({ sessionID: input.sessionID })
      const issues = validateSubgraph(plan.nodes as NodeRow[], plan.edges as EdgeRow[])
      return { issues, valid: issues.length === 0 }
    })

    const assessImpactFn = Effect.fn("GraphDomain.assessImpact")(function* (input: { projectID: NodeRow["projectID"]; nodeID: NodeID }) {
      const main = yield* storage.main({ projectID: input.projectID })
      return assessImpactPure(input.nodeID, main.nodes as NodeRow[], main.edges as EdgeRow[])
    })

    const findPathFn = Effect.fn("GraphDomain.findPath")(function* (input: { projectID: NodeRow["projectID"]; sourceID: NodeID; targetID: NodeID }) {
      const main = yield* storage.main({ projectID: input.projectID })
      return findPathPure(input.sourceID, input.targetID, main.edges as EdgeRow[])
    })

    return Service.of({
      storage,
      node: { create: nodeCreate, update: nodeUpdate, get: storage.node.get, delete: storage.node.delete, list: storage.node.list },
      edge: { create: edgeCreate, get: storage.edge.get, delete: storage.edge.delete, list: storage.edge.list },
      main: storage.main,
      currentPlan: storage.currentPlan,
      promote: storage.promote,
      version: storage.version,
      detectConflicts: detectConflictsFn,
      validateSubgraph: validateSubgraphFn,
      assessImpact: assessImpactFn,
      findPath: findPathFn,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [GraphStorage.node] })

export const defaultLayer = layer.pipe(Layer.provide(GraphStorage.defaultLayer))
