import type { EdgeRow, NodeID, NodeRow } from "./storage"
import type { EdgeRelation } from "@opencode-ai/schema/graph"
import type { GraphView } from "./storage"

export function bfs(
  startIDs: NodeID[],
  edges: EdgeRow[],
  opts?: { maxDepth?: number; relation?: EdgeRelation },
): NodeID[] {
  const maxDepth = opts?.maxDepth ?? 0
  const unlimited = maxDepth <= 0
  const relation = opts?.relation
  const visited = new Set<NodeID>(startIDs)
  const result: NodeID[] = []
  let frontier = [...startIDs]
  let depth = 0
  while (frontier.length > 0 && (unlimited || depth < maxDepth)) {
    const next: NodeID[] = []
    for (const id of frontier) {
      for (const e of edges) {
        if (e.sourceID !== id) continue
        if (relation !== undefined && e.relation !== relation) continue
        if (visited.has(e.targetID)) continue
        visited.add(e.targetID)
        result.push(e.targetID)
        next.push(e.targetID)
      }
    }
    frontier = next
    depth++
  }
  return result
}

export function dfs(
  startIDs: NodeID[],
  edges: EdgeRow[],
  opts?: { maxDepth?: number; relation?: EdgeRelation },
): NodeID[] {
  const maxDepth = opts?.maxDepth ?? 0
  const unlimited = maxDepth <= 0
  const relation = opts?.relation
  const visited = new Set<NodeID>(startIDs)
  const result: NodeID[] = []
  function visit(id: NodeID, depth: number) {
    if (!unlimited && depth >= maxDepth) return
    for (const e of edges) {
      if (e.sourceID !== id) continue
      if (relation !== undefined && e.relation !== relation) continue
      if (visited.has(e.targetID)) continue
      visited.add(e.targetID)
      result.push(e.targetID)
      visit(e.targetID, depth + 1)
    }
  }
  for (const id of startIDs) visit(id, 0)
  return result
}

export function findPath(sourceID: NodeID, targetID: NodeID, edges: EdgeRow[]): NodeID[] | null {
  if (sourceID === targetID) return [sourceID]
  const visited = new Set<NodeID>([sourceID])
  const parent = new Map<NodeID, NodeID>()
  const queue: NodeID[] = [sourceID]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const e of edges) {
      if (e.sourceID !== current) continue
      if (visited.has(e.targetID)) continue
      visited.add(e.targetID)
      parent.set(e.targetID, current)
      if (e.targetID === targetID) {
        const path: NodeID[] = [targetID]
        let node: NodeID = targetID
        while (parent.has(node)) {
          node = parent.get(node)!
          path.unshift(node)
        }
        return path
      }
      queue.push(e.targetID)
    }
  }
  return null
}

export function extractSubgraph(nodeIDs: Set<NodeID>, nodes: NodeRow[], edges: EdgeRow[]): GraphView {
  return {
    nodes: nodes.filter((n) => nodeIDs.has(n.id)),
    edges: edges.filter((e) => nodeIDs.has(e.sourceID) && nodeIDs.has(e.targetID)),
  }
}

export function detectCycle(nodes: NodeRow[], edges: EdgeRow[]): NodeID[] | null {
  const adj = new Map<NodeID, NodeID[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    if (!adj.has(e.sourceID)) adj.set(e.sourceID, [])
    adj.get(e.sourceID)!.push(e.targetID)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<NodeID, number>()
  for (const n of nodes) color.set(n.id, WHITE)
  const stack: NodeID[] = []
  let cycle: NodeID[] | null = null

  function visit(id: NodeID): boolean {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next)
      if (c === undefined || c === BLACK) continue
      if (c === GRAY) {
        const idx = stack.indexOf(next)
        cycle = stack.slice(idx)
        return true
      }
      if (visit(next)) return true
    }
    stack.pop()
    color.set(id, BLACK)
    return false
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      if (visit(n.id)) return cycle
    }
  }
  return null
}
