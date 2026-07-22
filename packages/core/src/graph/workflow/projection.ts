export * as GraphWorkflowProjection from "./projection"
export * as GraphWorkflow from "./projection"

import { Context, Effect, Layer } from "effect"
import type { VerificationEvidence, VerificationSpec } from "@opencode-ai/schema/graph"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import { GraphStorage } from "../storage"
import type { GraphView, NodeID, NodeRow } from "../storage"
import { GraphAudit } from "./audit"
import { nearestCompositeIDs, orderedAtomicNodes } from "./order"
import { GraphWorkflowState } from "./state"
import type { State } from "./state"
import { Database } from "../../database/database"

export { nearestCompositeIDs, orderedAtomicNodes } from "./order"

export interface EvidenceRecord {
  readonly nodeID: NodeID
  readonly evidence: VerificationEvidence
  readonly timeCreated: number
}

export interface WorkflowTask {
  readonly id: NodeID
  readonly name: string
  readonly order: number
  readonly moduleID: NodeID | null
  readonly moduleName: string | null
  readonly status: NodeRow["status"]
  readonly testStatus: NodeRow["testStatus"]
  readonly buildable: boolean
  readonly current: boolean
  readonly verification: VerificationSpec | null
  readonly latestEvidence: VerificationEvidence | null
}

export interface WorkflowRollup {
  readonly id: NodeID
  readonly name: string
  readonly type: "prd" | "composite"
  readonly status: "pending" | "implemented" | "verified" | "failed"
  readonly taskIDs: ReadonlyArray<NodeID>
}

export interface WorkflowModule extends WorkflowRollup {
  readonly type: "composite"
  readonly tasks: ReadonlyArray<WorkflowTask>
}

export interface Projection {
  readonly mode: State["mode"]
  readonly revision: number
  readonly activeOperationKind: State["activeOperationKind"]
  readonly phase: "planning" | "building" | "verifying" | "checkpoint" | "complete" | "failed"
  readonly checkpoint: {
    readonly status: State["checkpointStatus"]
    readonly kind: State["checkpointKind"]
    readonly scopeNodeID: NodeID | null
    readonly scopeName: string | null
    readonly reason: string | null
  }
  readonly currentTask: WorkflowTask | null
  readonly modules: ReadonlyArray<WorkflowModule>
  readonly tasks: ReadonlyArray<WorkflowTask>
  readonly rollups: ReadonlyArray<WorkflowRollup>
  readonly progress: { readonly total: number; readonly verified: number; readonly failed: number; readonly percent: number }
}

export interface Interface {
  readonly get: (input: {
    readonly projectID: ProjectV2.ID
    readonly sessionID: string
  }) => Effect.Effect<Projection, GraphStorage.SnapshotDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphWorkflow") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* GraphStorage.Service
    const workflow = yield* GraphWorkflowState.Service
    const audit = yield* GraphAudit.Service
    const get = Effect.fn("GraphWorkflow.get")(function* (input: {
      readonly projectID: ProjectV2.ID
      readonly sessionID: string
    }) {
      const graph = yield* storage.planView(input)
      const state = yield* workflow.get(input.sessionID)
      const records = yield* audit.tool.list({ projectID: input.projectID, sessionID: input.sessionID })
      return projectWorkflow(
        graph,
        state,
        records.flatMap((record) => record.nodeID && record.evidence
          && record.evidence.kind === "diagnostics"
          ? [{ nodeID: record.nodeID, evidence: record.evidence, timeCreated: record.timeCreated }]
          : []),
      )
    })
    return Service.of({ get })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [GraphStorage.node, GraphWorkflowState.node, GraphAudit.node],
})

export const layerFromDatabase = (database: Layer.Layer<Database.Service>) =>
  layer.pipe(Layer.provideMerge(GraphWorkflowState.layerFromDatabase(database)))

export const defaultLayer = layerFromDatabase(Database.layerFromPath(Database.path()))

export function projectWorkflow(
  graph: GraphView,
  state: State | undefined,
  evidence: ReadonlyArray<EvidenceRecord>,
): Projection {
  const ordered = orderedAtomicNodes(graph)
  const taskOrder = new Map(ordered.map((node, index) => [node.id, index]))
  const latest = new Map<NodeID, EvidenceRecord>()
  evidence.forEach((record) => {
    const current = latest.get(record.nodeID)
    if (!current || record.timeCreated >= current.timeCreated) latest.set(record.nodeID, record)
  })
  const tasks = ordered.map((node, order): WorkflowTask => {
    const modules = nearestCompositeIDs(graph, node.id)
    if (state?.mode === "module" && modules.length !== 1) {
      throw new Error(`ambiguous module membership for ${node.id}: ${modules.join(",")}`)
    }
    const module = modules.length === 1 ? graph.nodes.find((item) => item.id === modules[0]) : undefined
    const evidence = latest.get(node.id)?.evidence
    return {
      id: node.id,
      name: node.name,
      order,
      moduleID: module?.id ?? null,
      moduleName: module?.name ?? null,
      status: node.status,
      testStatus: node.testStatus,
      buildable: isBuildable(graph, node.id),
      current: state?.currentNodeID === node.id,
      verification: node.verification,
      latestEvidence: evidence ? { ...evidence, projectChecksOnly: node.verification === null } : null,
    }
  })
  const rollups = graph.nodes
    .filter((node): node is NodeRow & { readonly type: "prd" | "composite" } => node.type !== "atomic")
    .map((node): WorkflowRollup => {
      const taskIDs = descendantAtomicIDs(graph, node.id).sort((a, b) => (taskOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
      return { id: node.id, name: node.name, type: node.type, status: rollupStatus(taskIDs, graph), taskIDs }
    })
  const modules = rollups
    .filter((rollup): rollup is WorkflowRollup & { readonly type: "composite" } => rollup.type === "composite")
    .map((rollup): WorkflowModule => ({
      ...rollup,
      tasks: rollup.taskIDs.flatMap((id) => {
        const task = tasks.find((item) => item.id === id && item.moduleID === rollup.id)
        return task ? [task] : []
      }),
    }))
    .filter((module) => module.tasks.length > 0)
    .sort((a, b) => (a.tasks[0]?.order ?? Number.MAX_SAFE_INTEGER) - (b.tasks[0]?.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  const verified = tasks.filter((task) => task.status === "verified").length
  const failed = tasks.filter((task) => task.testStatus === "failed").length
  const progress = {
    total: tasks.length,
    verified,
    failed,
    percent: tasks.length === 0 ? 0 : Math.floor((verified / tasks.length) * 100),
  }
  const currentTask = tasks.find((task) => task.current) ?? null
  return {
    mode: state?.mode ?? null,
    revision: state?.revision ?? 0,
    activeOperationKind: state?.activeOperationKind ?? null,
    phase: phase(state, progress, currentTask),
    checkpoint: {
      status: state?.checkpointStatus ?? "none",
      kind: state?.checkpointKind ?? null,
      scopeNodeID: state?.checkpointScopeNodeID ?? null,
      scopeName: graph.nodes.find((node) => node.id === state?.checkpointScopeNodeID)?.name ?? null,
      reason: state?.checkpointReason ?? null,
    },
    currentTask,
    modules,
    tasks,
    rollups,
    progress,
  }
}

function descendantAtomicIDs(graph: GraphView, nodeID: NodeID): NodeID[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const children = new Map<NodeID, NodeID[]>()
  graph.edges.filter((edge) => edge.relation === "contains").forEach((edge) => {
    children.set(edge.sourceID, [...(children.get(edge.sourceID) ?? []), edge.targetID])
  })
  const visited = new Set<NodeID>()
  const queue = [...(children.get(nodeID) ?? [])]
  const result: NodeID[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (!id || visited.has(id)) continue
    visited.add(id)
    if (nodes.get(id)?.type === "atomic") result.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

function rollupStatus(taskIDs: ReadonlyArray<NodeID>, graph: GraphView): WorkflowRollup["status"] {
  const nodes = taskIDs.flatMap((id) => {
    const node = graph.nodes.find((item) => item.id === id)
    return node ? [node] : []
  })
  if (nodes.some((node) => node.testStatus === "failed")) return "failed"
  if (nodes.length > 0 && nodes.every((node) => node.status === "verified")) return "verified"
  if (nodes.some((node) => node.status !== "pending" || node.testStatus !== "none")) return "implemented"
  return "pending"
}

function isBuildable(graph: GraphView, nodeID: NodeID) {
  const node = graph.nodes.find((item) => item.id === nodeID)
  if (!node || node.status !== "pending") return false
  return graph.edges
    .filter((edge) => edge.relation === "blocks" && edge.targetID === nodeID)
    .every((edge) => graph.nodes.find((item) => item.id === edge.sourceID)?.status === "verified")
}

function phase(
  state: State | undefined,
  progress: Projection["progress"],
  currentTask: WorkflowTask | null,
): Projection["phase"] {
  if (progress.failed > 0) return "failed"
  if (progress.total > 0 && progress.verified === progress.total) return "complete"
  if (!state?.mode) return "planning"
  if (state.checkpointStatus === "pending") return "checkpoint"
  if (currentTask?.status === "implemented" || currentTask?.testStatus === "pending") return "verifying"
  return "building"
}
