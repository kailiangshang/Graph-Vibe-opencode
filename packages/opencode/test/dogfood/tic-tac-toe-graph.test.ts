import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectDir = path.resolve(import.meta.dir, "../../examples/tic-tac-toe")
const projectID = ProjectV2.ID.make("proj_tictactoe_dogfood")
const sessionID = SessionID.descending("ses_tictactoe_dogfood")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      GraphStorage.node,
      GraphDomain.node,
      GraphAudit.node,
      GraphBuild.node,
      GraphPlan.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [Config.node, TestConfig.layer()],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

function seed() {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      yield* db.insert(ProjectTable).values({
        id: projectID,
        worktree: AbsolutePath.make(projectDir),
        vcs: null,
        sandboxes: [],
        time_created: 0,
        time_updated: 0,
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({
        id: sessionID,
        project_id: projectID,
        slug: "tictactoe",
        directory: AbsolutePath.make(projectDir),
        title: "Tic-Tac-Toe Dogfood",
        version: "0.0.0-test",
        time_created: 0,
        time_updated: 0,
      }).run().pipe(Effect.orDie)
    }),
  )
}

describe("dogfood: tic-tac-toe graph workflow", () => {
  it.effect("Plan phase: admit a development plan for tic-tac-toe", () =>
    Effect.gen(function* () {
      yield* seed()
      const plan = yield* GraphPlan.Service

      const result = yield* plan.admit({
        projectID,
        sessionID,
        nodes: [
          { id: "ttt_logic", type: "composite", name: "Game Logic", level: "L2", desc: "Board state, moves, win detection" },
          { id: "ttt_cli", type: "composite", name: "CLI Interface", level: "L2", desc: "Render board, read input" },
          { id: "ttt_board", type: "atomic", name: "Board Model", level: "L2", category: "model" },
          { id: "ttt_validate", type: "atomic", name: "Move Validation", level: "L2", category: "logic" },
          { id: "ttt_win", type: "atomic", name: "Win Detection", level: "L2", category: "logic" },
          { id: "ttt_render", type: "atomic", name: "Board Renderer", level: "L2", category: "ui" },
        ],
        edges: [
          { sourceID: "ttt_logic" as any, targetID: "ttt_board" as any, relation: "uses" },
          { sourceID: "ttt_logic" as any, targetID: "ttt_validate" as any, relation: "uses" },
          { sourceID: "ttt_logic" as any, targetID: "ttt_win" as any, relation: "uses" },
          { sourceID: "ttt_cli" as any, targetID: "ttt_render" as any, relation: "uses" },
          { sourceID: "ttt_validate" as any, targetID: "ttt_win" as any, relation: "blocks" },
        ],
      })

      expect(result.nodesCreated).toBe(6)
      expect(result.edgesCreated).toBe(5)

      const domain = yield* GraphDomain.Service
      const currentPlan = yield* domain.currentPlan({ sessionID })
      expect(currentPlan.nodes.length).toBe(6)
      expect(currentPlan.edges.length).toBe(5)
    }),
  )

  it.effect("Build gate: blocks target when dependency is pending", () =>
    Effect.gen(function* () {
      yield* seed()
      const plan = yield* GraphPlan.Service
      const build = yield* GraphBuild.Service

      yield* plan.admit({
        projectID,
        sessionID,
        nodes: [
          { id: "dep_a", type: "atomic", name: "Dependency", level: "L2" },
          { id: "tgt_a", type: "atomic", name: "Target", level: "L2" },
        ],
        edges: [
          { sourceID: "dep_a" as any, targetID: "tgt_a" as any, relation: "blocks" },
        ],
      })

      const currentPlan = yield* (yield* GraphDomain.Service).currentPlan({ sessionID })
      const targetID = currentPlan.nodes.find((n) => n.name === "Target")!.id

      const gate = yield* build.evaluate({
        projectID,
        sessionID,
        targetNodeID: targetID,
        executor: "manual",
      })

      expect(gate.allowed).toBe(false)
      expect(gate.issues.some((i) => i.code === "blocked_by_dependency")).toBe(true)
    }),
  )

  it.effect("Build gate: allows target when dependency is verified", () =>
    Effect.gen(function* () {
      yield* seed()
      const plan = yield* GraphPlan.Service
      const build = yield* GraphBuild.Service
      const storage = yield* GraphStorage.Service

      yield* plan.admit({
        projectID,
        sessionID,
        nodes: [
          { id: "dep_b", type: "atomic", name: "Dependency", level: "L2", status: "verified" },
          { id: "tgt_b", type: "atomic", name: "Target", level: "L2" },
        ],
        edges: [
          { sourceID: "dep_b" as any, targetID: "tgt_b" as any, relation: "blocks" },
        ],
      })

      const currentPlan = yield* (yield* GraphDomain.Service).currentPlan({ sessionID })
      const targetID = currentPlan.nodes.find((n) => n.name === "Target")!.id

      const gate = yield* build.evaluate({
        projectID,
        sessionID,
        targetNodeID: targetID,
        executor: "manual",
      })

      expect(gate.allowed).toBe(true)
    }),
  )

  it.effect("Check phase: node status lifecycle pending → implemented → verified", () =>
    Effect.gen(function* () {
      yield* seed()
      const plan = yield* GraphPlan.Service
      const storage = yield* GraphStorage.Service

      yield* plan.admit({
        projectID,
        sessionID,
        nodes: [{ type: "atomic", name: "Game Logic", level: "L2" }],
        edges: [],
      })

      const currentPlan = yield* (yield* GraphDomain.Service).currentPlan({ sessionID })
      const nodeID = currentPlan.nodes[0].id

      expect((yield* storage.node.get(nodeID)).status).toBe("pending")

      yield* storage.node.update(nodeID, { status: "implemented", testStatus: "pending" })
      expect((yield* storage.node.get(nodeID)).status).toBe("implemented")

      yield* storage.node.update(nodeID, { testStatus: "passed", status: "verified" })
      const final = yield* storage.node.get(nodeID)
      expect(final.status).toBe("verified")
      expect(final.testStatus).toBe("passed")
    }),
  )

  it.effect("Audit trail: records all tool runs across the workflow", () =>
    Effect.gen(function* () {
      yield* seed()
      const audit = yield* GraphAudit.Service
      const plan = yield* GraphPlan.Service

      yield* plan.admit({
        projectID,
        sessionID,
        nodes: [{ type: "atomic", name: "Node A", level: "L2" }],
        edges: [],
      })

      const currentPlan = yield* (yield* GraphDomain.Service).currentPlan({ sessionID })
      const nodeID = currentPlan.nodes[0].id

      yield* audit.tool.record({
        projectID,
        sessionID,
        nodeID,
        toolName: "graph.artifact.apply",
        toolType: "artifact",
        status: "succeeded",
        inputSummary: "game.ts",
        outputSummary: "applied:1",
      })

      yield* audit.tool.record({
        projectID,
        sessionID,
        nodeID,
        toolName: "graph.diagnostics.run",
        toolType: "diagnostics",
        status: "succeeded",
        inputSummary: "bun test",
        outputSummary: "bun test:0",
      })

      const toolRuns = yield* audit.tool.list({ projectID, nodeID })
      expect(toolRuns.length).toBe(2)
      expect(toolRuns[0].toolType).toBe("artifact")
      expect(toolRuns[1].toolType).toBe("diagnostics")
    }),
  )

  it.effect("Promote: moves CurrentPlan into main graph", () =>
    Effect.gen(function* () {
      yield* seed()
      const plan = yield* GraphPlan.Service
      const domain = yield* GraphDomain.Service

      yield* plan.admit({
        projectID,
        sessionID,
        nodes: [{ type: "atomic", name: "Committed Node", level: "L2", status: "verified" }],
        edges: [],
      })

      const before = yield* domain.currentPlan({ sessionID })
      expect(before.nodes.length).toBe(1)

      const mainBefore = yield* domain.main({ projectID })
      expect(mainBefore.nodes.length).toBe(0)

      const result = yield* domain.promote({ projectID, sessionID, message: "Tic-Tac-Toe v1.0" })
      expect(result.nodes).toBe(1)

      const after = yield* domain.currentPlan({ sessionID })
      expect(after.nodes.length).toBe(0)

      const mainAfter = yield* domain.main({ projectID })
      expect(mainAfter.nodes.length).toBe(1)
      expect(mainAfter.nodes[0].name).toBe("Committed Node")
    }),
  )
})
