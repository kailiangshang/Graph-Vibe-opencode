/**
 * Graph Mode 开发流程完整演示
 *
 * 模拟 agent 在 OPENCODE_EXPERIMENTAL_GRAPH_MODE=1 下开发 Tic-Tac-Toe 的全流程：
 *
 *   Plan → Build Gate → Build (artifact) → Check (diagnostics) → Fix → Promote
 *
 * 每一步都标注了"验证什么"和"之前的问题是否已修复"。
 */

import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { GraphDiagnosticsRunTool } from "@/tool/graph/diagnostics-run"
import { Tool } from "@/tool/tool"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectDir = path.resolve(import.meta.dir, "../../../../examples/tic-tac-toe")
const projectID = ProjectV2.ID.make("proj_ttt")
const sessionID = SessionID.descending("ses_ttt")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node, Session.node, GraphStorage.node, GraphDomain.node,
      GraphAudit.node, GraphBuild.node, GraphPlan.node,
      CrossSpawnSpawner.node, EventV2Bridge.node, Truncate.node, Agent.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [Config.node, TestConfig.layer()],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ],
  ),
)

afterEach(async () => { await disposeAllInstances() })

function seed(directory: string) {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      yield* db.insert(ProjectTable).values({
        id: projectID, worktree: AbsolutePath.make(directory),
        vcs: "git", sandboxes: [], time_created: 0, time_updated: 0,
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: projectID, slug: "ttt",
        directory: AbsolutePath.make(directory), title: "Tic-Tac-Toe",
        version: "0", time_created: 0, time_updated: 0,
      }).run().pipe(Effect.orDie)
    }),
  )
}

function toolContext() {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } as Tool.Context
}

describe("graph mode 开发流程演示", () => {
  // ──────────────────────────────────────────────────────────────
  // 第一步：Plan — 用自然层级 + 索引引用创建计划
  // 验证 P1（边类型矩阵放宽）和 P2（索引引用）
  // ──────────────────────────────────────────────────────────────
  it.instance("① Plan: 用 contains 自然层级 + @N 索引引用创建完整计划", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service

      const result = yield* plan.admit({
        projectID,
        sessionID,
        nodes: [
          // @0 PRD — 产品需求
          { type: "prd", name: "Tic-Tac-Toe", level: "L1", desc: "CLI 井字棋" },
          // @1 Composite — 两大功能域
          { type: "composite", name: "Game Logic", level: "L1" },
          { type: "composite", name: "CLI Render", level: "L1" },
          // @3 Atomic — 具体任务
          { type: "atomic", name: "Board Model", level: "L2" },
          { type: "atomic", name: "Move Validator", level: "L2" },
          { type: "atomic", name: "Win Detector", level: "L2" },
          { type: "atomic", name: "Board Renderer", level: "L2" },
        ],
        edges: [
          // ✅ P1 验证：prd→composite 现在可以用 contains（之前被拒绝）
          { sourceID: "@0", targetID: "@1", relation: "contains" },
          { sourceID: "@0", targetID: "@2", relation: "contains" },
          // ✅ P1 验证：composite→atomic 现在可以用 contains（之前被拒绝）
          { sourceID: "@1", targetID: "@3", relation: "contains" },
          { sourceID: "@1", targetID: "@4", relation: "contains" },
          { sourceID: "@1", targetID: "@5", relation: "contains" },
          { sourceID: "@2", targetID: "@6", relation: "contains" },
          // 依赖：Validator 必须先于 Win Detector
          { sourceID: "@4", targetID: "@5", relation: "blocks" },
        ],
      })

      expect(result.nodesCreated).toBe(7)
      expect(result.edgesCreated).toBe(7)

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      expect(cp.nodes.length).toBe(7)
      expect(cp.edges.length).toBe(7)

      // 验证 contains 边确实存在
      const containsEdges = cp.edges.filter((e) => e.relation === "contains")
      expect(containsEdges.length).toBe(6)
      const blocksEdges = cp.edges.filter((e) => e.relation === "blocks")
      expect(blocksEdges.length).toBe(1)
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第二步：Build Gate — 验证依赖阻断
  // ──────────────────────────────────────────────────────────────
  it.instance("② Build Gate: blocks 边阻止跳序构建", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service
      const build = yield* GraphBuild.Service

      yield* plan.admit({
        projectID, sessionID,
        nodes: [
          { type: "atomic", name: "Dep", level: "L2" },
          { type: "atomic", name: "Target", level: "L2" },
        ],
        edges: [{ sourceID: "@0", targetID: "@1", relation: "blocks" }],
      })

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      const targetID = cp.nodes.find((n) => n.name === "Target")!.id

      const gate = yield* build.evaluate({
        projectID, sessionID, targetNodeID: targetID, executor: "manual",
      })

      expect(gate.allowed).toBe(false)
      expect(gate.issues.some((i) => i.code === "blocked_by_dependency")).toBe(true)
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第三步：Check — 模拟 artifact 应用后的状态流转
  // ──────────────────────────────────────────────────────────────
  it.instance("③ Check: artifact apply → implemented → diagnostics → verified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service
      const storage = yield* GraphStorage.Service

      yield* plan.admit({
        projectID, sessionID,
        nodes: [{ type: "atomic", name: "Board Model", level: "L2" }],
        edges: [],
      })

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      const nodeID = cp.nodes[0].id

      // 模拟 graph_artifact_apply 成功后的状态
      yield* storage.node.update(nodeID, { status: "implemented", testStatus: "pending" })
      expect((yield* storage.node.get(nodeID)).status).toBe("implemented")

      // 模拟 graph_diagnostics_run 通过后的状态
      yield* storage.node.update(nodeID, { status: "verified", testStatus: "passed" })
      const final = yield* storage.node.get(nodeID)
      expect(final.status).toBe("verified")
      expect(final.testStatus).toBe("passed")
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第四步：Diagnostics — 实际运行 tic-tac-toe 项目的测试
  // 验证 P8（timeout 参数）和 P9（filter 参数）
  // ──────────────────────────────────────────────────────────────
  it.instance("④ Diagnostics: 实际运行测试，timeout + filter 参数生效", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(projectDir)
      const plan = yield* GraphPlan.Service
      const storage = yield* GraphStorage.Service

      yield* plan.admit({
        projectID, sessionID,
        nodes: [{ type: "atomic", name: "Game Logic", level: "L2", status: "implemented" }],
        edges: [],
      })

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      const nodeID = cp.nodes[0].id

      // 初始化 diagnostics 工具
      const toolInfo = yield* GraphDiagnosticsRunTool
      const tool = yield* Tool.init(toolInfo)

      // 运行测试（实际执行 tic-tac-toe 的 bun test）
      const result = yield* tool.execute(
        { targetNodeID: nodeID, timeout: 30000, filter: "test" },
        toolContext(),
      )

      const parsed = JSON.parse(result.output)
      expect(parsed.ran).toBe(true)
      expect(parsed.passed).toBe(true)

      const node = yield* storage.node.get(nodeID)
      expect(node.status).toBe("implemented")
      expect(node.testStatus).not.toBe("passed")
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第五步：Fix Budget — 验证 P7（预算强制）
  // ──────────────────────────────────────────────────────────────
  it.instance("⑤ Fix Budget: 2 次诊断失败后阻止重试", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service
      const storage = yield* GraphStorage.Service
      const audit = yield* GraphAudit.Service

      yield* plan.admit({
        projectID, sessionID,
        nodes: [{ type: "atomic", name: "FailingNode", level: "L2", status: "implemented" }],
        edges: [],
      })

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      const nodeID = cp.nodes[0].id

      // 预填 2 次失败记录
      yield* audit.tool.record({ projectID, sessionID, nodeID, toolName: "graph.diagnostics.run", toolType: "diagnostics", status: "failed" })
      yield* audit.tool.record({ projectID, sessionID, nodeID, toolName: "graph.diagnostics.run", toolType: "diagnostics", status: "failed" })

      const toolInfo = yield* GraphDiagnosticsRunTool
      const tool = yield* Tool.init(toolInfo)

      const result = yield* tool.execute(
        { targetNodeID: nodeID },
        toolContext(),
      )

      const parsed = JSON.parse(result.output)
      expect(parsed.ran).toBe(false)
      expect(parsed.reason).toContain("previous failed diagnostics")
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第六步：Plan Correction — 验证 P4（节点/边删除）
  // ──────────────────────────────────────────────────────────────
  it.instance("⑥ Plan Correction: 删除错误节点并重新规划", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service
      const domain = yield* GraphDomain.Service

      // 初始计划（含一个错误节点）
      yield* plan.admit({
        projectID, sessionID,
        nodes: [
          { type: "atomic", name: "Correct Node", level: "L2" },
          { type: "atomic", name: "Wrong Node", level: "L2" },
        ],
        edges: [{ sourceID: "@0", targetID: "@1", relation: "blocks" }],
      })

      let cp = yield* domain.currentPlan({ sessionID })
      expect(cp.nodes.length).toBe(2)

      // 删除错误节点（P4 验证）
      const wrongID = cp.nodes.find((n) => n.name === "Wrong Node")!.id
      yield* domain.node.delete(wrongID)

      cp = yield* domain.currentPlan({ sessionID })
      expect(cp.nodes.length).toBe(1)
      expect(cp.nodes[0].name).toBe("Correct Node")
      // 级联删除边
      expect(cp.edges.length).toBe(0)
    }),
  )

  // ──────────────────────────────────────────────────────────────
  // 第七步：Promote — CurrentPlan → 主图
  // ──────────────────────────────────────────────────────────────
  it.instance("⑦ Promote: CurrentPlan 提升为主图，版本快照记录", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const plan = yield* GraphPlan.Service
      const domain = yield* GraphDomain.Service

      yield* plan.admit({
        projectID, sessionID,
        nodes: [
          { type: "prd", name: "Game", level: "L1", status: "verified" },
          { type: "atomic", name: "Logic", level: "L2", status: "verified" },
        ],
        edges: [{ sourceID: "@0", targetID: "@1", relation: "contains" }],
      })

      // promote 前
      expect((yield* domain.currentPlan({ sessionID })).nodes.length).toBe(2)
      expect((yield* domain.main({ projectID })).nodes.length).toBe(0)

      // promote
      const result = yield* domain.promote({ projectID, sessionID, message: "v1.0" })
      expect(result.nodes).toBe(2)
      expect(result.edges).toBe(1)

      // promote 后
      expect((yield* domain.currentPlan({ sessionID })).nodes.length).toBe(0)
      const main = yield* domain.main({ projectID })
      expect(main.nodes.length).toBe(2)

      // 版本快照
      const versions = yield* domain.version.list({ projectID })
      expect(versions.length).toBe(1)
      expect(versions[0].versionNumber).toBe(1)
    }),
  )
})
