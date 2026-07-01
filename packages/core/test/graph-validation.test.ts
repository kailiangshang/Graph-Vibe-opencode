import { describe, expect, test } from "bun:test"
import type { EdgeRow, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import * as Validation from "@opencode-ai/core/graph/validation"

const nid = (s: string): NodeID => s as unknown as NodeID

function makeNode(over: Partial<Omit<NodeRow, "id">> & { id: NodeID | string }): NodeRow {
  return {
    projectID: "p" as any, sessionID: null, type: "atomic", name: "n",
    level: "L2", priority: null, category: null, status: "pending", desc: null,
    content: null, codeHash: null, testStatus: "none", confidence: 1,
    timeCreated: 0, timeUpdated: 0, ...over,
    id: over.id as NodeID,
  }
}

function makeEdge(id: string, sourceID: string, targetID: string, relation: EdgeRow["relation"] = "uses"): EdgeRow {
  return { id: id as any, projectID: "p" as any, sessionID: null, sourceID: nid(sourceID), targetID: nid(targetID), relation, confidence: 1, timeCreated: 0 }
}

describe("validation.isImportedCodeNode", () => {
  test("category package = imported", () => {
    expect(Validation.isImportedCodeNode(makeNode({ id: "a", category: "package" }))).toBe(true)
  })
  test("category func = imported", () => {
    expect(Validation.isImportedCodeNode(makeNode({ id: "a", category: "func" }))).toBe(true)
  })
  test("content with project_type+module = imported", () => {
    expect(Validation.isImportedCodeNode(makeNode({ id: "a", content: { project_type: "node", module: "myapp" } }))).toBe(true)
  })
  test("no category, no content = not imported", () => {
    expect(Validation.isImportedCodeNode(makeNode({ id: "a" }))).toBe(false)
  })
})

describe("validation.validateNode", () => {
  test("confidence out of range", () => {
    const issues = Validation.validateNode(makeNode({ id: "a", confidence: 1.5 }))
    expect(issues.some((i) => i.rule === "node.confidence_range")).toBe(true)
  })
  test("confidence negative", () => {
    const issues = Validation.validateNode(makeNode({ id: "a", confidence: -0.1 }))
    expect(issues.some((i) => i.rule === "node.confidence_range")).toBe(true)
  })
  test("valid node has no issues", () => {
    expect(Validation.validateNode(makeNode({ id: "a" }))).toEqual([])
  })
})

describe("validation.validateEdge — self-loop", () => {
  test("self-loop rejected", () => {
    const n = makeNode({ id: "A" })
    const issues = Validation.validateEdge(n, n, makeEdge("e1", "A", "A"))
    expect(issues.some((i) => i.rule === "edge.self_loop")).toBe(true)
  })
})

describe("validation.validateEdge — type matrix (normal nodes)", () => {
  test("contains: same-type L1→L2 valid", () => {
    const src = makeNode({ id: "S", type: "prd", level: "L1" })
    const tgt = makeNode({ id: "T", type: "prd", level: "L2" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "contains"))).toEqual([])
  })
  test("contains: cross-type rejected", () => {
    const src = makeNode({ id: "S", type: "prd", level: "L1" })
    const tgt = makeNode({ id: "T", type: "composite", level: "L2" })
    const issues = Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "contains"))
    expect(issues.some((i) => i.rule === "edge.type_matrix")).toBe(true)
  })
  test("blocks: same-type same-level valid", () => {
    const a = makeNode({ id: "A", type: "atomic", level: "L2" })
    const b = makeNode({ id: "B", type: "atomic", level: "L2" })
    expect(Validation.validateEdge(a, b, makeEdge("e1", "A", "B", "blocks"))).toEqual([])
  })
  test("blocks: different type rejected", () => {
    const a = makeNode({ id: "A", type: "prd", level: "L1" })
    const b = makeNode({ id: "B", type: "atomic", level: "L2" })
    expect(Validation.validateEdge(a, b, makeEdge("e1", "A", "B", "blocks")).length).toBeGreaterThan(0)
  })
  test("addresses: composite(L2)→prd(L2) valid", () => {
    const src = makeNode({ id: "S", type: "composite", level: "L2" })
    const tgt = makeNode({ id: "T", type: "prd", level: "L2" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "addresses"))).toEqual([])
  })
  test("addresses: wrong type rejected", () => {
    const src = makeNode({ id: "S", type: "atomic", level: "L2" })
    const tgt = makeNode({ id: "T", type: "prd", level: "L2" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "addresses")).length).toBeGreaterThan(0)
  })
  test("uses: composite(L2)→atomic(L2) valid", () => {
    const src = makeNode({ id: "S", type: "composite", level: "L2" })
    const tgt = makeNode({ id: "T", type: "atomic", level: "L2" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "uses"))).toEqual([])
  })
  test("deprecated_by: same-type same-level valid", () => {
    const a = makeNode({ id: "A", type: "atomic", level: "L2" })
    const b = makeNode({ id: "B", type: "atomic", level: "L2" })
    expect(Validation.validateEdge(a, b, makeEdge("e1", "A", "B", "deprecated_by"))).toEqual([])
  })
})

describe("validation.validateEdge — imported-code", () => {
  test("contains: prd→composite imported chain valid", () => {
    const src = makeNode({ id: "S", type: "prd", level: "L1" })
    const tgt = makeNode({ id: "T", type: "composite", level: "L2", category: "package" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "contains"))).toEqual([])
  })
  test("contains: composite→atomic imported chain valid", () => {
    const src = makeNode({ id: "S", type: "composite", level: "L2", category: "package" })
    const tgt = makeNode({ id: "T", type: "atomic", level: "L2", category: "file" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "contains"))).toEqual([])
  })
  test("uses: imported file↔file valid", () => {
    const src = makeNode({ id: "S", type: "atomic", level: "L2", category: "file" })
    const tgt = makeNode({ id: "T", type: "atomic", level: "L2", category: "file" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "uses"))).toEqual([])
  })
  test("uses: imported func↔var valid (same decl tier)", () => {
    const src = makeNode({ id: "S", type: "atomic", level: "L2", category: "func" })
    const tgt = makeNode({ id: "T", type: "atomic", level: "L2", category: "var" })
    expect(Validation.validateEdge(src, tgt, makeEdge("e1", "S", "T", "uses"))).toEqual([])
  })
})

describe("validation.checkNameUnique", () => {
  test("duplicate name in same type+level", () => {
    const a = makeNode({ id: "A", type: "atomic", level: "L2", name: "foo" })
    const b = makeNode({ id: "B", type: "atomic", level: "L2", name: "foo" })
    expect(Validation.checkNameUnique(a, [a, b]).length).toBeGreaterThan(0)
  })
  test("same name different type = OK", () => {
    const a = makeNode({ id: "A", type: "prd", level: "L1", name: "foo" })
    const b = makeNode({ id: "B", type: "atomic", level: "L2", name: "foo" })
    expect(Validation.checkNameUnique(a, [a, b])).toEqual([])
  })
})

describe("validation.validateSubgraph", () => {
  test("collects multiple issues without short-circuit", () => {
    const a = makeNode({ id: "A", type: "atomic", level: "L2", confidence: 2 }) // confidence issue
    const b = makeNode({ id: "B", type: "atomic", level: "L2" })
    const e = makeEdge("e1", "A", "X", "uses") // X doesn't exist → dangling
    const issues = Validation.validateSubgraph([a, b], [e])
    expect(issues.some((i) => i.rule === "node.confidence_range")).toBe(true)
    expect(issues.some((i) => i.rule === "edge.dangling_endpoint")).toBe(true)
  })

  test("cycle detected", () => {
    const nodes = [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })]
    const edges = [makeEdge("e1", "A", "B", "blocks"), makeEdge("e2", "B", "C", "blocks"), makeEdge("e3", "C", "A", "blocks")]
    const issues = Validation.validateSubgraph(nodes, edges)
    expect(issues.some((i) => i.rule === "graph.cycle")).toBe(true)
  })

  test("valid subgraph has no issues", () => {
    const nodes = [makeNode({ id: "A" }), makeNode({ id: "B" })]
    const edges = [makeEdge("e1", "A", "B", "blocks")]
    expect(Validation.validateSubgraph(nodes, edges)).toEqual([])
  })
})
