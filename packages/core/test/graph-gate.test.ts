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

describe("Build gate", () => {
  test("blocks target outside CurrentPlan", () => {
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: "missing" as NodeID,
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
      main: emptyMain,
      currentPlan: { nodes: [dep, target], edges: [edge(dep.id, target.id, "blocks")] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("blocked_by_dependency")
  })

  test("allows implemented blocks dependency", () => {
    const dep = node("dep", { status: "implemented" })
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      main: emptyMain,
      currentPlan: { nodes: [dep, target], edges: [edge(dep.id, target.id, "blocks")] },
    })

    expect(result.allowed).toBe(true)
  })

  test("blocks stale intent nodes", () => {
    const target = node("target", { content: { stale: true } })
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
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
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "", test: "" },
      diagnosticsRequested: true,
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_artifact")
    expect(result.requiredPermissions).toEqual(["artifact_write", "diagnostics_run"])
  })

  test("allows valid target and reports artifact permission", () => {
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      main: emptyMain,
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "export {}\n", test: "test\n" },
    })

    expect(result.allowed).toBe(true)
    expect(result.requiredPermissions).toEqual(["artifact_write"])
  })
})
