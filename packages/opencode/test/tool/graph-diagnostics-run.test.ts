import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
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
import { GraphDiagnosticsRunTool } from "@/tool/graph/diagnostics-run"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type PermissionRequest = Parameters<Tool.Context["ask"]>[0]

const projectID = ProjectV2.ID.make("proj_graph_diag")
const sessionID = SessionID.descending("ses_graph_diag")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      GraphStorage.node,
      GraphAudit.node,
      GraphBuild.node,
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

function seed(directory: string) {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make(directory),
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
          slug: "graph-diag",
          directory: AbsolutePath.make(directory),
          title: "graph diagnostics",
          version: "0.0.0-test",
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

function context(requests: PermissionRequest[] = []): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        requests.push(input)
      }),
  }
}

const init = Effect.fn("GraphDiagnosticsTest.init")(function* () {
  const info = yield* GraphDiagnosticsRunTool
  return yield* Tool.init(info)
})

describe("graph_diagnostics_run", () => {
  it.instance("does not ask permission or run commands when the Build gate blocks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        type: "atomic",
        name: "MainOnly",
        level: "L2",
      })

      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()

      const result = yield* tool.execute(
        { targetNodeID, commands: ["echo ok"] },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({ ran: false })
      expect(permissionRequests).toEqual([])
    }),
  )

  it.instance("runs passing diagnostics and promotes node to verified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "DiagMe",
        level: "L2",
        status: "implemented",
      })

      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()

      const result = yield* tool.execute(
        { targetNodeID, commands: ["true"] },
        context(permissionRequests),
      )

      const node = yield* storage.node.get(targetNodeID)
      expect(JSON.parse(result.output)).toMatchObject({ ran: true, passed: true })
      expect(permissionRequests).toMatchObject([{ permission: "graph.diagnostics_run" }])
      expect(node.testStatus).toBe("passed")
      expect(node.status).toBe("verified")
    }),
  )

  it.instance("records failed testStatus when a command exits non-zero", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "FailMe",
        level: "L2",
        status: "implemented",
      })

      const tool = yield* init()

      const result = yield* tool.execute(
        { targetNodeID, commands: ["false"] },
        context([]),
      )

      const node = yield* storage.node.get(targetNodeID)
      expect(JSON.parse(result.output)).toMatchObject({ ran: true, passed: false })
      expect(node.testStatus).toBe("failed")
      expect(node.status).toBe("implemented")
    }),
  )
})
