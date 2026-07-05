import type { EdgeRow, EdgeID, NodeID, NodeRow } from "./storage"
import { detectCycle } from "./traversal"

export interface ValidationIssue {
  readonly rule: string
  readonly message: string
  readonly nodeId?: NodeID
  readonly edgeId?: EdgeID
  readonly context?: unknown
}

export function isImportedCodeNode(node: NodeRow): boolean {
  const cats = ["package", "file", "func", "method", "type", "const", "var"]
  if (node.category !== null && cats.includes(node.category)) return true
  if (node.content !== null && "project_type" in node.content && "module" in node.content) return true
  return false
}

export function validateNode(node: NodeRow): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Number.isFinite(node.confidence) || node.confidence < 0 || node.confidence > 1) {
    issues.push({
      rule: "node.confidence_range",
      message: `node ${node.name}: confidence ${node.confidence} out of range [0, 1]`,
      nodeId: node.id,
    })
  }
  return issues
}

function categoryTier(category: string | null): string | null {
  if (category === "package") return "package"
  if (category === "file") return "file"
  if (["func", "method", "type", "const", "var"].includes(category ?? "")) return "decl"
  return null
}

export function validateEdge(source: NodeRow, target: NodeRow, edge: EdgeRow): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (edge.sourceID === edge.targetID) {
    issues.push({ rule: "edge.self_loop", message: `edge ${edge.id} is a self-loop`, edgeId: edge.id })
    return issues
  }
  const srcImported = isImportedCodeNode(source)
  const tgtImported = isImportedCodeNode(target)
  let valid = false
  switch (edge.relation) {
    case "contains":
      if (srcImported || tgtImported) {
        valid =
          (source.type === "prd" && target.type === "composite") ||
          (source.type === "composite" && target.type === "atomic") ||
          (source.type === "atomic" && target.type === "atomic")
      } else {
        valid =
          (source.type === "prd" && target.type === "composite") ||
          (source.type === "composite" && target.type === "atomic") ||
          (source.type === "atomic" && target.type === "atomic") ||
          (source.type === target.type && source.level === "L1" && target.level === "L2")
      }
      break
    case "blocks":
      valid = source.type === target.type && source.level === target.level
      break
    case "addresses":
      valid =
        source.type === "composite" && target.type === "prd" &&
        source.level === "L2" && target.level === "L2"
      break
    case "uses":
      if (srcImported && tgtImported) {
        const st = categoryTier(source.category)
        const tt = categoryTier(target.category)
        valid = st !== null && st === tt && source.level === "L2" && target.level === "L2"
      } else if (!srcImported && !tgtImported) {
        valid =
          source.type === "composite" && target.type === "atomic" &&
          source.level === "L2" && target.level === "L2"
      }
      break
    case "deprecated_by":
      valid = source.type === target.type && source.level === target.level
      break
    default:
      return [{ rule: "edge.unknown_relation", message: `edge ${edge.id}: unknown relation "${edge.relation}"`, edgeId: edge.id }]
  }
  if (!valid) {
    issues.push({
      rule: "edge.type_matrix",
      message: `edge ${edge.id}: relation "${edge.relation}" invalid for ${source.type}(${source.level})→${target.type}(${target.level})`,
      edgeId: edge.id,
    })
  }
  return issues
}

export function checkNameUnique(node: NodeRow, allNodes: NodeRow[]): ValidationIssue[] {
  const dup = allNodes.some(
    (n) => n.id !== node.id && n.type === node.type && n.level === node.level && n.name === node.name,
  )
  if (dup) {
    return [{
      rule: "node.name_not_unique",
      message: `node name "${node.name}" not unique in (${node.type}, ${node.level})`,
      nodeId: node.id,
    }]
  }
  return []
}

export function validateSubgraph(nodes: NodeRow[], edges: EdgeRow[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  issues.push(...nodes.flatMap(validateNode))
  issues.push(
    ...edges.flatMap((e) => {
      const src = nodeMap.get(e.sourceID)
      const tgt = nodeMap.get(e.targetID)
      if (!src || !tgt) {
        return [{ rule: "edge.dangling_endpoint" as const, message: `edge ${e.id}: endpoint not in subgraph node set`, edgeId: e.id }]
      }
      return validateEdge(src, tgt, e)
    }),
  )
  const cycle = detectCycle(nodes, edges)
  if (cycle !== null) {
    issues.push({ rule: "graph.cycle", message: `cycle detected: ${cycle.join(" → ")} → ${cycle[0]}`, context: cycle })
  }
  return issues
}
