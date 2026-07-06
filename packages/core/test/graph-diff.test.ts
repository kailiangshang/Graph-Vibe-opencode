import { describe, expect, test } from "bun:test"
import * as GraphDiff from "@opencode-ai/core/graph/diff"
import * as BuildOrder from "@opencode-ai/core/graph/build-order"
import type { EdgeRow, NodeRow, NodeID, EdgeID } from "@opencode-ai/core/graph/storage"

function makeNode(id: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: id as NodeID, projectID: "p" as any, sessionID: null, type: "atomic", name: id,
    level: "L2", priority: null, category: null, status: "pending",
    desc: null, content: null, codeHash: null, testStatus: "none",
    confidence: 1, timeCreated: 0, timeUpdated: 0, ...overrides,
  }
}

function makeEdge(id: string, sourceID: string, targetID: string, relation: string = "blocks"): EdgeRow {
  return { id: id as EdgeID, projectID: "p" as any, sessionID: null, sourceID: sourceID as NodeID, targetID: targetID as NodeID, relation: relation as EdgeRow["relation"], confidence: 1, timeCreated: 0 }
}

describe("graphDiff", () => {
  test("detects added nodes", () => {
    const left = { nodes: [makeNode("A")], edges: [] }
    const right = { nodes: [makeNode("A"), makeNode("B")], edges: [] }
    const diff = GraphDiff.graphDiff(left, right)
    expect(diff.nodes.added.map((n) => n.id as string)).toEqual(["B"])
    expect(diff.summary.nodesAdded).toBe(1)
  })

  test("detects removed nodes", () => {
    const left = { nodes: [makeNode("A"), makeNode("B")], edges: [] }
    const right = { nodes: [makeNode("A")], edges: [] }
    const diff = GraphDiff.graphDiff(left, right)
    expect(diff.nodes.removed.map((n) => n.id as string)).toEqual(["B"])
    expect(diff.summary.nodesRemoved).toBe(1)
  })

  test("detects modified node fields", () => {
    const left = { nodes: [makeNode("A", { status: "pending", testStatus: "none" })], edges: [] }
    const right = { nodes: [makeNode("A", { status: "verified", testStatus: "passed" })], edges: [] }
    const diff = GraphDiff.graphDiff(left, right)
    expect(diff.nodes.modified.length).toBe(1)
    expect(diff.nodes.modified[0].fields).toContain("status")
    expect(diff.nodes.modified[0].fields).toContain("testStatus")
  })

  test("detects added and removed edges", () => {
    const left = { nodes: [makeNode("A"), makeNode("B")], edges: [makeEdge("e1", "A", "B")] }
    const right = { nodes: [makeNode("A"), makeNode("B")], edges: [makeEdge("e2", "B", "A")] }
    const diff = GraphDiff.graphDiff(left, right)
    expect(diff.edges.added.length).toBe(1)
    expect(diff.edges.removed.length).toBe(1)
  })

  test("no changes returns empty diff", () => {
    const graph = { nodes: [makeNode("A")], edges: [] }
    const diff = GraphDiff.graphDiff(graph, graph)
    expect(diff.summary).toEqual({
      nodesAdded: 0, nodesRemoved: 0, nodesModified: 0, edgesAdded: 0, edgesRemoved: 0,
    })
  })
})

describe("BuildOrder", () => {
  test("topologicalOrder respects blocks edges", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges = [
      makeEdge("e1", "A", "B"),  // A blocks B
      makeEdge("e2", "B", "C"),  // B blocks C
    ]
    const order = BuildOrder.topologicalOrder(nodes, edges).map((n) => n.id as string)
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"))
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"))
  })

  test("buildableNodes returns pending nodes with verified or no blocks-sources", () => {
    const nodes = [
      makeNode("A", { status: "pending" }),
      makeNode("B", { status: "pending" }),
      makeNode("C", { status: "verified" }),
    ]
    const edges = [makeEdge("e1", "C", "B")]  // C blocks B, C is verified → B is buildable
    const buildable = BuildOrder.buildableNodes(nodes, edges).map((n) => n.id as string)
    expect(buildable).toContain("A")
    expect(buildable).toContain("B")
  })

  test("buildableNodes excludes pending nodes with unverified blocks-source", () => {
    const nodes = [
      makeNode("A", { status: "pending" }),
      makeNode("B", { status: "pending" }),
    ]
    const edges = [makeEdge("e1", "A", "B")]  // A blocks B, A is pending → B NOT buildable
    const buildable = BuildOrder.buildableNodes(nodes, edges).map((n) => n.id as string)
    expect(buildable).toContain("A")
    expect(buildable).not.toContain("B")
  })

  test("buildableNodes excludes non-pending nodes", () => {
    const nodes = [
      makeNode("A", { status: "implemented" }),
      makeNode("B", { status: "verified" }),
      makeNode("C", { status: "pending" }),
    ]
    const buildable = BuildOrder.buildableNodes(nodes, []).map((n) => n.id as string)
    expect(buildable).toEqual(["C"])
  })
})
