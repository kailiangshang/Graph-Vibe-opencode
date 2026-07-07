import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { GraphArtifactBeginTool } from "@/tool/graph/artifact-begin"
import { GraphArtifactChunkTool } from "@/tool/graph/artifact-chunk"
import { GraphArtifactSealTool } from "@/tool/graph/artifact-seal"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type PermissionRequest = Parameters<Tool.Context["ask"]>[0]
type MetadataUpdate = Parameters<Tool.Context["metadata"]>[0]

const projectID = ProjectV2.ID.make("proj_graph_artifact_stage")
const sessionID = SessionID.descending("ses_graph_artifact_stage")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      GraphStorage.node,
      GraphArtifactDraft.node,
      FSUtil.node,
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
          slug: "graph-artifact-stage",
          directory: AbsolutePath.make(directory),
          title: "graph artifact stage",
          version: "0.0.0-test",
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

function context(requests: PermissionRequest[] = [], updates: MetadataUpdate[] = []): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: (input) =>
      Effect.sync(() => {
        updates.push(input)
      }),
    ask: (input) =>
      Effect.sync(() => {
        requests.push(input)
      }),
  }
}

describe("graph artifact staging tools", () => {
  it.instance("begin, chunk, and seal normalized files without permission or worktree writes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const drafts = yield* GraphArtifactDraft.Service
      const fs = yield* FSUtil.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "StageMe",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const metadataUpdates: MetadataUpdate[] = []
      const toolContext = context(permissionRequests, metadataUpdates)
      const beginInfo = yield* GraphArtifactBeginTool
      const begin = yield* Tool.init(beginInfo)
      const chunkInfo = yield* GraphArtifactChunkTool
      const chunk = yield* Tool.init(chunkInfo)
      const sealInfo = yield* GraphArtifactSealTool
      const seal = yield* Tool.init(sealInfo)

      const beginResult = yield* begin.execute(
        {
          targetNodeID,
          test: "bun test src/a.test.ts src/b.test.ts\n",
          files: [
            { path: "./src\\a.ts", expectedChunks: 2 },
            { path: "src/b.ts", expectedChunks: 1 },
          ],
        },
        toolContext,
      )
      const beginOutput = JSON.parse(beginResult.output) as {
        readonly draftID: string
        readonly opened: boolean
        readonly status: string
        readonly files: ReadonlyArray<{ readonly path: string; readonly expectedChunks?: number }>
      }
      const draftID = GraphArtifactDraft.DraftID.make(beginOutput.draftID)

      expect(beginResult.title).toBe("Artifact draft opened")
      expect(beginOutput).toMatchObject({
        opened: true,
        status: "open",
        files: [
          { path: "src/a.ts", expectedChunks: 2 },
          { path: "src/b.ts", expectedChunks: 1 },
        ],
      })
      expect((yield* drafts.get(draftID)).files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])

      yield* chunk.execute({ draftID, path: "./src/a.ts", index: 0, content: "export " }, toolContext)
      yield* chunk.execute({ draftID, path: "src/a.ts", index: 1, content: "a = 1\n" }, toolContext)
      yield* chunk.execute({ draftID, path: "src/a.ts", index: 0, content: "export const " }, toolContext)
      yield* chunk.execute({ draftID, path: "src/b.ts", index: 0, content: "export const b = 2\n" }, toolContext)

      expect((yield* drafts.get(draftID)).files[0]?.chunks).toEqual([
        { index: 0, content: "export const " },
        { index: 1, content: "a = 1\n" },
      ])

      const sealResult = yield* seal.execute({ draftID }, toolContext)
      const sealOutput = JSON.parse(sealResult.output) as {
        readonly draftID: string
        readonly sealed: boolean
        readonly status: string
        readonly fileCount: number
        readonly files: ReadonlyArray<{ readonly path: string; readonly chunks: number; readonly bytes: number }>
      }
      const sealed = yield* drafts.get(draftID)

      expect(sealResult.title).toBe("Artifact draft sealed")
      expect(sealOutput).toMatchObject({
        draftID,
        sealed: true,
        status: "sealed",
        fileCount: 2,
        files: [
          { path: "src/a.ts", chunks: 2 },
          { path: "src/b.ts", chunks: 1 },
        ],
      })
      expect(sealed.artifact).toEqual({
        mode: "files",
        test: "bun test src/a.test.ts src/b.test.ts\n",
        files: [
          { path: "src/a.ts", code: "export const a = 1\n" },
          { path: "src/b.ts", code: "export const b = 2\n" },
        ],
      })
      expect(metadataUpdates.map((item) => item.metadata?.stage)).toEqual([
        "draft_opened",
        "chunk_stored",
        "chunk_stored",
        "chunk_stored",
        "chunk_stored",
        "sealed",
      ])
      expect(permissionRequests).toEqual([])
      expect(yield* fs.existsSafe(path.join(test.directory, "src/a.ts"))).toBe(false)
      expect(yield* fs.existsSafe(path.join(test.directory, "src/b.ts"))).toBe(false)
    }),
  )
})
