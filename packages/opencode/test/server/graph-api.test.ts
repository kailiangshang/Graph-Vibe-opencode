import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
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
    GraphDomain.node,
    GraphAudit.node,
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
})
