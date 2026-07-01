import { describe, expect, test } from "bun:test"
import type { EdgeRow, GraphView, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import type { ExpectedGraph, ExpectedNode } from "@opencode-ai/core/graph/derivation/builder"
import { checkConsistency } from "@opencode-ai/core/graph/derivation/checker"

const nid = (s: string): NodeID => s as unknown as NodeID

function makeImportedNode(over: Partial<NodeRow> & Pick<NodeRow, "id" | "name" | "category" | "codeHash">): NodeRow {
  return {
    projectID: "p" as any, sessionID: null, type: "atomic",
    level: "L2", priority: null, status: "implemented", desc: null,
    content: null, testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0, ...over,
  } as NodeRow
}

function makeIntentNode(over: Partial<NodeRow> & Pick<NodeRow, "id" | "name">): NodeRow {
  return {
    projectID: "p" as any, sessionID: null, type: "atomic",
    level: "L2", priority: null, category: null, status: "implemented", desc: null,
    content: { code_ref: { path: "src/svc.ts", type: "file" } }, codeHash: "oldhash",
    testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0, ...over,
  } as NodeRow
}

function makeEdge(id: string, sourceID: string, targetID: string): EdgeRow {
  return { id: id as any, projectID: "p" as any, sessionID: null, sourceID: nid(sourceID), targetID: nid(targetID), relation: "contains", confidence: 1, timeCreated: 0 }
}

function expNode(over: Partial<ExpectedNode> & Pick<ExpectedNode, "id" | "name" | "codeHash">): ExpectedNode {
  return {
    type: "atomic", level: "L2", category: "file",
    content: { code_ref: { path: "src/foo.ts", type: "file" } },
    confidence: 1, ...over,
  }
}

const emptyView: GraphView = { nodes: [], edges: [] }

describe("checker.checkConsistency", () => {
  test("missing_node: expected has node not in stored", () => {
    const expected: ExpectedGraph = { nodes: [expNode({ id: "n1", name: "foo", codeHash: "h1" })], edges: [] }
    const issues = checkConsistency(expected, emptyView)
    expect(issues.some((i) => i.type === "missing_node" && i.nodeId === "n1")).toBe(true)
  })

  test("stale_node: stored has imported node not in expected", () => {
    const stored: GraphView = {
      nodes: [makeImportedNode({ id: nid("n1"), name: "old", category: "file", codeHash: "h1" })],
      edges: [],
    }
    const issues = checkConsistency({ nodes: [], edges: [] }, stored)
    expect(issues.some((i) => i.type === "stale_node" && i.nodeId === "n1")).toBe(true)
  })

  test("hash_mismatch: same ID, different codeHash", () => {
    const expected: ExpectedGraph = { nodes: [expNode({ id: "n1", name: "foo", codeHash: "new" })], edges: [] }
    const stored: GraphView = {
      nodes: [makeImportedNode({ id: nid("n1"), name: "foo", category: "file", codeHash: "old" })],
      edges: [],
    }
    const issues = checkConsistency(expected, stored)
    expect(issues.some((i) => i.type === "hash_mismatch" && i.nodeId === "n1")).toBe(true)
  })

  test("no issues when expected matches stored", () => {
    const expected: ExpectedGraph = { nodes: [expNode({ id: "n1", name: "foo", codeHash: "h1" })], edges: [] }
    const stored: GraphView = {
      nodes: [makeImportedNode({ id: nid("n1"), name: "foo", category: "file", codeHash: "h1" })],
      edges: [],
    }
    expect(checkConsistency(expected, stored)).toEqual([])
  })

  test("missing_edge and stale_edge", () => {
    const expected: ExpectedGraph = {
      nodes: [],
      edges: [{ id: "ged_import:contains:e1:e2", sourceId: "e1", targetId: "e2", relation: "contains" }],
    }
    const stored: GraphView = {
      nodes: [],
      edges: [makeEdge("ged_import:contains:e3:e4", "e3", "e4")],
    }
    const issues = checkConsistency(expected, stored)
    expect(issues.some((i) => i.type === "missing_edge")).toBe(true)
    expect(issues.some((i) => i.type === "stale_edge")).toBe(true)
  })

  test("intent_stale: intent node code_hash mismatches expected file", () => {
    const expected: ExpectedGraph = {
      nodes: [expNode({ id: "file1", name: "src/svc.ts", codeHash: "newhash", category: "file", content: { code_ref: { path: "src/svc.ts", type: "file" } } })],
      edges: [],
    }
    const stored: GraphView = {
      nodes: [
        makeImportedNode({ id: nid("file1"), name: "src/svc.ts", category: "file", codeHash: "newhash" }),
        makeIntentNode({ id: nid("intent1"), name: "Service", codeHash: "oldhash" }),
      ],
      edges: [],
    }
    const issues = checkConsistency(expected, stored)
    expect(issues.some((i) => i.type === "intent_stale" && i.nodeId === "intent1")).toBe(true)
  })

  test("missing_code: intent node references non-existent file", () => {
    const expected: ExpectedGraph = { nodes: [], edges: [] }
    const stored: GraphView = {
      nodes: [makeIntentNode({ id: nid("intent1"), name: "Service" })],
      edges: [],
    }
    const issues = checkConsistency(expected, stored)
    expect(issues.some((i) => i.type === "missing_code" && i.nodeId === "intent1")).toBe(true)
  })
})
