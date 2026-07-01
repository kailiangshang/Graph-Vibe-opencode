import type { EdgeRow, NodeID, NodeRow } from "./storage"
import { bfs } from "./traversal"

export interface ImpactResult {
  readonly direct: NodeID[]
  readonly indirect: NodeID[]
  readonly upstream: NodeID[]
  readonly downstream: NodeID[]
  readonly risk: "high" | "medium" | "low"
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

export function calculateRisk(downstream: NodeID[], nodes: NodeRow[]): "high" | "medium" | "low" {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  if (downstream.length > 10 || downstream.some((id) => nodeMap.get(id)?.priority === "P0")) return "high"
  if (downstream.length >= 3) return "medium"
  return "low"
}

export function assessImpact(nodeID: NodeID, nodes: NodeRow[], edges: EdgeRow[]): ImpactResult {
  const direct = unique(edges.filter((e) => e.sourceID === nodeID).map((e) => e.targetID))
  const indirect = bfs(direct, edges)
  const downstream = unique([...direct, ...indirect])
  const upstream = unique(edges.filter((e) => e.targetID === nodeID).map((e) => e.sourceID))
  return { direct, indirect, upstream, downstream, risk: calculateRisk(downstream, nodes) }
}
