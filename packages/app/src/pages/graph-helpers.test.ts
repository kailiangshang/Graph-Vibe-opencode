import { describe, expect, test } from "bun:test"
import { type GraphView, countByStatus, filterByLevel } from "./graph-helpers"

describe("countByStatus", () => {
  test("counts nodes grouped by status", () => {
    const nodes = [
      { id: "a", status: "pending" },
      { id: "b", status: "pending" },
      { id: "c", status: "verified" },
    ] as GraphView["nodes"]

    expect(countByStatus(nodes)).toEqual({ pending: 2, verified: 1 })
  })

  test("returns empty object for empty array", () => {
    expect(countByStatus([])).toEqual({})
  })
})

describe("filterByLevel", () => {
  const data: GraphView = {
    nodes: [
      { id: "1", type: "prd", status: "pending" },
      { id: "2", type: "composite", status: "implemented" },
      { id: "3", type: "atomic", status: "verified" },
      { id: "4", type: "atomic", status: "pending" },
    ] as GraphView["nodes"],
    edges: [
      { id: "e1", sourceID: "1", targetID: "3", relation: "contains" },
      { id: "e2", sourceID: "3", targetID: "4", relation: "blocks" },
    ],
  }

  test("returns full data for 'all'", () => {
    const result = filterByLevel(data, "all")
    expect(result.nodes.length).toBe(4)
    expect(result.edges.length).toBe(2)
  })

  test("filters to prd + composite for L1", () => {
    const result = filterByLevel(data, "L1")
    expect(result.nodes.length).toBe(2)
    expect(result.nodes.every((n) => n.type === "prd" || n.type === "composite")).toBe(true)
    expect(result.edges.length).toBe(0)
  })

  test("filters to atomic for L2", () => {
    const result = filterByLevel(data, "L2")
    expect(result.nodes.length).toBe(2)
    expect(result.nodes.every((n) => n.type === "atomic")).toBe(true)
    expect(result.edges.length).toBe(1)
  })

  test("returns empty for undefined data", () => {
    expect(filterByLevel(undefined, "all")).toEqual({ nodes: [], edges: [] })
  })
})
