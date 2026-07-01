import type { EdgeRow, GraphView, NodeID, NodeRow } from "./storage"
import { validateSubgraph } from "./validation"

export interface Conflict {
  readonly type: "node_modified" | "node_deleted" | "edge_modified" | "cycle" | "constraint"
  readonly nodeId?: NodeID
  readonly edgeId?: string
  readonly detail: string
  readonly mainState?: unknown
  readonly planState?: unknown
}

function nodesEqual(a: NodeRow, b: NodeRow): boolean {
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.level === b.level &&
    a.priority === b.priority &&
    a.status === b.status &&
    a.desc === b.desc
  )
}

function mergedView(plan: GraphView, main: GraphView): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const nodeMap = new Map(main.nodes.map((n) => [n.id, n]))
  for (const n of plan.nodes) nodeMap.set(n.id, n)
  const edgeMap = new Map(main.edges.map((e) => [e.id, e]))
  for (const e of plan.edges) edgeMap.set(e.id, e)
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
}

export function detectConflicts(plan: GraphView, main: GraphView): Conflict[] {
  const conflicts: Conflict[] = []
  const mainNodeMap = new Map(main.nodes.map((n) => [n.id, n]))
  const mainEdgeMap = new Map(main.edges.map((e) => [e.id, e]))

  for (const pNode of plan.nodes) {
    const mNode = mainNodeMap.get(pNode.id)
    if (!mNode) continue
    if (mNode.status === "deprecated") {
      conflicts.push({ type: "node_deleted", nodeId: pNode.id, detail: `node ${pNode.id} deprecated in main` })
    } else if (!nodesEqual(pNode, mNode)) {
      conflicts.push({ type: "node_modified", nodeId: pNode.id, detail: `node ${pNode.id} differs from main`, mainState: mNode, planState: pNode })
    }
  }

  const mainTriples = new Set(main.edges.map((e) => `${e.sourceID}|${e.targetID}|${e.relation}`))
  for (const pEdge of plan.edges) {
    const mEdge = mainEdgeMap.get(pEdge.id)
    if (mEdge) {
      if (mEdge.confidence !== pEdge.confidence) {
        conflicts.push({ type: "edge_modified", edgeId: pEdge.id, detail: `edge ${pEdge.id} confidence differs`, mainState: mEdge.confidence, planState: pEdge.confidence })
      }
    } else {
      const triple = `${pEdge.sourceID}|${pEdge.targetID}|${pEdge.relation}`
      if (mainTriples.has(triple)) {
        conflicts.push({ type: "edge_modified", edgeId: pEdge.id, detail: `edge ${pEdge.id} triple (${triple}) already in main` })
      }
    }
  }

  const merged = mergedView(plan, main)
  const issues = validateSubgraph(merged.nodes, merged.edges)
  for (const issue of issues) {
    conflicts.push({
      type: issue.rule === "graph.cycle" ? "cycle" : "constraint",
      detail: issue.message,
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
    })
  }

  return conflicts
}
