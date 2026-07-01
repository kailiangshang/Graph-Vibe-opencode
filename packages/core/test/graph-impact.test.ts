import { describe, expect, test } from "bun:test"
import type { EdgeRow, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import * as Impact from "@opencode-ai/core/graph/impact"

const nid = (s: string): NodeID => s as unknown as NodeID

function makeNode(id: string, priority?: NodeRow["priority"]): NodeRow {
  return {
    id: nid(id), projectID: "p" as any, sessionID: null, type: "atomic", name: id,
    level: "L2", priority: priority ?? null, category: null, status: "pending", desc: null,
    content: null, codeHash: null, testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0,
  }
}

function makeEdge(id: string, sourceID: string, targetID: string, relation: EdgeRow["relation"] = "uses"): EdgeRow {
  return { id: id as any, projectID: "p" as any, sessionID: null, sourceID: nid(sourceID), targetID: nid(targetID), relation, confidence: 1, timeCreated: 0 }
}

describe("impact.assessImpact", () => {
  test("direct = out-edge targets", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "A", "C"), makeEdge("e3", "B", "C")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(new Set(r.direct)).toEqual(new Set([nid("B"), nid("C")]))
  })

  test("indirect = recursive out-edges, new nodes only", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C"), makeNode("D")]
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C"), makeEdge("e3", "C", "D")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(new Set(r.indirect)).toEqual(new Set([nid("C"), nid("D")]))
  })

  test("upstream = in-edge sources, depth 1 only", () => {
    const nodes = [makeNode("A"), makeNode("X"), makeNode("Y"), makeNode("Z")]
    const edges = [makeEdge("e1", "X", "A"), makeEdge("e2", "Y", "A"), makeEdge("e3", "Z", "X")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(new Set(r.upstream)).toEqual(new Set([nid("X"), nid("Y")]))
    expect(r.upstream).not.toContain(nid("Z"))
  })

  test("downstream = direct ∪ indirect", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges = [makeEdge("e1", "A", "B"), makeEdge("e2", "B", "C")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(new Set(r.downstream)).toEqual(new Set([nid("B"), nid("C")]))
  })

  test("risk high when downstream > 10", () => {
    const nodes = [makeNode("A")]
    const edges: EdgeRow[] = []
    for (let i = 1; i <= 11; i++) {
      nodes.push(makeNode(`N${i}`))
      edges.push(makeEdge(`e${i}`, "A", `N${i}`))
    }
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(r.risk).toBe("high")
  })

  test("risk high when any downstream node is P0", () => {
    const nodes = [makeNode("A"), makeNode("B", "P0")]
    const edges = [makeEdge("e1", "A", "B")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(r.risk).toBe("high")
  })

  test("risk medium for 3–10 downstream", () => {
    const nodes = [makeNode("A")]
    const edges: EdgeRow[] = []
    for (let i = 1; i <= 5; i++) {
      nodes.push(makeNode(`N${i}`))
      edges.push(makeEdge(`e${i}`, "A", `N${i}`))
    }
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(r.risk).toBe("medium")
  })

  test("risk low for 0–2 downstream", () => {
    const nodes = [makeNode("A"), makeNode("B")]
    const edges = [makeEdge("e1", "A", "B")]
    const r = Impact.assessImpact(nid("A"), nodes, edges)
    expect(r.risk).toBe("low")
  })
})
