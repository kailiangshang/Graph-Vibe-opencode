export * as GraphDiff from "./diff"

import type { EdgeRow, NodeRow } from "./storage"

export interface NodeModification {
  id: string
  before: Partial<NodeRow>
  after: Partial<NodeRow>
  fields: string[]
}

export interface GraphDiffResult {
  nodes: {
    added: NodeRow[]
    removed: NodeRow[]
    modified: NodeModification[]
  }
  edges: {
    added: EdgeRow[]
    removed: EdgeRow[]
  }
  summary: {
    nodesAdded: number
    nodesRemoved: number
    nodesModified: number
    edgesAdded: number
    edgesRemoved: number
  }
}

interface GraphView {
  nodes: ReadonlyArray<NodeRow>
  edges: ReadonlyArray<EdgeRow>
}

const TRACKED_FIELDS = ["status", "testStatus", "name", "priority", "desc"] as const

export function graphDiff(left: GraphView, right: GraphView): GraphDiffResult {
  const leftNodes = new Map(left.nodes.map((n) => [n.id, n]))
  const rightNodes = new Map(right.nodes.map((n) => [n.id, n]))

  const added: NodeRow[] = []
  const removed: NodeRow[] = []
  const modified: NodeModification[] = []

  for (const node of right.nodes) {
    if (!leftNodes.has(node.id)) {
      added.push(node)
      continue
    }
    const before = leftNodes.get(node.id)!
    const changes: string[] = []
    const beforeFields: Record<string, unknown> = {}
    const afterFields: Record<string, unknown> = {}
    for (const field of TRACKED_FIELDS) {
      if (before[field] !== node[field]) {
        changes.push(field)
        beforeFields[field] = before[field]
        afterFields[field] = node[field]
      }
    }
    if (changes.length > 0) {
      modified.push({ id: node.id, before: beforeFields, after: afterFields, fields: changes })
    }
  }

  for (const node of left.nodes) {
    if (!rightNodes.has(node.id)) {
      removed.push(node)
    }
  }

  const leftEdgeKey = (e: EdgeRow) => `${e.sourceID}->${e.targetID}:${e.relation}`
  const leftEdgeSet = new Set(left.edges.map(leftEdgeKey))

  const edgesAdded = right.edges.filter((e) => !leftEdgeSet.has(leftEdgeKey(e)))
  const rightEdgeSet = new Set(right.edges.map(leftEdgeKey))
  const edgesRemoved = left.edges.filter((e) => !rightEdgeSet.has(leftEdgeKey(e)))

  return {
    nodes: { added, removed, modified },
    edges: { added: edgesAdded, removed: edgesRemoved },
    summary: {
      nodesAdded: added.length,
      nodesRemoved: removed.length,
      nodesModified: modified.length,
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
    },
  }
}
