export interface GraphNode {
  id: string
  name: string
  type: string
  level: string
  status: string
  testStatus: string
  priority: string | null
  sessionID: string | null
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
