import { describe, expect, test } from "bun:test"
import { Graph } from "../src/graph"
import { EventManifest } from "../src/event-manifest"

describe("graph event definitions", () => {
  test("defines graph.plan.updated and graph.main.updated events", () => {
    expect(Graph.Event.PlanUpdated.type).toBe("graph.plan.updated")
    expect(Graph.Event.MainUpdated.type).toBe("graph.main.updated")
  })

  test("Event.Definitions includes both graph events", () => {
    const types = Graph.Event.Definitions.map((d) => d.type)
    expect(types).toContain("graph.plan.updated")
    expect(types).toContain("graph.main.updated")
    expect(Graph.Event.Definitions).toEqual([Graph.Event.PlanUpdated, Graph.Event.MainUpdated])
  })

  test("ServerDefinitions includes both graph event types", () => {
    const types = EventManifest.ServerDefinitions.map((d) => d.type)
    expect(types).toContain("graph.plan.updated")
    expect(types).toContain("graph.main.updated")
  })

  test("Definitions includes both graph event types", () => {
    const types = EventManifest.Definitions.map((d) => d.type)
    expect(types).toContain("graph.plan.updated")
    expect(types).toContain("graph.main.updated")
  })
})
