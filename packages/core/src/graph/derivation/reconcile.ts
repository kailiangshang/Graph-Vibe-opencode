import type { ConsistencyIssue } from "./checker"
import type { ExpectedGraph, ExpectedNode, ExpectedEdge } from "./builder"

export interface ReconciliationPlan {
  readonly nodesToAdd: ExpectedNode[]
  readonly nodesToUpdate: { id: string; codeHash: string; content: ExpectedNode["content"] }[]
  readonly nodesToRemove: string[]
  readonly edgesToAdd: ExpectedEdge[]
  readonly edgesToRemove: string[]
  readonly intentStaleMarkings: string[]
}

export function buildReconciliationPlan(
  issues: ConsistencyIssue[],
  expected: ExpectedGraph,
): ReconciliationPlan {
  const expectedNodeMap = new Map(expected.nodes.map((n) => [n.id, n]))
  const expectedEdgeMap = new Map(expected.edges.map((e) => [e.id, e]))

  const nodesToAdd: ExpectedNode[] = []
  const nodesToUpdate: { id: string; codeHash: string; content: ExpectedNode["content"] }[] = []
  const nodesToRemove: string[] = []
  const edgesToAdd: ExpectedEdge[] = []
  const edgesToRemove: string[] = []
  const intentStaleMarkings: string[] = []

  for (const issue of issues) {
    switch (issue.type) {
      case "missing_node":
        if (issue.nodeId) {
          const node = expectedNodeMap.get(issue.nodeId)
          if (node) nodesToAdd.push(node)
        }
        break
      case "stale_node":
        if (issue.nodeId) nodesToRemove.push(issue.nodeId)
        break
      case "hash_mismatch":
        if (issue.nodeId) {
          const node = expectedNodeMap.get(issue.nodeId)
          if (node) nodesToUpdate.push({ id: node.id, codeHash: node.codeHash, content: node.content })
        }
        break
      case "missing_edge":
        if (issue.edgeId) {
          const edge = expectedEdgeMap.get(issue.edgeId)
          if (edge) edgesToAdd.push(edge)
        }
        break
      case "stale_edge":
        if (issue.edgeId) edgesToRemove.push(issue.edgeId)
        break
      case "intent_stale":
      case "missing_code":
        if (issue.nodeId) intentStaleMarkings.push(issue.nodeId)
        break
    }
  }

  return { nodesToAdd, nodesToUpdate, nodesToRemove, edgesToAdd, edgesToRemove, intentStaleMarkings }
}
