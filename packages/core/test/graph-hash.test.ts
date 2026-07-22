import { describe, expect, test } from "bun:test"
import { GraphHash } from "@opencode-ai/core/graph/hash"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { ProjectV2 } from "@opencode-ai/core/project"

const projectID = ProjectV2.ID.make("project-a")
const nodeA = {
  id: GraphStorage.NodeID.make("node-a"),
  projectID,
  sessionID: "session-a",
  type: "atomic" as const,
  name: "Build API",
  level: "L2" as const,
  priority: "P1" as const,
  category: "backend",
  status: "verified" as const,
  desc: "Expose endpoint",
  content: { z: 1, nested: { second: true, first: "value" } },
  verification: {
    diagnostics: [{ paths: ["src/api.test.ts"], name: "test" as const }],
    criteria: ["Endpoint responds"],
  },
  codeHash: "code-a",
  testStatus: "passed" as const,
  confidence: 0.9,
  timeCreated: 10,
  timeUpdated: 20,
} satisfies GraphStorage.NodeRow
const nodeB = {
  ...nodeA,
  id: GraphStorage.NodeID.make("node-b"),
  name: "Build UI",
  content: { component: "Graph" },
  verification: null,
} satisfies GraphStorage.NodeRow
const edge = {
  id: GraphStorage.EdgeID.make("edge-a"),
  projectID,
  sessionID: "session-a",
  sourceID: nodeA.id,
  targetID: nodeB.id,
  relation: "blocks" as const,
  confidence: 0.8,
  timeCreated: 30,
} satisfies GraphStorage.EdgeRow

describe("GraphHash", () => {
  test("is deterministic across graph order, nested key order, ownership, and timestamps", () => {
    const first = GraphHash.digest({ nodes: [nodeA, nodeB], edges: [edge] })
    const reordered = GraphHash.digest({
      nodes: [
        { ...nodeB, projectID: ProjectV2.ID.make("project-b"), sessionID: "session-b", timeCreated: 99 },
        {
          ...nodeA,
          projectID: ProjectV2.ID.make("project-b"),
          sessionID: "session-b",
          timeCreated: 98,
          timeUpdated: 100,
          content: { nested: { first: "value", second: true }, z: 1 },
          verification: {
            criteria: ["Endpoint responds"],
            diagnostics: [{ name: "test" as const, paths: ["src/api.test.ts"] }],
          },
        },
      ],
      edges: [{ ...edge, projectID: ProjectV2.ID.make("project-b"), sessionID: "session-b", timeCreated: 100 }],
    })

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(reordered).toBe(first)
  })

  test("changes for semantically relevant node, nested, verification, and edge fields", () => {
    const original = GraphHash.digest({ nodes: [nodeA, nodeB], edges: [edge] })
    const changed: GraphStorage.GraphView[] = [
      { nodes: [{ ...nodeA, name: "Changed API" }, nodeB], edges: [edge] },
      { nodes: [{ ...nodeA, content: { z: 2 } }, nodeB], edges: [edge] },
      {
        nodes: [{ ...nodeA, verification: { ...nodeA.verification, criteria: ["Changed criterion"] } }, nodeB],
        edges: [edge],
      },
      { nodes: [nodeA, nodeB], edges: [{ ...edge, relation: "uses" as const }] },
      { nodes: [nodeA, nodeB], edges: [{ ...edge, confidence: 0.7 }] },
    ]

    expect(changed.map(GraphHash.digest).every((digest) => digest !== original)).toBe(true)
  })
})
