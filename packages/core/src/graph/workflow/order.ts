import type { GraphView, NodeID, NodeRow } from "../storage"

export function orderedAtomicNodes(graph: GraphView): NodeRow[] {
  const nodes = graph.nodes.filter((node) => node.type === "atomic")
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const dependents = new Map(nodes.map((node) => [node.id, [] as NodeID[]]))
  graph.edges
    .filter((edge) => edge.relation === "blocks" && byID.has(edge.sourceID) && byID.has(edge.targetID))
    .forEach((edge) => {
      indegree.set(edge.targetID, (indegree.get(edge.targetID) ?? 0) + 1)
      dependents.get(edge.sourceID)?.push(edge.targetID)
    })
  dependents.forEach((items) => items.sort((a, b) => a.localeCompare(b)))
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort((a, b) => a.localeCompare(b))
  const ordered: NodeRow[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (!id) break
    const node = byID.get(id)
    if (node) ordered.push(node)
    dependents.get(id)?.forEach((dependent) => {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort((a, b) => a.localeCompare(b))
      }
    })
  }
  return [...ordered, ...nodes.filter((node) => !ordered.some((item) => item.id === node.id)).sort((a, b) => a.id.localeCompare(b.id))]
}

export function nearestCompositeIDs(graph: GraphView, nodeID: NodeID): NodeID[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const parents = new Map<NodeID, NodeID[]>()
  graph.edges.filter((edge) => edge.relation === "contains").forEach((edge) => {
    parents.set(edge.targetID, [...(parents.get(edge.targetID) ?? []), edge.sourceID])
  })
  const visited = new Set<NodeID>([nodeID])
  const queue = (parents.get(nodeID) ?? []).map((id) => ({ id, distance: 1 }))
  const matches: Array<{ readonly id: NodeID; readonly distance: number }> = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current.id)) continue
    visited.add(current.id)
    if (nodes.get(current.id)?.type === "composite") matches.push(current)
    ;(parents.get(current.id) ?? []).forEach((id) => queue.push({ id, distance: current.distance + 1 }))
  }
  const nearest = Math.min(...matches.map((item) => item.distance))
  return matches.filter((item) => item.distance === nearest).map((item) => item.id).sort((a, b) => a.localeCompare(b))
}
