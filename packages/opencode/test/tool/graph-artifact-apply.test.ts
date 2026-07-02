import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
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
import { GraphArtifactApplyTool } from "@/tool/graph/artifact-apply"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type PermissionRequest = Parameters<Tool.Context["ask"]>[0]

const projectID = ProjectV2.ID.make("proj_graph_artifact")
const sessionID = SessionID.descending("ses_graph_artifact")

const it = testEffect(
  LayerNode.compile(LayerNode.group([
    Database.node,
    Session.node,
    GraphStorage.node,
    GraphAudit.node,
    GraphBuild.node,
    FSUtil.node,
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
          slug: "graph-artifact",
          directory: AbsolutePath.make(directory),
          title: "graph artifact",
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

const init = Effect.fn("GraphArtifactApplyTest.init")(function* () {
  const info = yield* GraphArtifactApplyTool
  return yield* Tool.init(info)
})

describe("graph_artifact_apply", () => {
  it.instance("does not ask permission or write when the Build gate blocks", () =>
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
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: { mode: "full", path: "src/blocked.ts", code: "export const blocked = true\n", test: "bun test\n" },
        },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({ gate: { allowed: false } })
      expect(permissionRequests).toEqual([])
      expect(yield* fs.existsSafe(path.join(test.directory, "src/blocked.ts"))).toBe(false)
    }),
  )

  it.instance("asks graph artifact permission, writes a full artifact, and marks the node implemented", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "BuildMe",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: { mode: "full", path: "./src/ok.ts", code: "export const ok = true\n", test: "bun test\n" },
        },
        context(permissionRequests),
      )

      const node = yield* storage.node.get(targetNodeID)
      expect(JSON.parse(result.output)).toMatchObject({ applied: true, files: ["src/ok.ts"] })
      expect(permissionRequests).toMatchObject([{ permission: "graph.artifact_write", patterns: ["src/ok.ts"] }])
      expect(yield* fs.readFileString(path.join(test.directory, "src/ok.ts"))).toBe("export const ok = true\n")
      expect(node.status).toBe("implemented")
      expect(node.testStatus).toBe("pending")
    }),
  )
})
