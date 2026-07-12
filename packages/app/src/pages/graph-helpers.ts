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

export type LevelFilter = "all" | "L1" | "L2"

export const CURRENT_PLAN_EMPTY_MESSAGE =
  "No Current Plan nodes yet. Describe your goal in Graph Vibe to create a plan."

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
    .map((task) => ({ ...task, order: Number(task.order) }))
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
    modules: workflow.modules.map((module) => {
      const items = tasks.filter((task) => task.moduleID === module.id)
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
