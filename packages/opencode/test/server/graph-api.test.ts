import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
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
  return HttpClientRequest.fromWeb(new Request(url)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
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
  const base = HttpClientRequest.fromWeb(new Request(url, { method })).pipe(
    HttpClientRequest.setUrl(url.pathname),
  )
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

describe("graph HttpApi", () => {
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
      }>(
        `/graph/node/${targetID}/readiness?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.inCurrentPlan).toBe(true)
      expect(result.blockers.length).toBe(1)
      expect(result.blockers[0].nodeID).toBe(sourceID)
      expect(result.blockers[0].nodeStatus).toBe("pending")
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
            { type: "atomic", name: "Plan A", level: "L2" },
            { type: "atomic", name: "Plan B", level: "L2" },
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

  it.instance("updates a node status and returns the refreshed node", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      yield* Session.use.create()

      const { project } = yield* (yield* Project.Service).fromDirectory(test.directory)

      const nodeID = yield* domain.node.create({
        projectID: project.id,
        type: "atomic" as const,
        name: "Status Node",
        level: "L2" as const,
      })

      const result = yield* sendJson<{ id: string; status: string }>(
        "PATCH",
        `/graph/node/${nodeID}/status?directory=${encodeURIComponent(test.directory)}`,
        { status: "implemented" },
      )

      expect(result.status).toBe(200)
      expect(result.json!.id).toBe(nodeID)
      expect(result.json!.status).toBe("implemented")
    }),
  )

  it.instance("returns 404 when updating status of an unknown node", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      yield* Project.use.fromDirectory(test.directory)
      yield* Session.use.create()

      const result = yield* sendJson(
        "PATCH",
        `/graph/node/node_unknown-missing/status?directory=${encodeURIComponent(test.directory)}`,
        { status: "implemented" },
      )

      expect(result.status).toBe(404)
    }),
  )

  it.instance("promotes the CurrentPlan into a versioned snapshot", () =>
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

      expect(result.status).toBe(200)
      expect(result.json!.versionID).toBeDefined()
      expect(result.json!.versionNumber).toBe(1)
      expect(result.json!.nodes).toBe(1)
      expect(result.json!.edges).toBe(0)
    }),
  )
})
