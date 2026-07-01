import { describe, expect, test } from "bun:test"
import type { ConsistencyIssue } from "@opencode-ai/core/graph/derivation/checker"
import type { ExpectedGraph, ExpectedNode } from "@opencode-ai/core/graph/derivation/builder"
import { buildReconciliationPlan } from "@opencode-ai/core/graph/derivation/reconcile"

function expNode(id: string, codeHash: string): ExpectedNode {
  return {
    id, type: "atomic", name: id, level: "L2", category: "file",
    content: { code_ref: { path: "src/foo.ts", type: "file" } }, codeHash, confidence: 1,
  }
}

const expected: ExpectedGraph = {
  nodes: [expNode("n1", "h1"), expNode("n2", "h2")],
  edges: [{ id: "ged_import:contains:n1:n2", sourceId: "n1", targetId: "n2", relation: "contains" }],
}

describe("reconcile.buildReconciliationPlan", () => {
  test("missing_node → nodesToAdd", () => {
    const issues: ConsistencyIssue[] = [{ type: "missing_node", nodeId: "n1", detail: "new" }]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.nodesToAdd.length).toBe(1)
    expect(plan.nodesToAdd[0].id).toBe("n1")
  })

  test("stale_node → nodesToRemove", () => {
    const issues: ConsistencyIssue[] = [{ type: "stale_node", nodeId: "old1", detail: "removed" }]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.nodesToRemove).toEqual(["old1"])
  })

  test("hash_mismatch → nodesToUpdate", () => {
    const issues: ConsistencyIssue[] = [{ type: "hash_mismatch", nodeId: "n1", detail: "changed", expected: "h1", stored: "h0" }]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.nodesToUpdate.length).toBe(1)
    expect(plan.nodesToUpdate[0].id).toBe("n1")
    expect(plan.nodesToUpdate[0].codeHash).toBe("h1")
  })

  test("missing_edge → edgesToAdd", () => {
    const issues: ConsistencyIssue[] = [{ type: "missing_edge", edgeId: "ged_import:contains:n1:n2", detail: "new" }]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.edgesToAdd.length).toBe(1)
  })

  test("stale_edge → edgesToRemove", () => {
    const issues: ConsistencyIssue[] = [{ type: "stale_edge", edgeId: "old_edge", detail: "removed" }]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.edgesToRemove).toEqual(["old_edge"])
  })

  test("intent_stale → intentStaleMarkings", () => {
    const issues: ConsistencyIssue[] = [
      { type: "intent_stale", nodeId: "intent1", detail: "stale" },
      { type: "missing_code", nodeId: "intent2", detail: "missing" },
    ]
    const plan = buildReconciliationPlan(issues, expected)
    expect(plan.intentStaleMarkings).toEqual(["intent1", "intent2"])
  })

  test("empty issues → empty plan", () => {
    const plan = buildReconciliationPlan([], expected)
    expect(plan.nodesToAdd).toEqual([])
    expect(plan.nodesToRemove).toEqual([])
    expect(plan.intentStaleMarkings).toEqual([])
  })
})
