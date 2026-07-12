import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { GraphWorkflowState } from "@opencode-ai/core/graph/workflow/state"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { Workspace } from "@/control-plane/workspace"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { waitGlobalBusEvent } from "./global-bus"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    GraphStorage.node,
    GraphDomain.node,
    GraphAudit.node,
    GraphPlan.node,
    GraphBuild.node,
    GraphWorkflowState.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url)).pipe(HttpClientRequest.setUrl(url.pathname), HttpClient.execute)
}

function requestJson<T>(path: string) {
  return Effect.gen(function* () {
    const response = yield* request(path)
    if (response.status !== 200) {
      const text = yield* response.text
      return yield* Effect.die(new Error(`Expected 200, got ${response.status}: ${text}`))
    }
    return yield* response.json.pipe(Effect.map((v) => v as T))
  })
}

function send(method: "POST" | "PATCH", path: string, body?: unknown) {
  const url = new URL(path, "http://localhost")
  const base = HttpClientRequest.fromWeb(new Request(url, { method })).pipe(HttpClientRequest.setUrl(url.pathname))
  const withBody = body === undefined ? base : base.pipe(HttpClientRequest.setBody(HttpBody.jsonUnsafe(body)))
  return withBody.pipe(HttpClient.execute)
}

function sendJson<T = unknown>(method: "POST" | "PATCH", path: string, body?: unknown) {
  return Effect.gen(function* () {
    const response = yield* send(method, path, body)
    if (response.status !== 200) return { status: response.status, json: null as T | null }
    const json = yield* response.json
    return { status: response.status, json: json as T }
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

interface GraphViewResponse {
  nodes: Array<{ id: string; name: string; type: string; status: string; sessionID: string | null }>
  edges: Array<{ id: string; sourceID: string; targetID: string; relation: string }>
}

const verification = { criteria: ["observable result"], diagnostics: [{ name: "test" }] }

describe("graph HttpApi", () => {
  it.instance("publishes plan invalidation after workflow mode mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Event task", level: "L2", verification }], edges: [] },
      )
      const before = yield* requestJson<{ revision: number }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      const event = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === "graph.plan.updated",
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      const selected = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "atomic", expectedRevision: before.revision },
      )
      expect(selected.status).toBe(200)
      expect((yield* Fiber.join(event)).payload.type).toBe("graph.plan.updated")
    }),
  )
  it.instance("publishes plan invalidation after workflow pause and approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Checkpoint task", level: "L2", verification }], edges: [] },
      )
      const initial = yield* requestJson<{ revision: number }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      const selected = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "atomic", expectedRevision: initial.revision },
      )

      const pauseEvent = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === "graph.plan.updated",
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      const paused = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/pause?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { expectedRevision: selected.json?.revision ?? -1, reason: "Review changes" },
      )
      expect(paused.status).toBe(200)
      expect((yield* Fiber.join(pauseEvent)).payload.type).toBe("graph.plan.updated")

      const approvalEvent = yield* waitGlobalBusEvent({
        predicate: (item) => item.payload.type === "graph.plan.updated",
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      const approved = yield* sendJson(
        "PATCH",
        `/graph/workflow/approve?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { expectedRevision: paused.json?.revision ?? -1 },
      )
      expect(approved.status).toBe(200)
      expect((yield* Fiber.join(approvalEvent)).payload.type).toBe("graph.plan.updated")
    }),
  )
  it.instance("returns main graph for the project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      yield* domain.node.create({
        projectID: project.id,
        type: "prd" as const,
        name: "Root PRD",
        level: "L1" as const,
      })

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/main?directory=${encodeURIComponent(test.directory)}`,
      )

      expect(result.nodes.length).toBeGreaterThanOrEqual(1)
      const mainNode = result.nodes.find((n) => n.name === "Root PRD")
      expect(mainNode).toBeDefined()
      expect(mainNode!.sessionID).toBeNull()
    }),
  )

  it.instance("returns CurrentPlan for a session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      yield* domain.node.create({
        projectID: project.id,
        sessionID: session.id,
        type: "composite" as const,
        name: "Plan Node A",
        level: "L1" as const,
      })

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/current-plan?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0].name).toBe("Plan Node A")
      expect(result.nodes[0].sessionID).toBe(session.id)
    }),
  )

  it.instance("returns empty CurrentPlan when session has no plan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/current-plan?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.nodes).toEqual([])
      expect(result.edges).toEqual([])
    }),
  )

  it.instance("returns node detail by ID", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      const nodeID = yield* domain.node.create({
        projectID: project.id,
        type: "atomic" as const,
        name: "Detail Node",
        level: "L2" as const,
        category: "func",
      })

      const result = yield* requestJson<{ id: string; name: string; type: string }>(
        `/graph/node/${nodeID}?directory=${encodeURIComponent(test.directory)}`,
      )

      expect(result.id).toBe(nodeID)
      expect(result.name).toBe("Detail Node")
      expect(result.type).toBe("atomic")
    }),
  )

  it.instance("returns node readiness with blockers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      const sourceID = yield* domain.node.create({
        projectID: project.id,
        sessionID: session.id,
        type: "atomic" as const,
        name: "Dependency",
        level: "L2" as const,
      })
      const targetID = yield* domain.node.create({
        projectID: project.id,
        sessionID: session.id,
        type: "atomic" as const,
        name: "Target",
        level: "L2" as const,
      })
      yield* domain.edge.create({
        projectID: project.id,
        sessionID: session.id,
        sourceID,
        targetID,
        relation: "blocks" as const,
      })

      const result = yield* requestJson<{
        nodeID: string
        inCurrentPlan: boolean
        blockers: Array<{ nodeID: string; nodeStatus: string }>
      }>(`/graph/node/${targetID}/readiness?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)

      expect(result.inCurrentPlan).toBe(true)
      expect(result.blockers.length).toBe(1)
      expect(result.blockers[0].nodeID).toBe(sourceID)
      expect(result.blockers[0].nodeStatus).toBe("pending")

      yield* domain.node.update(sourceID, { status: "implemented" })
      const implemented = yield* requestJson<{
        blockers: Array<{ nodeID: string; nodeName: string; nodeStatus: string }>
      }>(`/graph/node/${targetID}/readiness?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)
      expect(implemented.blockers).toEqual([{ nodeID: sourceID, nodeName: "Dependency", nodeStatus: "implemented" }])
    }),
  )

  it.instance("returns bounded audit summaries and evidence through audit and workflow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      const domain = yield* GraphDomain.Service
      const nodeID = yield* domain.node.create({
        projectID: session.projectID,
        sessionID: session.id,
        type: "atomic",
        name: "Persisted task",
        level: "L2",
      })
      const audit = yield* GraphAudit.Service
      yield* audit.tool.record({
        projectID: session.projectID,
        sessionID: session.id,
        nodeID,
        toolName: "graph.diagnostics.run",
        toolType: "diagnostics",
        status: "failed",
        inputSummary: "i".repeat(4_000),
        outputSummary: "o".repeat(4_000),
        error: "e".repeat(4_000),
        evidence: {
          kind: "diagnostics",
          nodeID,
          criteria: ["observable"],
          artifactPaths: ["src/a.ts"],
          projectChecksOnly: true,
          complete: false,
          passed: false,
          commands: [
            {
              name: "test",
              command: "bun run test",
              exitCode: 1,
              timedOut: false,
              passed: false,
              excerpt: `sk-supersecret123 access_token=token-secret-value ${"x".repeat(20_000)}`,
            },
          ],
        },
      })

      const nodeAudit = yield* requestJson<{
        toolRuns: Array<{
          inputSummary: string | null
          outputSummary: string | null
          error: string | null
          evidence: { commands: Array<{ excerpt?: string }> } | null
        }>
      }>(`/graph/node/${nodeID}/audit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)
      const workflow = yield* requestJson<{
        tasks: Array<{ latestEvidence: { projectChecksOnly: boolean; commands: Array<{ excerpt?: string }> } | null }>
      }>(`/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)

      expect(nodeAudit.toolRuns[0]?.inputSummary?.length).toBeLessThanOrEqual(1_024)
      expect(nodeAudit.toolRuns[0]?.outputSummary?.length).toBeLessThanOrEqual(1_024)
      expect(nodeAudit.toolRuns[0]?.error?.length).toBeLessThanOrEqual(1_024)
      expect(nodeAudit.toolRuns[0]?.evidence?.commands[0]?.excerpt?.length).toBeLessThanOrEqual(8_192)
      expect(workflow.tasks[0]?.latestEvidence?.projectChecksOnly).toBe(true)
      expect(workflow.tasks[0]?.latestEvidence?.commands[0]?.excerpt?.length).toBeLessThanOrEqual(8_192)
      expect(JSON.stringify(nodeAudit)).not.toContain("sk-supersecret123")
      expect(JSON.stringify(workflow)).not.toContain("sk-supersecret123")
      expect(JSON.stringify(nodeAudit)).not.toContain("token-secret-value")
      expect(JSON.stringify(workflow)).not.toContain("token-secret-value")
    }),
  )

  it.instance("admits nodes and edges into the CurrentPlan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const result = yield* sendJson<{ nodesCreated: number; edgesCreated: number; dryRun: boolean }>(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            { type: "atomic", name: "Plan A", level: "L2", verification },
            { type: "atomic", name: "Plan B", level: "L2", verification },
          ],
          edges: [{ sourceID: "@0", targetID: "@1", relation: "blocks" }],
        },
      )

      expect(result.status).toBe(200)
      expect(result.json!.nodesCreated).toBe(2)
      expect(result.json!.edgesCreated).toBe(1)
      expect(result.json!.dryRun).toBe(false)
    }),
  )

  it.instance("ignores supplied plan status fields when admitting nodes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const result = yield* sendJson<{ nodesCreated: number }>(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            {
              type: "atomic",
              name: "Plan Status",
              level: "L2",
              verification,
              status: "verified",
              testStatus: "passed",
            },
          ],
          edges: [],
        },
      )
      const current = yield* requestJson<{ nodes: Array<{ status: string; testStatus: string }> }>(
        `/graph/current-plan?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.status).toBe(200)
      expect(current.nodes[0]?.status).toBe("pending")
      expect(current.nodes[0]?.testStatus).toBe("none")
    }),
  )

  it.instance("rejects an invalid plan admit payload with 400", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const result = yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", level: "L2" }], edges: [] },
      )

      expect(result.status).toBe(400)
    }),
  )

  it.instance("maps ambiguous module plan admission to 400", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({
        sessionID: session.id,
        projectID: session.projectID,
        mode: "module",
        expectedRevision: 0,
      })

      const response = yield* send(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            { id: "module-a", type: "composite", name: "Module A", level: "L1" },
            { id: "module-b", type: "composite", name: "Module B", level: "L1" },
            { id: "task", type: "atomic", name: "Task", level: "L2", verification },
          ],
          edges: [
            { sourceID: "module-a", targetID: "task", relation: "contains" },
            { sourceID: "module-b", targetID: "task", relation: "contains" },
          ],
        },
      )

      expect(response.status).toBe(400)
    }),
  )

  it.instance("selects workflow mode with an exact revision and unblocks the first task", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      expect(
        (yield* sendJson(
          "POST",
          `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
          { nodes: [{ type: "atomic", name: "First Task", level: "L2", verification }], edges: [] },
        )).status,
      ).toBe(200)

      const before = yield* requestJson<{
        mode: string | null
        revision: number
        currentTask: { id: string } | null
      }>(`/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)
      expect(before.mode).toBeNull()
      expect(before.currentTask).not.toBeNull()
      const build = yield* GraphBuild.Service
      expect(
        (yield* build.evaluate({
          projectID: session.projectID,
          sessionID: session.id,
          targetNodeID: before.currentTask!.id as GraphStorage.NodeID,
          executor: "manual",
        })).allowed,
      ).toBe(false)

      const selected = yield* sendJson<{ mode: string; revision: number; checkpoint: { status: string } }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "atomic", expectedRevision: before.revision },
      )
      expect(selected.status).toBe(200)
      expect(selected.json).toMatchObject({
        mode: "atomic",
        revision: before.revision + 1,
        checkpoint: { status: "approved" },
      })
      expect(
        (yield* build.evaluate({
          projectID: session.projectID,
          sessionID: session.id,
          targetNodeID: before.currentTask!.id as GraphStorage.NodeID,
          executor: "manual",
        })).allowed,
      ).toBe(true)
    }),
  )

  it.instance("returns a typed conflict for stale workflow mode revision", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "First Task", level: "L2", verification }], edges: [] },
      )
      const workflow = yield* requestJson<{ revision: number }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      expect(
        (yield* sendJson(
          "PATCH",
          `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
          { mode: "atomic", expectedRevision: workflow.revision },
        )).status,
      ).toBe(200)

      const response = yield* send(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "autopilot", expectedRevision: workflow.revision },
      )
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({
        _tag: "GraphWorkflowRevisionConflict",
        expectedRevision: workflow.revision,
        actualRevision: workflow.revision + 1,
      })
    }),
  )

  it.instance("approves an atomic checkpoint idempotently and continues to the next task", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            { type: "atomic", name: "Atomic A", level: "L2", verification },
            { type: "atomic", name: "Atomic B", level: "L2", verification },
          ],
          edges: [{ sourceID: "@0", targetID: "@1", relation: "blocks" }],
        },
      )
      const before = yield* requestJson<{ revision: number; currentTask: { id: string } }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      const selected = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "atomic", expectedRevision: before.revision },
      )
      if (!selected.json) return yield* Effect.die(new Error("Expected workflow mode projection"))
      const workflow = yield* GraphWorkflowState.Service
      const advanced = yield* workflow.completeVerification({
        projectID: session.projectID,
        sessionID: session.id,
        nodeID: before.currentTask.id as GraphStorage.NodeID,
        expectedRevision: selected.json.revision,
        evidence: {
          kind: "diagnostics",
          nodeID: before.currentTask.id,
          criteria: [],
          artifactPaths: [],
          projectChecksOnly: true,
          complete: true,
          passed: true,
          commands: [],
        },
      })
      expect(advanced.checkpointStatus).toBe("pending")

      const approved = yield* sendJson<{
        revision: number
        checkpoint: { status: string }
        currentTask: { id: string }
      }>("PATCH", `/graph/workflow/approve?directory=${encodeURIComponent(test.directory)}&session=${session.id}`, {
        expectedRevision: advanced.revision,
      })
      const retried = yield* sendJson<{
        revision: number
        checkpoint: { status: string }
        currentTask: { id: string }
      }>("PATCH", `/graph/workflow/approve?directory=${encodeURIComponent(test.directory)}&session=${session.id}`, {
        expectedRevision: advanced.revision,
      })
      expect(approved.status).toBe(200)
      expect(approved.json).toMatchObject({ revision: advanced.revision + 1, checkpoint: { status: "approved" } })
      expect(retried).toEqual(approved)
      if (!approved.json) return yield* Effect.die(new Error("Expected approved workflow projection"))
      const build = yield* GraphBuild.Service
      expect(
        (yield* build.evaluate({
          projectID: session.projectID,
          sessionID: session.id,
          targetNodeID: approved.json.currentTask.id as GraphStorage.NodeID,
          executor: "manual",
        })).allowed,
      ).toBe(true)

      const stale = yield* send(
        "PATCH",
        `/graph/workflow/approve?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { expectedRevision: advanced.revision - 1 },
      )
      expect(stale.status).toBe(409)
      expect(yield* stale.json).toMatchObject({ _tag: "GraphWorkflowRevisionConflict" })
    }),
  )

  it.instance("approves a module boundary and continues in the next module", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            { type: "composite", name: "Module A", level: "L1" },
            { type: "composite", name: "Module B", level: "L1" },
            { type: "atomic", name: "Task A", level: "L2", verification },
            { type: "atomic", name: "Task B", level: "L2", verification },
          ],
          edges: [
            { sourceID: "@0", targetID: "@2", relation: "contains" },
            { sourceID: "@1", targetID: "@3", relation: "contains" },
            { sourceID: "@2", targetID: "@3", relation: "blocks" },
          ],
        },
      )
      const before = yield* requestJson<{ revision: number; currentTask: { id: string } }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      const selected = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "module", expectedRevision: before.revision },
      )
      if (!selected.json) return yield* Effect.die(new Error("Expected workflow mode projection"))
      const workflow = yield* GraphWorkflowState.Service
      const advanced = yield* workflow.completeVerification({
        projectID: session.projectID,
        sessionID: session.id,
        nodeID: before.currentTask.id as GraphStorage.NodeID,
        expectedRevision: selected.json.revision,
        evidence: {
          kind: "diagnostics",
          nodeID: before.currentTask.id,
          criteria: [],
          artifactPaths: [],
          projectChecksOnly: true,
          complete: true,
          passed: true,
          commands: [],
        },
      })
      expect(advanced).toMatchObject({ checkpointKind: "module", checkpointStatus: "pending" })

      const approved = yield* sendJson<{ checkpoint: { status: string }; currentTask: { id: string } }>(
        "PATCH",
        `/graph/workflow/approve?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { expectedRevision: advanced.revision },
      )
      expect(approved.status).toBe(200)
      expect(approved.json?.checkpoint.status).toBe("approved")
      if (!approved.json) return yield* Effect.die(new Error("Expected approved workflow projection"))
      const build = yield* GraphBuild.Service
      expect(
        (yield* build.evaluate({
          projectID: session.projectID,
          sessionID: session.id,
          targetNodeID: approved.json.currentTask.id as GraphStorage.NodeID,
          executor: "manual",
        })).allowed,
      ).toBe(true)
    }),
  )

  it.instance("pauses with an exact revision and rejects stale pause retries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Pause Task", level: "L2", verification }], edges: [] },
      )
      const before = yield* requestJson<{ revision: number }>(
        `/graph/workflow?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )
      const selected = yield* sendJson<{ revision: number }>(
        "PATCH",
        `/graph/workflow/mode?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { mode: "autopilot", expectedRevision: before.revision },
      )
      if (!selected.json) return yield* Effect.die(new Error("Expected workflow mode projection"))
      const paused = yield* sendJson<{
        revision: number
        checkpoint: { status: string; kind: string; reason: string }
      }>("PATCH", `/graph/workflow/pause?directory=${encodeURIComponent(test.directory)}&session=${session.id}`, {
        expectedRevision: selected.json.revision,
        reason: "user review",
      })
      expect(paused.status).toBe(200)
      expect(paused.json).toMatchObject({
        revision: selected.json.revision + 1,
        checkpoint: { status: "pending", kind: "pause", reason: "user review" },
      })

      const stale = yield* send(
        "PATCH",
        `/graph/workflow/pause?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { expectedRevision: selected.json.revision },
      )
      expect(stale.status).toBe(409)
      expect(yield* stale.json).toMatchObject({ _tag: "GraphWorkflowRevisionConflict" })
    }),
  )

  it.instance("does not expose status mutation for the current workflow task", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Current Task", level: "L2", verification }], edges: [] },
      )
      const storage = yield* GraphStorage.Service
      const task = (yield* storage.currentPlan({ sessionID: session.id })).nodes[0]

      yield* send("PATCH", `/graph/node/${task.id}/status?directory=${encodeURIComponent(test.directory)}`, {
        status: "deprecated",
      })
      expect((yield* storage.node.get(task.id)).status).toBe("pending")
    }),
  )

  it.instance("does not expose status mutation for a verified workflow dependency", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        {
          nodes: [
            { type: "atomic", name: "Dependency", level: "L2", verification },
            { type: "atomic", name: "Target", level: "L2", verification },
          ],
          edges: [{ sourceID: "@0", targetID: "@1", relation: "blocks" }],
        },
      )
      const storage = yield* GraphStorage.Service
      const dependency = (yield* storage.currentPlan({ sessionID: session.id })).nodes.find(
        (node) => node.name === "Dependency",
      )
      if (!dependency) return yield* Effect.die(new Error("Expected workflow dependency"))
      yield* storage.node.update(dependency.id, { status: "verified", testStatus: "passed" })

      yield* send("PATCH", `/graph/node/${dependency.id}/status?directory=${encodeURIComponent(test.directory)}`, {
        status: "pending",
      })
      expect((yield* storage.node.get(dependency.id)).status).toBe("verified")
    }),
  )

  it.instance("does not expose status mutation for Main graph nodes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service
      yield* Project.use.fromDirectory(test.directory)
      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)
      const nodeID = yield* domain.node.create({
        projectID: project.id,
        type: "atomic",
        name: "Main Node",
        level: "L2",
      })

      yield* send("PATCH", `/graph/node/${nodeID}/status?directory=${encodeURIComponent(test.directory)}`, {
        status: "deprecated",
      })
      expect((yield* domain.node.get(nodeID)).status).toBe("pending")
    }),
  )

  it.instance("rejects promotion of an incomplete CurrentPlan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      yield* domain.node.create({
        projectID: project.id,
        sessionID: session.id,
        type: "atomic" as const,
        name: "Promote Node",
        level: "L2" as const,
      })

      const result = yield* sendJson<{ versionID: string; versionNumber: number; nodes: number; edges: number }>(
        "POST",
        `/graph/current-plan/promote?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { message: "initial promote" },
      )

      expect(result.status).toBe(400)
    }),
  )

  it.instance("rejects promotion while a checkpoint is pending", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Paused Task", level: "L2", verification }], edges: [] },
      )
      const workflow = yield* GraphWorkflowState.Service
      const planned = yield* workflow.get(session.id)
      const selected = yield* workflow.setMode({
        projectID: session.projectID,
        sessionID: session.id,
        mode: "atomic",
        expectedRevision: planned!.revision,
      })
      yield* workflow.pause({ sessionID: session.id, expectedRevision: selected.revision })

      expect(
        (yield* sendJson(
          "POST",
          `/graph/current-plan/promote?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
          {},
        )).status,
      ).toBe(400)
    }),
  )

  it.instance("promotes a completed workflow into a versioned snapshot", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()
      yield* sendJson(
        "POST",
        `/graph/plan/admit?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { nodes: [{ type: "atomic", name: "Done Task", level: "L2", verification }], edges: [] },
      )
      const storage = yield* GraphStorage.Service
      const task = (yield* storage.currentPlan({ sessionID: session.id })).nodes[0]
      const workflow = yield* GraphWorkflowState.Service
      const planned = yield* workflow.get(session.id)
      const selected = yield* workflow.setMode({
        projectID: session.projectID,
        sessionID: session.id,
        mode: "autopilot",
        expectedRevision: planned!.revision,
      })
      yield* workflow.completeVerification({
        projectID: session.projectID,
        sessionID: session.id,
        nodeID: task.id,
        expectedRevision: selected.revision,
        evidence: {
          kind: "diagnostics",
          nodeID: task.id,
          criteria: [],
          artifactPaths: [],
          projectChecksOnly: true,
          complete: true,
          passed: true,
          commands: [],
        },
      })

      const result = yield* sendJson<{ versionNumber: number; nodes: number }>(
        "POST",
        `/graph/current-plan/promote?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
        { message: "completed" },
      )
      expect(result.status).toBe(200)
      expect(result.json).toMatchObject({ versionNumber: 1, nodes: 1 })
    }),
  )
})
