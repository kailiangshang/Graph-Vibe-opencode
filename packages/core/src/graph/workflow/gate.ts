export * as GraphGate from "./gate"

import type { ProjectV2 } from "../../project"
import type { ConsistencyIssue } from "../derivation/checker"
import { detectConflicts } from "../conflict"
import type { GraphView, NodeID, NodeRow } from "../storage"
import { isImportedCodeNode, validateSubgraph } from "../validation"
import { validateArtifact } from "./artifact"
import type { Artifact } from "./artifact"

export interface BuildGateInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly targetNodeID: NodeID
  readonly main: GraphView
  readonly currentPlan: GraphView
  readonly consistencyIssues?: ReadonlyArray<ConsistencyIssue>
  readonly artifact?: Artifact
  readonly diagnosticsRequested?: boolean
}

export interface GateIssue {
  readonly code:
    | "target_not_in_current_plan"
    | "target_status_blocked"
    | "blocked_by_dependency"
    | "current_plan_invalid"
    | "conflict_detected"
    | "stale_intent"
    | "structural_drift"
    | "missing_code_reference"
    | "invalid_artifact"
  readonly severity: "block" | "warn"
  readonly nodeID?: NodeID
  readonly message: string
}

export interface GateResult {
  readonly allowed: boolean
  readonly issues: ReadonlyArray<GateIssue>
  readonly requiredPermissions: ReadonlyArray<"artifact_write" | "diagnostics_run">
}

export function evaluateBuildGate(input: BuildGateInput): GateResult {
  const target = input.currentPlan.nodes.find((node) => node.id === input.targetNodeID)
  const issues = [
    ...targetIssues(input.targetNodeID, target),
    ...dependencyIssues(input.targetNodeID, input.currentPlan),
    ...validationIssues(input.currentPlan),
    ...conflictIssues(input.currentPlan, input.main),
    ...staleIntentIssues(input.currentPlan),
    ...consistencyIssues(input.consistencyIssues ?? []),
    ...artifactIssues(input.artifact),
  ]

  return {
    allowed: issues.every((issue) => issue.severity !== "block"),
    issues,
    requiredPermissions: [
      input.artifact ? "artifact_write" as const : undefined,
      input.diagnosticsRequested ? "diagnostics_run" as const : undefined,
    ].filter((permission): permission is "artifact_write" | "diagnostics_run" => permission !== undefined),
  }
}

function targetIssues(targetNodeID: NodeID, target: NodeRow | undefined): GateIssue[] {
  if (!target) {
    return [{
      code: "target_not_in_current_plan",
      severity: "block",
      nodeID: targetNodeID,
      message: `target node ${targetNodeID} is not in the CurrentPlan`,
    }]
  }
  if (target.status === "verified" || target.status === "deprecated") {
    return [{
      code: "target_status_blocked",
      severity: "block",
      nodeID: target.id,
      message: `target node ${target.name} has status ${target.status}`,
    }]
  }
  return []
}

function dependencyIssues(targetNodeID: NodeID, currentPlan: GraphView): GateIssue[] {
  const nodes = new Map(currentPlan.nodes.map((node) => [node.id, node]))
  return currentPlan.edges
    .filter((edge) => edge.relation === "blocks" && edge.targetID === targetNodeID)
    .flatMap((edge) => {
      const source = nodes.get(edge.sourceID)
      if (source?.status === "implemented" || source?.status === "verified") return []
      return [{
        code: "blocked_by_dependency" as const,
        severity: "block" as const,
        nodeID: source?.id,
        message: `dependency ${edge.sourceID} must be implemented or verified before ${targetNodeID}`,
      }]
    })
}

function validationIssues(currentPlan: GraphView): GateIssue[] {
  return validateSubgraph([...currentPlan.nodes], [...currentPlan.edges]).map((issue) => ({
    code: "current_plan_invalid" as const,
    severity: "block" as const,
    nodeID: issue.nodeId,
    message: issue.message,
  }))
}

function conflictIssues(currentPlan: GraphView, main: GraphView): GateIssue[] {
  return detectConflicts(currentPlan, main).map((conflict) => ({
    code: "conflict_detected" as const,
    severity: "block" as const,
    nodeID: conflict.nodeId,
    message: conflict.detail,
  }))
}

function staleIntentIssues(currentPlan: GraphView): GateIssue[] {
  return currentPlan.nodes
    .filter((node) => !isImportedCodeNode(node) && node.content?.stale === true)
    .map((node) => ({
      code: "stale_intent" as const,
      severity: "block" as const,
      nodeID: node.id,
      message: `intent node ${node.name} is stale`,
    }))
}

function consistencyIssues(issues: ReadonlyArray<ConsistencyIssue>): GateIssue[] {
  return issues.flatMap((issue) => {
    if (["missing_code", "missing_code_ref", "invalid_code_ref"].includes(issue.type)) {
      return [{
        code: "missing_code_reference" as const,
        severity: "block" as const,
        nodeID: issue.nodeId as NodeID | undefined,
        message: issue.detail,
      }]
    }
    if (issue.type === "intent_stale") {
      return [{
        code: "stale_intent" as const,
        severity: "block" as const,
        nodeID: issue.nodeId as NodeID | undefined,
        message: issue.detail,
      }]
    }
    return [{
      code: "structural_drift" as const,
      severity: "block" as const,
      nodeID: issue.nodeId as NodeID | undefined,
      message: issue.detail,
    }]
  })
}

function artifactIssues(artifact: Artifact | undefined): GateIssue[] {
  if (!artifact) return []
  return validateArtifact(artifact).map((issue) => ({
    code: "invalid_artifact" as const,
    severity: "block" as const,
    message: issue.message,
  }))
}
