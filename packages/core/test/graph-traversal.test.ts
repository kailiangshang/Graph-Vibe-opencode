import { describe, expect, test } from "bun:test"
import type { EdgeRow, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import * as Traversal from "@opencode-ai/core/graph/traversal"

const nid = (s: string): NodeID => s as unknown as NodeID

function makeNode(id: string): NodeRow {
  return {
    id: nid(id), projectID: "p" as any, sessionID: null, type: "atomic", name: id,
    level: "L2", priority: null, category: null, status: "pending", desc: null,
    content: null, codeHash: null, testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0,
  }
}

function makeEdge(id: string, sourceID: string, targetID: string, relation: EdgeRow["relation"] = "uses"): EdgeRow {
  return {
    id: id as any, projectID: "p" as any, sessionID: null, sourceID: nid(sourceID),
    targetID: nid(targetID), relation, confidence: 1, timeCreated: 0,
  }
}

describe("traversal.bfs", () => {
  test("maxDepth=0 means infinite", () => {
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C"), makeEdge("e3", "C", "D")]
    const reached = Traversal.bfs([nid("A")], edges)
    expect(reached.sort()).toEqual([nid("B"), nid("C"), nid("D")])
  })

  test("maxDepth=1 returns only direct neighbors", () => {
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C")]
    const reached = Traversal.bfs([nid("A")], edges, { maxDepth: 1 })
    expect(reached).toEqual([nid("B")])
  })

  test("relation filter", () => {
    const edges = [
      makeEdge("e1", "A", "B", "uses"), makeEdge("e2", "A", "C", "blocks"),
    ]
    const reached = Traversal.bfs([nid("A")], edges, { relation: "blocks" })
    expect(reached).toEqual([nid("C")])
  })

  test("visited guard prevents revisiting", () => {
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "A")]
    const reached = Traversal.bfs([nid("A")], edges)
    expect(reached).toEqual([nid("B")])
  })
})

describe("traversal.findPath", () => {
  test("shortest path via BFS", () => {
    const edges = [
      makeEdge("e1", "A", "B"), makeEdge("e2", "B", "D"),
      makeEdge("e3", "A", "C"), makeEdge("e4", "C", "D"), makeEdge("e5", "D", "E"),
    ]
    const path = Traversal.findPath(nid("A"), nid("E"), edges)
    expect(path).not.toBeNull()
    expect(path![0]).toBe(nid("A"))
    expect(path![path!.length - 1]).toBe(nid("E"))
    expect(path!.length).toBe(4)
  })

  test("same source and target", () => {
    const path = Traversal.findPath(nid("A"), nid("A"), [])
    expect(path).toEqual([nid("A")])
  })

  test("unreachable returns null", () => {
    const edges = [makeEdge("e1", "A", "B")]
    const path = Traversal.findPath(nid("A"), nid("Z"), edges)
    expect(path).toBeNull()
  })
})

describe("traversal.dfs", () => {
  test("maxDepth=0 means infinite", () => {
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C")]
    const reached = Traversal.dfs([nid("A")], edges)
    expect(reached.sort()).toEqual([nid("B"), nid("C")])
  })

  test("maxDepth=1 returns only direct neighbors", () => {
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C")]
    const reached = Traversal.dfs([nid("A")], edges, { maxDepth: 1 })
    expect(reached).toEqual([nid("B")])
  })
})

describe("traversal.extractSubgraph", () => {
  test("induced subgraph: only edges with both endpoints in set", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C"), makeNode("D")]
    const edges = [
      makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C"),
      makeEdge("e3", "C", "D"), makeEdge("e4", "A", "D"),
    ]
    const sub = Traversal.extractSubgraph(new Set([nid("A"), nid("B"), nid("C")]), nodes, edges)
    expect(sub.nodes.length).toBe(3)
    expect(sub.edges.length).toBe(2)
  })
})

describe("traversal.detectCycle", () => {
  test("acyclic graph returns null", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C")]
    expect(Traversal.detectCycle(nodes, edges)).toBeNull()
  })

  test("cyclic graph returns cycle path", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges = [
      makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C"), makeEdge("e3", "C", "A"),
    ]
    const cycle = Traversal.detectCycle(nodes, edges)
    expect(cycle).not.toBeNull()
    expect(cycle!.length).toBe(3)
    expect(new Set(cycle!)).toEqual(new Set([nid("A"), nid("B"), nid("C")]))
  })

  test("self-loop is a cycle of length 1", () => {
    const nodes = [makeNode("A")]
    const edges = [makeEdge("e1", "A", "A")]
    const cycle = Traversal.detectCycle(nodes, edges)
    expect(cycle).not.toBeNull()
    expect(cycle!).toEqual([nid("A")])
  })
})
