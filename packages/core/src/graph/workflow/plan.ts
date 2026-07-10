export * as GraphPlan from "./plan"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../../effect/layer-node"
import { Database } from "../../database/database"
import * as GraphDomain from "../domain"
import * as GraphStorage from "../storage"
import { validateSubgraph } from "../validation"
import type { EdgeRow, NodeRow } from "../storage"
import type { ProjectV2 } from "../../project"
import * as GraphWorkflowState from "./state"

export type PlanNodeCreate = Omit<GraphStorage.NodeCreate, "projectID" | "sessionID">
export type PlanEdgeCreate = Omit<GraphStorage.EdgeCreate, "projectID" | "sessionID" | "sourceID" | "targetID"> & {
  sourceID: string
  targetID: string
}

export interface AdmitPlanInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly nodes: ReadonlyArray<PlanNodeCreate>
  readonly edges: ReadonlyArray<PlanEdgeCreate>
  readonly dryRun?: boolean
}

export interface AdmitPlanResult {
  readonly nodesCreated: number
  readonly edgesCreated: number
  readonly dryRun: boolean
}

export interface Interface {
  readonly admit: (input: AdmitPlanInput) => Effect.Effect<
    AdmitPlanResult,
    GraphDomain.ValidationError | GraphStorage.NotFoundError | GraphWorkflowState.ModuleScopeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphPlan") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const domain = yield* GraphDomain.Service
    const workflow = yield* GraphWorkflowState.Service

    const admit = Effect.fn("GraphPlan.admit")(function* (input: AdmitPlanInput) {
      const issues = validatePlan(input)
      if (issues.length > 0) return yield* new GraphDomain.ValidationError({ rule: issues[0].rule, message: issues[0].message })
      if (input.dryRun) return { nodesCreated: input.nodes.length, edgesCreated: input.edges.length, dryRun: true }

      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const nodeIDs: GraphStorage.NodeID[] = []
          yield* Effect.forEach(input.nodes, (node) =>
            Effect.gen(function* () {
              const id = yield* domain.node.create({
                ...node,
                verification: node.type === "atomic" ? node.verification : undefined,
                projectID: input.projectID,
                sessionID: input.sessionID,
              })
              nodeIDs.push(id)
            }),
          )
          const resolveRef = Effect.fn("GraphPlan.resolveRef")(function* (ref: string) {
            if (ref.startsWith("@")) {
              const idx = Number.parseInt(ref.slice(1), 10)
              const resolved = nodeIDs[idx]
              if (!resolved) {
                return yield* new GraphDomain.ValidationError({
                  rule: "edge.dangling_endpoint",
                  message: `edge references unknown node index: ${ref}`,
                  context: { ref, nodeCount: nodeIDs.length },
                })
              }
              return resolved
            }
            return ref as GraphStorage.NodeID
          })
          yield* Effect.forEach(input.edges, (edge) =>
            Effect.gen(function* () {
              const sourceID = yield* resolveRef(edge.sourceID)
              const targetID = yield* resolveRef(edge.targetID)
              return yield* domain.edge.create({
                ...edge,
                sourceID,
                targetID,
                projectID: input.projectID,
                sessionID: input.sessionID,
              })
            }),
          )
          yield* workflow.resetPlan({
            projectID: input.projectID,
            sessionID: input.sessionID,
            graph: yield* domain.currentPlan({ sessionID: input.sessionID }),
          })
          return { nodesCreated: input.nodes.length, edgesCreated: input.edges.length, dryRun: false }
        }),
      ).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    return Service.of({ admit })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, GraphDomain.node, GraphWorkflowState.node],
})

export const defaultLayer = layer.pipe(
  Layer.provide(GraphDomain.defaultLayer),
  Layer.provide(GraphWorkflowState.defaultLayer),
  Layer.provide(Database.layerFromPath(Database.path())),
)

function validatePlan(input: AdmitPlanInput) {
  const nodeIDs = input.nodes.map((node) => (node.id ?? GraphStorage.NodeID.create()) as GraphStorage.NodeID)
  const unknownRef = input.edges
    .flatMap((edge) => [edge.sourceID, edge.targetID])
    .find((ref) => ref.startsWith("@") && nodeIDs[Number.parseInt(ref.slice(1), 10)] === undefined)
  if (unknownRef) {
    return [{
      rule: "edge.dangling_endpoint",
      message: `edge references unknown node index: ${unknownRef}`,
      context: { ref: unknownRef, nodeCount: nodeIDs.length },
    }]
  }
  const resolveRef = (ref: string): GraphStorage.NodeID => {
    if (ref.startsWith("@")) {
      const idx = Number.parseInt(ref.slice(1), 10)
      return nodeIDs[idx] ?? ref
    }
    return ref as GraphStorage.NodeID
  }
  const nodes = input.nodes.map((node, i): NodeRow => ({
    id: nodeIDs[i],
    projectID: input.projectID,
    sessionID: input.sessionID,
    type: node.type,
    name: node.name,
    level: node.level,
    priority: node.priority ?? null,
    category: node.category ?? null,
    status: node.status ?? "pending",
    desc: node.desc ?? null,
    content: node.content ?? null,
    verification: node.verification ?? null,
    codeHash: node.codeHash ?? null,
    testStatus: node.testStatus ?? "none",
    confidence: node.confidence ?? 1,
    timeCreated: 0,
    timeUpdated: 0,
  }))
  const edges = input.edges.map((edge): EdgeRow => ({
    id: (edge.id ?? GraphStorage.EdgeID.create()) as GraphStorage.EdgeID,
    projectID: input.projectID,
    sessionID: input.sessionID,
    sourceID: resolveRef(edge.sourceID),
    targetID: resolveRef(edge.targetID),
    relation: edge.relation,
    confidence: edge.confidence ?? 1,
    timeCreated: 0,
  }))
  return validateSubgraph(nodes, edges)
}
