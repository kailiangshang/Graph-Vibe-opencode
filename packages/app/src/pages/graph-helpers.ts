export interface GraphNode {
  id: string
  name: string
  type: string
  level: string
  status: string
  testStatus: string
  priority: string | null
  sessionID: string | null
  desc?: string | null
  content?: unknown
}

export interface GraphEdge {
  id: string
  sourceID: string
  targetID: string
  relation: string
}

export interface GraphView {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface PublicationScope {
  readonly directory: string
  readonly sessionID: string
  readonly pathname: string
  readonly revision: number
  readonly planHash: string
  readonly planSource: "currentPlan" | "version"
  readonly sessionTitle: string
  readonly nodeCount: number
  readonly edgeCount: number
  readonly nodeIDs: readonly string[]
  readonly edgeIDs: readonly string[]
}

export function publicationScope(input: {
  directory: string
  sessionID: string
  pathname: string
  revision: number
  planHash: string
  planSource: "currentPlan" | "version"
  sessionTitle: string
  nodes: ReadonlyArray<{ id: string }>
  edges: ReadonlyArray<{ id: string }>
}): PublicationScope {
  return {
    directory: input.directory,
    sessionID: input.sessionID,
    pathname: input.pathname,
    revision: input.revision,
    planHash: input.planHash,
    planSource: input.planSource,
    sessionTitle: input.sessionTitle,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    nodeIDs: input.nodes.map((node) => node.id).sort(),
    edgeIDs: input.edges.map((edge) => edge.id).sort(),
  }
}

export function samePublicationScope(reviewed: PublicationScope, current: PublicationScope) {
  return (
    reviewed.directory === current.directory &&
    reviewed.sessionID === current.sessionID &&
    reviewed.pathname === current.pathname &&
    reviewed.revision === current.revision &&
    reviewed.planHash === current.planHash &&
    reviewed.planSource === current.planSource &&
    reviewed.sessionTitle === current.sessionTitle &&
    reviewed.nodeCount === current.nodeCount &&
    reviewed.edgeCount === current.edgeCount &&
    reviewed.nodeIDs.every((id, index) => id === current.nodeIDs[index]) &&
    reviewed.edgeIDs.every((id, index) => id === current.edgeIDs[index])
  )
}

export type LevelFilter = "all" | "L1" | "L2"

export const CURRENT_PLAN_EMPTY_MESSAGE =
  "No Current Plan nodes yet. Describe your goal in Graph Vibe to create a plan."

export function canPublishToMain(input: {
  phase: string
  planSource: "currentPlan" | "version"
  nodeCount: number
}) {
  return input.phase === "complete" && input.planSource === "currentPlan" && input.nodeCount > 0
}

export function prefersReducedTransparency(matchMedia: (query: string) => { matches: boolean }) {
  return matchMedia("(prefers-reduced-transparency: reduce)").matches
}

export function workflowMutationFailure(
  action: "mode" | "continue" | "pause",
  error: unknown,
): { kind: string; refresh: boolean; message: string } {
  const tag = error && typeof error === "object" && "_tag" in error ? error._tag : undefined
  if (tag === "GraphWorkflowRevisionConflict")
    return {
      kind: "revision-conflict",
      refresh: true,
      message: "The workflow changed in another client. Status was refreshed; review it and explicitly retry.",
    }
  if (error instanceof Error)
    return {
      kind: "network",
      refresh: false,
      message: "The workflow service could not be reached. Check the connection and retry this action.",
    }
  if (tag === "GraphWorkflowActiveOperation")
    return {
      kind: "active-workflow",
      refresh: false,
      message: "Workflow changes are active. Pause or wait for them to finish before changing execution mode.",
    }
  if (tag === "BadRequest" && action === "mode")
    return {
      kind: "active-workflow",
      refresh: false,
      message: "Execution mode cannot change while work is active. Pause the workflow first.",
    }
  if (tag === "BadRequest" && action === "continue")
    return {
      kind: "invalid-action",
      refresh: false,
      message: "Continue is unavailable for the current workflow state. Review the checkpoint and available actions.",
    }
  if (tag === "BadRequest")
    return {
      kind: "apply-rejected",
      refresh: false,
      message:
        "Pause was not accepted at the current mutation boundary. Wait for the active change to finish, then retry.",
    }
  return {
    kind: "rejected",
    refresh: false,
    message: "The workflow action was rejected. Review the current state before retrying.",
  }
}

export function groupWorkflowTasks<T extends { id: string; moduleID: string | null }>(
  tasks: T[],
  modules: Array<{ id: string; name: string }>,
) {
  const groups = modules.map((module) => ({ ...module, tasks: tasks.filter((task) => task.moduleID === module.id) }))
  const ungrouped = tasks.filter((task) => !task.moduleID || !modules.some((module) => module.id === task.moduleID))
  return [...groups, ...(ungrouped.length ? [{ id: null, name: "Ungrouped", tasks: ungrouped }] : [])]
}

export function deterministicPosition(_graphID: string, _nodeID: string, _count: number) {
  const value = `${_graphID}:${_nodeID}`
    .split("")
    .reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261)
  const angle = ((value >>> 0) / 0xffffffff) * Math.PI * 2
  const radius = 110 + ((value >>> 8) % Math.max(60, Math.min(240, _count * 18)))
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) }
}

type WorkflowTask = {
  id: string
  name: string
  order: number | string
  moduleID: string | null
  moduleName: string | null
  status: string
  testStatus: string
  buildable: boolean
  current: boolean
  verification: {
    criteria: readonly string[]
    diagnostics: ReadonlyArray<{ name: string; paths?: readonly string[] }>
  } | null
  latestEvidence: WorkflowEvidence | null
}

type WorkflowEvidence = {
  artifactPaths: readonly string[]
  passed: boolean
  commands: ReadonlyArray<{ name: string; passed: boolean; excerpt?: string }>
}

type WorkflowInput = {
  mode: "atomic" | "module" | "autopilot" | null
  revision: number | string
  phase: string
  checkpoint: {
    status: string
    kind: string | null
    scopeNodeID: string | null
    scopeName: string | null
    reason: string | null
  }
  currentTask: WorkflowTask | null
  progress: { total: number | string; verified: number | string; failed: number | string; percent: number | string }
  tasks: WorkflowTask[]
  modules: Array<{ id: string; name: string; status: string; taskIDs: string[] }>
}

export function normalizeWorkflow(workflow: WorkflowInput) {
  const tasks = workflow.tasks
    .filter((task, index, all) => all.findIndex((candidate) => candidate.id === task.id) === index)
    .map((task) => {
      const module = workflow.modules.find((candidate) => candidate.taskIDs.includes(task.id))
      return {
        ...task,
        order: Number(task.order),
        moduleID: task.moduleID ?? module?.id ?? null,
        moduleName: task.moduleName ?? module?.name ?? null,
      }
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const currentTask =
    tasks.find((task) => task.id === workflow.currentTask?.id) ?? tasks.find((task) => task.current) ?? null
  return {
    ...workflow,
    revision: Number(workflow.revision),
    progress: {
      total: Number(workflow.progress.total),
      verified: Number(workflow.progress.verified),
      failed: Number(workflow.progress.failed),
      percent: Number(workflow.progress.percent),
    },
    tasks,
    currentTask,
    modules: groupWorkflowTasks(tasks, workflow.modules).map((module) => {
      const items = module.tasks
      return {
        ...module,
        tasks: items,
        progress: { verified: items.filter((task) => task.status === "verified").length, total: items.length },
      }
    }),
  }
}

export function reconcileSelection(selectedID: string | null, tasks: Array<{ id: string }>, currentID?: string | null) {
  if (selectedID && tasks.some((task) => task.id === selectedID)) return selectedID
  if (currentID && tasks.some((task) => task.id === currentID)) return currentID
  return tasks[0]?.id ?? null
}

export function countByStatus(nodes: GraphNode[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
  return counts
}

export function filterByLevel(data: GraphView | undefined, filter: LevelFilter): GraphView {
  if (!data) return { nodes: [], edges: [] }
  if (filter === "all") return data
  const filteredNodes = data.nodes.filter((n) => {
    if (filter === "L1") return n.type === "prd" || n.type === "composite"
    return n.type === "atomic"
  })
  const nodeIDs = new Set(filteredNodes.map((n) => n.id))
  const filteredEdges = data.edges.filter((e) => nodeIDs.has(e.sourceID) && nodeIDs.has(e.targetID))
  return { nodes: filteredNodes, edges: filteredEdges }
}
