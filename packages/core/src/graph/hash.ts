export * as GraphHash from "./hash"

import type { GraphView } from "./storage"

export function digest(graph: GraphView) {
  const nodes = graph.nodes
    .map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      level: node.level,
      priority: node.priority,
      category: node.category,
      status: node.status,
      desc: node.desc,
      content: node.content,
      verification: node.verification,
      codeHash: node.codeHash,
      testStatus: node.testStatus,
      confidence: node.confidence,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
  const edges = graph.edges
    .map((edge) => ({
      id: edge.id,
      sourceID: edge.sourceID,
      targetID: edge.targetID,
      relation: edge.relation,
      confidence: edge.confidence,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical({ nodes, edges }))).digest("hex")}`
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  )
}
