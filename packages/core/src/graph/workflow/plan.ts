export * as GraphPlan from "./plan"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../../effect/layer-node"
import * as GraphDomain from "../domain"
import * as GraphStorage from "../storage"
import { validateSubgraph } from "../validation"
import type { EdgeRow, NodeRow } from "../storage"
import type { ProjectV2 } from "../../project"

export type PlanNodeCreate = Omit<GraphStorage.NodeCreate, "projectID" | "sessionID">
export type PlanEdgeCreate = Omit<GraphStorage.EdgeCreate, "projectID" | "sessionID">

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
  readonly admit: (input: AdmitPlanInput) => Effect.Effect<AdmitPlanResult, GraphDomain.ValidationError | GraphStorage.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphPlan") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const domain = yield* GraphDomain.Service

    const admit = Effect.fn("GraphPlan.admit")(function* (input: AdmitPlanInput) {
      if (input.dryRun) {
        const issues = validateDryRun(input)
        if (issues.length > 0) return yield* new GraphDomain.ValidationError({ rule: issues[0].rule, message: issues[0].message })
        return { nodesCreated: input.nodes.length, edgesCreated: input.edges.length, dryRun: true }
      }

      yield* Effect.forEach(input.nodes, (node) => domain.node.create({ ...node, projectID: input.projectID, sessionID: input.sessionID }))
      yield* Effect.forEach(input.edges, (edge) => domain.edge.create({ ...edge, projectID: input.projectID, sessionID: input.sessionID }))
      return { nodesCreated: input.nodes.length, edgesCreated: input.edges.length, dryRun: false }
    })

    return Service.of({ admit })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [GraphDomain.node] })

export const defaultLayer = layer.pipe(Layer.provide(GraphDomain.defaultLayer))

function validateDryRun(input: AdmitPlanInput) {
  const nodes = input.nodes.map((node): NodeRow => ({
    id: (node.id ?? GraphStorage.NodeID.create()) as GraphStorage.NodeID,
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
    sourceID: edge.sourceID,
    targetID: edge.targetID,
    relation: edge.relation,
    confidence: edge.confidence ?? 1,
    timeCreated: 0,
  }))
  return validateSubgraph(nodes, edges)
}
