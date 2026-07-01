import { describe, expect, test } from "bun:test"
import type { EdgeRow, GraphView, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import * as Conflict from "@opencode-ai/core/graph/conflict"

const nid = (s: string): NodeID => s as unknown as NodeID

function makeNode(over: Partial<Omit<NodeRow, "id">> & { id: NodeID | string }): NodeRow {
  return {
    projectID: "p" as any, sessionID: null, type: "atomic", name: "n",
    level: "L2", priority: null, category: null, status: "pending", desc: null,
    content: null, codeHash: null, testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0, ...over, id: over.id as NodeID,
  } as NodeRow
}

function makeEdge(id: string, sourceID: string, targetID: string, relation: EdgeRow["relation"] = "uses"): EdgeRow {
  return { id: id as any, projectID: "p" as any, sessionID: null, sourceID: nid(sourceID), targetID: nid(targetID), relation, confidence: 1, timeCreated: 0 }
}

const view = (nodes: NodeRow[], edges: EdgeRow[]): GraphView => ({ nodes, edges })

describe("conflict.detectConflicts", () => {
  test("node_modified: same ID, different status", () => {
    const main = view([makeNode({ id: "A", status: "implemented" })], [])
    const plan = view([makeNode({ id: "A", status: "verified" })], [])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "node_modified")).toBe(true)
  })

  test("node_deleted: main node deprecated", () => {
    const main = view([makeNode({ id: "A", status: "deprecated" })], [])
    const plan = view([makeNode({ id: "A", status: "implemented" })], [])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "node_deleted")).toBe(true)
  })

  test("new node (not in main) = no conflict", () => {
    const main = view([], [])
    const plan = view([makeNode({ id: "A" })], [])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "node_modified" || c.type === "node_deleted")).toBe(false)
  })

  test("nodesEqual excludes sessionID (key fix)", () => {
    const main = view([makeNode({ id: "A", sessionID: null, status: "implemented" })], [])
    const plan = view([makeNode({ id: "A", sessionID: "ses_1", status: "implemented" })], [])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "node_modified")).toBe(false)
  })

  test("edge_modified: same ID, different confidence", () => {
    const main = view([], [makeEdge("e1", "A", "B")])
    const planEdge: EdgeRow = { ...makeEdge("e1", "A", "B"), confidence: 0.5 }
    const plan = view([], [planEdge])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "edge_modified")).toBe(true)
  })

  test("edge_modified: new ID but same triple in main", () => {
    const main = view([makeNode({ id: "A" }), makeNode({ id: "B" })], [makeEdge("e1", "A", "B", "uses")])
    const plan = view([makeNode({ id: "A" }), makeNode({ id: "B" })], [makeEdge("e2", "A", "B", "uses")])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "edge_modified")).toBe(true)
  })

  test("cycle: plan edge creates cycle in merged graph", () => {
    const main = view([makeNode({ id: "A" }), makeNode({ id: "B" })], [makeEdge("e1", "A", "B", "blocks")])
    const plan = view([makeNode({ id: "A" }), makeNode({ id: "B" })], [makeEdge("e2", "B", "A", "blocks")])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts.some((c) => c.type === "cycle" || c.type === "constraint")).toBe(true)
  })

  test("no conflicts when plan is clean new subgraph", () => {
    const main = view([makeNode({ id: "A" })], [])
    const plan = view([makeNode({ id: "B" })], [])
    const conflicts = Conflict.detectConflicts(plan, main)
    expect(conflicts).toEqual([])
  })
})
