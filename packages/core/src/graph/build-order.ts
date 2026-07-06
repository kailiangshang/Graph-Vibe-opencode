export * as BuildOrder from "./build-order"

import type { EdgeRow, NodeRow } from "./storage"

export function topologicalOrder(nodes: ReadonlyArray<NodeRow>, edges: ReadonlyArray<EdgeRow>): NodeRow[] {
  const blocksEdges = edges.filter((e) => e.relation === "blocks")
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, NodeRow["id"][]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    dependents.set(node.id, [])
  }

  for (const edge of blocksEdges) {
    if (!nodeMap.has(edge.sourceID) || !nodeMap.has(edge.targetID)) continue
    inDegree.set(edge.targetID, (inDegree.get(edge.targetID) ?? 0) + 1)
    dependents.get(edge.sourceID)?.push(edge.targetID)
  }

  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const result: NodeRow[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodeMap.get(id)
    if (node) result.push(node)
    for (const dep of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dep) ?? 0) - 1
      inDegree.set(dep, remaining)
      if (remaining === 0) queue.push(dep)
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) result.push(node)
  }

  return result
}

export function buildableNodes(nodes: ReadonlyArray<NodeRow>, edges: ReadonlyArray<EdgeRow>): NodeRow[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const blocksSources = new Map<string, NodeRow["id"][]>()

  for (const edge of edges) {
    if (edge.relation !== "blocks") continue
    if (!nodeMap.has(edge.sourceID) || !nodeMap.has(edge.targetID)) continue
    const arr = blocksSources.get(edge.targetID) ?? []
    arr.push(edge.sourceID)
    blocksSources.set(edge.targetID, arr)
  }

  return nodes.filter((node) => {
    if (node.status !== "pending") return false
    const sources = blocksSources.get(node.id) ?? []
    return sources.every((srcID) => {
      const src = nodeMap.get(srcID)
      return src?.status === "verified" || src?.status === "implemented"
    })
  })
}
