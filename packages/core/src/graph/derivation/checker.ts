import type { GraphView, NodeRow } from "../storage"
import { isImportedCodeNode } from "../validation"
import type { ExpectedGraph, ExpectedNode } from "./builder"

export interface ConsistencyIssue {
  readonly type:
    | "hash_mismatch"
    | "missing_node"
    | "stale_node"
    | "missing_edge"
    | "stale_edge"
    | "missing_code"
    | "missing_code_ref"
    | "invalid_code_ref"
    | "intent_stale"
  readonly nodeId?: string
  readonly edgeId?: string
  readonly detail: string
  readonly expected?: unknown
  readonly stored?: unknown
}

export function checkConsistency(
  expected: ExpectedGraph,
  stored: GraphView,
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = []

  const expectedNodeMap = new Map(expected.nodes.map((n) => [n.id, n]))
  const expectedEdgeMap = new Map(expected.edges.map((e) => [e.id, e]))

  const storedImported = stored.nodes.filter((n) => isImportedCodeNode(n))
  const storedNodeMap = new Map(storedImported.map((n) => [n.id, n]))

  for (const expNode of expected.nodes) {
    const storedNode = storedNodeMap.get(expNode.id)
    if (!storedNode) {
      issues.push({ type: "missing_node", nodeId: expNode.id, detail: `new code: ${expNode.name}`, expected: expNode })
    } else if (storedNode.codeHash !== expNode.codeHash) {
      issues.push({ type: "hash_mismatch", nodeId: expNode.id, detail: `hash changed: ${expNode.name}`, expected: expNode.codeHash, stored: storedNode.codeHash })
    }
  }

  for (const [id] of storedNodeMap) {
    if (!expectedNodeMap.has(id)) {
      issues.push({ type: "stale_node", nodeId: id, detail: `code removed: ${id}` })
    }
  }

  const storedImportedEdges = stored.edges.filter((e) => e.id.startsWith("ged_import:"))
  const storedEdgeMap = new Map(storedImportedEdges.map((e) => [e.id, e]))

  for (const expEdge of expected.edges) {
    if (!storedEdgeMap.has(expEdge.id)) {
      issues.push({ type: "missing_edge", edgeId: expEdge.id, detail: `new edge: ${expEdge.id}`, expected: expEdge })
    }
  }

  for (const [id] of storedEdgeMap) {
    if (!expectedEdgeMap.has(id)) {
      issues.push({ type: "stale_edge", edgeId: id, detail: `removed edge: ${id}` })
    }
  }

  const fileHashMap = new Map<string, string>()
  for (const n of expected.nodes) {
    if (n.category === "file" && n.content.code_ref) {
      fileHashMap.set((n.content.code_ref as Record<string, string>).path, n.codeHash)
    }
  }

  const intentNodes = stored.nodes.filter(
    (n) => !isImportedCodeNode(n) && (n.status === "implemented" || n.status === "verified"),
  )

  for (const node of intentNodes) {
    const ref = node.content?.code_ref as Record<string, unknown> | undefined
    if (!ref) {
      if (node.codeHash) {
        issues.push({ type: "missing_code_ref", nodeId: node.id, detail: `node ${node.name} has code_hash but no code_ref` })
      }
      continue
    }
    const path = ref.path as string | undefined
    if (!path || typeof path !== "string") {
      issues.push({ type: "invalid_code_ref", nodeId: node.id, detail: `node ${node.name} has invalid code_ref` })
      continue
    }
    if (!fileHashMap.has(path)) {
      issues.push({ type: "missing_code", nodeId: node.id, detail: `node ${node.name} references missing file: ${path}` })
    } else if (node.codeHash && node.codeHash !== fileHashMap.get(path)) {
      issues.push({ type: "intent_stale", nodeId: node.id, detail: `node ${node.name} code_hash mismatch for ${path}`, expected: fileHashMap.get(path), stored: node.codeHash })
    }
  }

  return issues
}
