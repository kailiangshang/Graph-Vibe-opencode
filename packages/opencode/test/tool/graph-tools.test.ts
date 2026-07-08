import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { GraphBuildGateTool } from "@/tool/graph/build-gate"
import { GraphPlanAdmitTool } from "@/tool/graph/plan-admit"
import { fromTool } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("proj_graph_tools")
const sessionID = SessionID.descending("ses_graph_tools")
const firstNodeID = GraphStorage.NodeID.create()
const secondNodeID = GraphStorage.NodeID.create()

const it = testEffect(
  LayerNode.compile(LayerNode.group([
    Database.node,
    Session.node,
    GraphStorage.node,
    GraphDomain.node,
    GraphAudit.node,
    GraphPlan.node,
    GraphBuild.node,
    EventV2Bridge.node,
    Truncate.node,
    Agent.node,
  ]), [
    [Database.node, Database.layerFromPath(":memory:")],
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

function seed() {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make("/tmp/graph-tools"),
          vcs: "git",
          sandboxes: [],
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "graph-tools",
          directory: AbsolutePath.make("/tmp/graph-tools"),
          title: "graph tools",
          version: "0.0.0-test",
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

function context(): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("graph tools", () => {
  it.instance("graph_plan_admit does not expose status fields", () =>
    Effect.gen(function* () {
      const info = yield* GraphPlanAdmitTool
      const tool = yield* Tool.init(info)
      expect(fromTool(tool)).not.toHaveProperty("properties.nodes.items.properties.status")
      expect(fromTool(tool)).not.toHaveProperty("properties.nodes.items.properties.testStatus")
    }),
  )

  it.instance("graph_plan_admit writes CurrentPlan using the opencode session project", () =>
    Effect.gen(function* () {
      yield* seed()
      const info = yield* GraphPlanAdmitTool
      const tool = yield* Tool.init(info)

      const result = yield* tool.execute(
        {
          nodes: [
            { id: firstNodeID, type: "atomic", name: "First", level: "L2" },
            { id: secondNodeID, type: "atomic", name: "Second", level: "L2" },
          ],
          edges: [{ sourceID: firstNodeID, targetID: secondNodeID, relation: "blocks" }],
        },
        context(),
      )

      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID })
      expect(result.title).toBe("CurrentPlan admitted")
      expect(JSON.parse(result.output)).toMatchObject({ nodesCreated: 2, edgesCreated: 1, dryRun: false })
      expect(currentPlan.nodes.map((node) => node.projectID)).toEqual([projectID, projectID])
      expect(currentPlan.nodes.map((node) => node.sessionID)).toEqual([sessionID, sessionID])
      expect(currentPlan.edges.map((edge) => edge.sessionID)).toEqual([sessionID])
    }),
  )

  it.instance("graph_plan_admit ignores model-supplied status fields", () =>
    Effect.gen(function* () {
      yield* seed()
      const info = yield* GraphPlanAdmitTool
      const tool = yield* Tool.init(info)
      const input = {
        nodes: [
          {
            id: firstNodeID,
            type: "atomic" as const,
            name: "Status bypass",
            level: "L2" as const,
            status: "verified",
            testStatus: "passed",
          },
        ],
        edges: [],
      }

      yield* tool.execute(input, context())

      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID })
      expect(currentPlan.nodes[0]?.status).toBe("pending")
      expect(currentPlan.nodes[0]?.testStatus).toBe("none")
    }),
  )

  it.instance("graph_plan_admit returns repairable output for invalid edge relations", () =>
    Effect.gen(function* () {
      yield* seed()
      const info = yield* GraphPlanAdmitTool
      const tool = yield* Tool.init(info)
      const sourceID = GraphStorage.NodeID.create()
      const targetID = GraphStorage.NodeID.create()

      const result = yield* tool.execute(
        {
          nodes: [
            { id: sourceID, type: "prd", name: "Goal", level: "L1" },
            { id: targetID, type: "atomic", name: "Worker", level: "L2" },
          ],
          edges: [{ sourceID, targetID, relation: "uses" }],
        },
        context(),
      )

      const parsed = JSON.parse(result.output)
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID })
      expect(result.title).toBe("CurrentPlan rejected")
      expect(parsed).toMatchObject({
        admitted: false,
        error: { rule: "edge.type_matrix" },
      })
      expect(parsed.error.message).toContain('relation "uses" invalid')
      expect(parsed.repairHints.join("\n")).toContain("Use a relation allowed by the graph edge matrix")
      expect(parsed.allowedEdgeMatrix.join("\n")).toContain("blocks")
      expect(currentPlan.nodes).toHaveLength(0)
      expect(currentPlan.edges).toHaveLength(0)
    }),
  )

  it.instance("graph_plan_admit returns repairable output for unknown node index references", () =>
    Effect.gen(function* () {
      yield* seed()
      const info = yield* GraphPlanAdmitTool
      const tool = yield* Tool.init(info)

      const result = yield* tool.execute(
        {
          nodes: [{ type: "atomic", name: "Only", level: "L2" }],
          edges: [
            {
              sourceID: "@0" as GraphStorage.NodeID,
              targetID: "@2" as GraphStorage.NodeID,
              relation: "blocks",
            },
          ],
        },
        context(),
      )

      const parsed = JSON.parse(result.output)
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID })
      expect(result.title).toBe("CurrentPlan rejected")
      expect(parsed).toMatchObject({
        admitted: false,
        error: { rule: "edge.dangling_endpoint" },
      })
      expect(parsed.error.message).toContain("@2")
      expect(parsed.repairHints.join("\n")).toContain("@0, @1")
      expect(currentPlan.nodes).toHaveLength(0)
      expect(currentPlan.edges).toHaveLength(0)
    }),
  )

  it.instance("graph_build_gate reports blocked gate results for targets outside CurrentPlan", () =>
    Effect.gen(function* () {
      yield* seed()
      const info = yield* GraphBuildGateTool
      const tool = yield* Tool.init(info)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        type: "atomic",
        name: "MainOnly",
        level: "L2",
      })

      const result = yield* tool.execute({ targetNodeID }, context())

      expect(result.title).toBe("Build gate blocked")
      expect(JSON.parse(result.output)).toMatchObject({
        allowed: false,
        issues: [{ code: "target_not_in_current_plan" }],
      })
    }),
  )
})
