import { describe, expect, test } from "bun:test"
import { evaluateBuildGate } from "@opencode-ai/core/graph/workflow/gate"
import type { ConsistencyIssue } from "@opencode-ai/core/graph/derivation/checker"
import type { EdgeID, EdgeRow, GraphView, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import type { ProjectV2 } from "@opencode-ai/core/project"

const PID = "proj_test" as ProjectV2.ID
const SID = "ses_test"

function node(id: string, patch: Partial<NodeRow> = {}): NodeRow {
  return {
    id: id as NodeID,
    projectID: PID,
    sessionID: SID,
    type: "atomic",
    name: id,
    level: "L2",
    priority: null,
    category: null,
    status: "pending",
    desc: null,
    content: null,
    verification: null,
    codeHash: null,
    testStatus: "none",
    confidence: 1,
    timeCreated: 0,
    timeUpdated: 0,
    ...patch,
  }
}

function edge(sourceID: NodeID, targetID: NodeID, relation: EdgeRow["relation"]): EdgeRow {
  return {
    id: `edge:${sourceID}:${targetID}:${relation}` as EdgeID,
    projectID: PID,
    sessionID: SID,
    sourceID,
    targetID,
    relation,
    confidence: 1,
    timeCreated: 0,
  }
}

const emptyMain: GraphView = { nodes: [], edges: [] }
const authority = (currentNodeID: NodeID | null, patch: Record<string, unknown> = {}) => ({
  mode: "atomic" as const,
  currentNodeID,
  checkpointKind: "atomic" as const,
  checkpointScopeNodeID: currentNodeID,
  checkpointStatus: "approved" as const,
  ...patch,
})

describe("Build gate", () => {
  test("blocks target outside CurrentPlan", () => {
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: "missing" as NodeID,
      workflow: authority("missing" as NodeID),
      main: emptyMain,
      currentPlan: { nodes: [], edges: [] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("target_not_in_current_plan")
  })

  test("blocks verified or deprecated target", () => {
    const verified = node("target", { status: "verified" })
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: verified.id,
      workflow: authority(verified.id),
      main: emptyMain,
      currentPlan: { nodes: [verified], edges: [] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("target_status_blocked")
  })

  test("blocks unimplemented blocks dependency", () => {
    const dep = node("dep", { status: "pending" })
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [dep, target], edges: [edge(dep.id, target.id, "blocks")] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("dependency_not_verified")
  })

  test("blocks implemented blocks dependency and allows verified dependency", () => {
    const dep = node("dep", { status: "implemented" })
    const target = node("target")
    const blocked = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [dep, target], edges: [edge(dep.id, target.id, "blocks")] },
    })

    expect(blocked.allowed).toBe(false)
    expect(blocked.issues.map((issue) => issue.code)).toContain("dependency_not_verified")

    const allowed = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [{ ...dep, status: "verified" }, target], edges: [edge(dep.id, target.id, "blocks")] },
    })
    expect(allowed.allowed).toBe(true)
  })

  test("blocks missing mode, pending checkpoint, and wrong current task", () => {
    const target = node("target")
    const currentPlan = { nodes: [target], edges: [] }
    const missingMode = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id, { mode: null }),
      main: emptyMain,
      currentPlan,
    })
    const pending = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id, { checkpointStatus: "pending" }),
      main: emptyMain,
      currentPlan,
    })
    const mismatch = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority("other" as NodeID),
      main: emptyMain,
      currentPlan,
    })

    expect(missingMode.issues.map((issue) => issue.code)).toContain("execution_mode_required")
    expect(pending.issues.map((issue) => issue.code)).toContain("checkpoint_pending")
    expect(mismatch.issues.map((issue) => issue.code)).toContain("current_task_mismatch")
  })

  test("requires atomic targets and unambiguous module scope", () => {
    const target = node("target")
    const composite = node("composite", { type: "composite", level: "L1" })
    const other = node("other", { type: "composite", level: "L1" })
    const nonAtomic = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: composite.id,
      workflow: authority(composite.id),
      main: emptyMain,
      currentPlan: { nodes: [composite], edges: [] },
    })
    const ambiguous = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id, { mode: "module", checkpointKind: "module", checkpointScopeNodeID: composite.id }),
      main: emptyMain,
      currentPlan: {
        nodes: [target, composite, other],
        edges: [edge(composite.id, target.id, "contains"), edge(other.id, target.id, "contains")],
      },
    })

    expect(nonAtomic.issues.map((issue) => issue.code)).toContain("target_not_atomic")
    expect(ambiguous.issues.map((issue) => issue.code)).toContain("module_scope_ambiguous")
  })

  test("blocks stale intent nodes", () => {
    const target = node("target", { content: { stale: true } })
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("stale_intent")
  })

  test("blocks invalid CurrentPlan", () => {
    const a = node("a")
    const b = node("b")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: a.id,
      workflow: authority(a.id),
      main: emptyMain,
      currentPlan: { nodes: [a, b], edges: [edge(a.id, b.id, "uses")] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("current_plan_invalid")
  })

  test("blocks conflicts with main graph", () => {
    const target = node("target")
    const mainTarget = node("target", { sessionID: null, name: "Target in main", status: "implemented" })
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: { nodes: [mainTarget], edges: [] },
      currentPlan: { nodes: [target], edges: [] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("conflict_detected")
  })

  test("blocks unresolved derivation issues", () => {
    const target = node("target")
    const issues: ConsistencyIssue[] = [
      { type: "missing_node", nodeId: "n", detail: "new code" },
      { type: "missing_code_ref", nodeId: target.id, detail: "bad ref" },
    ]
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      consistencyIssues: issues,
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("structural_drift")
    expect(result.issues.map((issue) => issue.code)).toContain("missing_code_reference")
  })

  test("blocks invalid artifact and reports required permissions", () => {
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "", test: "" },
      diagnosticsRequested: true,
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_artifact")
    expect(result.requiredPermissions).toEqual([])
  })

  test("allows valid target and reports artifact permission", () => {
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id),
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "export {}\n", test: "test\n" },
    })

    expect(result.allowed).toBe(true)
    expect(result.issues.map((issue) => issue.code)).toContain("verification_spec_missing")
    expect(result.requiredPermissions).toEqual(["artifact_write"])
  })

  test("blocks mutation after incomplete verification evidence", () => {
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      workflow: authority(target.id, { latestEvidenceComplete: false }),
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "export {}\n", test: "test\n" },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("verification_evidence_incomplete")
    expect(result.requiredPermissions).toEqual([])
  })
})
