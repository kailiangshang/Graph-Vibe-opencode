import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { hashContent } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
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
type MetadataUpdate = Parameters<Tool.Context["metadata"]>[0]

const projectID = ProjectV2.ID.make("proj_graph_artifact")
const sessionID = SessionID.descending("ses_graph_artifact")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      Session.node,
      GraphStorage.node,
      GraphDomain.node,
      GraphAudit.node,
      GraphArtifactDraft.node,
      GraphBuild.node,
      FSUtil.node,
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
      const metadataUpdates: MetadataUpdate[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service
      const code = "export const ok = '你好'\n"
      const codeBytes = new TextEncoder().encode(code).byteLength

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: { mode: "full", path: "./src/ok.ts", code, test: "bun test\n" },
        },
        context(permissionRequests, metadataUpdates),
      )

      const node = yield* storage.node.get(targetNodeID)
      expect(JSON.parse(result.output)).toMatchObject({ applied: true, files: ["src/ok.ts"] })
      expect(permissionRequests).toMatchObject([{ permission: "graph.artifact_write", patterns: ["src/ok.ts"] }])
      expect(metadataUpdates.map((item) => item.metadata?.stage)).toEqual([
        "preparing",
        "reading",
        "planning",
        "permission",
        "writing",
        "updating_graph",
        "completed",
      ])
      expect(permissionRequests[0]?.metadata).toMatchObject({
        paths: ["src/ok.ts"],
        bytesPlanned: codeBytes,
        plannedWrites: [{ path: "src/ok.ts", bytes: codeBytes, existed: false }],
      })
      expect(metadataUpdates.find((item) => item.metadata?.stage === "writing")?.metadata).toMatchObject({
        bytesPlanned: codeBytes,
        bytesWritten: codeBytes,
        currentFile: "src/ok.ts",
      })
      expect(metadataUpdates.at(-1)?.metadata).toMatchObject({
        applied: true,
        bytesPlanned: codeBytes,
        bytesWritten: codeBytes,
        currentFile: "src/ok.ts",
        fileCount: 1,
        files: ["src/ok.ts"],
        stage: "completed",
      })
      expect(result.metadata).toMatchObject({
        applied: true,
        bytesPlanned: codeBytes,
        bytesWritten: codeBytes,
        currentFile: "src/ok.ts",
        fileCount: 1,
        files: ["src/ok.ts"],
        stage: "completed",
      })
      expect(yield* fs.readFileString(path.join(test.directory, "src/ok.ts"))).toBe(code)
      expect(node.status).toBe("implemented")
      expect(node.testStatus).toBe("pending")
    }),
  )

  it.instance("writes a direct files artifact after one graph artifact permission request", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "BuildFiles",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: {
            mode: "files",
            test: "bun test src/a.test.ts src/b.test.ts\n",
            files: [
              { path: "./src/a.ts", code: "export const a = 1\n" },
              { path: "src/b.ts", code: "export const b = 2\n" },
            ],
          },
        },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({ applied: true, files: ["src/a.ts", "src/b.ts"] })
      expect(permissionRequests).toMatchObject([
        { permission: "graph.artifact_write", patterns: ["src/a.ts", "src/b.ts"] },
      ])
      expect(yield* fs.readFileString(path.join(test.directory, "src/a.ts"))).toBe("export const a = 1\n")
      expect(yield* fs.readFileString(path.join(test.directory, "src/b.ts"))).toBe("export const b = 2\n")
    }),
  )

  it.instance("blocks oversized direct artifacts without permission or worktree writes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "TooBig",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: {
            mode: "full",
            path: "src/too-big.ts",
            code: `export const value = "${"x".repeat(64_001)}"\n`,
            test: "bun test\n",
          },
        },
        context(permissionRequests),
      )

      expect(result.title).toBe("Artifact blocked")
      expect(JSON.parse(result.output)).toMatchObject({ applied: false, reason: "artifact_too_large" })
      expect(result.metadata).toMatchObject({ applied: false, reason: "artifact_too_large" })
      expect(permissionRequests).toEqual([])
      expect(yield* fs.existsSafe(path.join(test.directory, "src/too-big.ts"))).toBe(false)
    }),
  )

  it.instance("blocks oversized direct patch artifacts by counting old text before permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "TooBigPatch",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service
      const old = "x".repeat(64_001)
      yield* fs.writeWithDirs(path.join(test.directory, "src/too-big-patch.ts"), old)

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: {
            mode: "patch",
            operations: [
              {
                path: "src/too-big-patch.ts",
                preimageHash: hashContent(old),
                old,
                replacement: "export const patched = true\n",
              },
            ],
          },
        },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({ applied: false, reason: "artifact_too_large" })
      expect(result.metadata).toMatchObject({ applied: false, reason: "artifact_too_large" })
      expect(permissionRequests).toEqual([])
      expect(yield* fs.readFileString(path.join(test.directory, "src/too-big-patch.ts"))).toBe(old)
    }),
  )

  it.instance("blocks invalid patches before requesting artifact write permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "InvalidPatch",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service
      const file = path.join(test.directory, "src/invalid-patch.ts")
      const original = "export const value = 1\n"
      yield* fs.writeWithDirs(file, original)

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: {
            mode: "patch",
            operations: [
              {
                path: "src/invalid-patch.ts",
                preimageHash: hashContent("different content"),
                old: "value = 1",
                replacement: "value = 2",
              },
            ],
          },
        },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({
        applied: false,
        artifact: { valid: false, issues: [{ code: "preimage_hash_mismatch", path: "src/invalid-patch.ts" }] },
      })
      expect(permissionRequests).toEqual([])
      expect(yield* fs.readFileString(file)).toBe(original)
    }),
  )

  it.instance("returns blocked output for direct artifact paths escaping the worktree", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "PathEscape",
        level: "L2",
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()

      const result = yield* tool.execute(
        {
          targetNodeID,
          artifact: { mode: "full", path: "../escape.ts", code: "export const escape = true\n", test: "bun test\n" },
        },
        context(permissionRequests),
      )

      expect(JSON.parse(result.output)).toMatchObject({ applied: false, reason: "path_escape", path: "../escape.ts" })
      expect(result.metadata).toMatchObject({ applied: false, reason: "path_escape", path: "../escape.ts" })
      expect(permissionRequests).toEqual([])
    }),
  )

  it.instance("returns repairable blocked output unless exactly one of artifact or draftID is provided", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "ValidateInput",
        level: "L2",
      })
      const drafts = yield* GraphArtifactDraft.Service
      const draftID = yield* drafts.create({
        projectID,
        sessionID,
        nodeID: targetNodeID,
        test: "bun test\n",
        files: [{ path: "src/a.ts" }],
      })
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()

      const both = yield* tool.execute(
        {
          targetNodeID,
          draftID,
          artifact: { mode: "full", path: "src/a.ts", code: "export const a = 1\n", test: "bun test\n" },
        },
        context(permissionRequests),
      )
      const neither = yield* tool.execute({ targetNodeID }, context(permissionRequests))

      expect(JSON.parse(both.output)).toMatchObject({ applied: false, reason: "artifact_source_required" })
      expect(JSON.parse(neither.output)).toMatchObject({ applied: false, reason: "artifact_source_required" })
      expect(permissionRequests).toEqual([])
    }),
  )

  it.instance("loads a sealed draft, writes files, updates the graph, and marks the draft applied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const drafts = yield* GraphArtifactDraft.Service
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "ApplyDraft",
        level: "L2",
      })
      const draftID = yield* drafts.create({
        projectID,
        sessionID,
        nodeID: targetNodeID,
        test: "bun test src/a.test.ts src/b.test.ts\n",
        files: [{ path: "src/a.ts", expectedChunks: 2 }, { path: "src/b.ts" }],
      })
      yield* drafts.putChunk({ id: draftID, path: "src/a.ts", index: 0, content: "export const " })
      yield* drafts.putChunk({ id: draftID, path: "src/a.ts", index: 1, content: "a = 1\n" })
      yield* drafts.putChunk({ id: draftID, path: "src/b.ts", index: 0, content: "export const b = 2\n" })
      yield* drafts.seal(draftID)
      const permissionRequests: PermissionRequest[] = []
      const metadataUpdates: MetadataUpdate[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute({ targetNodeID, draftID }, context(permissionRequests, metadataUpdates))

      const node = yield* storage.node.get(targetNodeID)
      expect(JSON.parse(result.output)).toMatchObject({ applied: true, draftID, files: ["src/a.ts", "src/b.ts"] })
      expect(result.metadata).toMatchObject({ applied: true, draftID, files: ["src/a.ts", "src/b.ts"], fileCount: 2 })
      expect(metadataUpdates.at(-1)?.metadata).toMatchObject({ applied: true, draftID, stage: "completed" })
      expect(permissionRequests).toMatchObject([
        { permission: "graph.artifact_write", patterns: ["src/a.ts", "src/b.ts"] },
      ])
      expect(yield* fs.readFileString(path.join(test.directory, "src/a.ts"))).toBe("export const a = 1\n")
      expect(yield* fs.readFileString(path.join(test.directory, "src/b.ts"))).toBe("export const b = 2\n")
      expect(node.status).toBe("implemented")
      expect(node.testStatus).toBe("pending")
      expect((yield* drafts.get(draftID)).status).toBe("applied")
    }),
  )

  it.instance("keeps a sealed draft untouched when the Build gate blocks staged apply", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)
      const storage = yield* GraphStorage.Service
      const drafts = yield* GraphArtifactDraft.Service
      const blockerNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "Blocker",
        level: "L2",
      })
      const targetNodeID = yield* storage.node.create({
        projectID,
        sessionID,
        type: "atomic",
        name: "BlockedDraft",
        level: "L2",
      })
      yield* storage.edge.create({
        projectID,
        sessionID,
        sourceID: blockerNodeID,
        targetID: targetNodeID,
        relation: "blocks",
      })
      const draftID = yield* drafts.create({
        projectID,
        sessionID,
        nodeID: targetNodeID,
        test: "bun test\n",
        files: [{ path: "src/blocked.ts" }],
      })
      yield* drafts.putChunk({
        id: draftID,
        path: "src/blocked.ts",
        index: 0,
        content: "export const blocked = true\n",
      })
      yield* drafts.seal(draftID)
      const permissionRequests: PermissionRequest[] = []
      const tool = yield* init()
      const fs = yield* FSUtil.Service

      const result = yield* tool.execute({ targetNodeID, draftID }, context(permissionRequests))

      expect(JSON.parse(result.output)).toMatchObject({ applied: false, gate: { allowed: false } })
      expect(result.metadata).toMatchObject({ applied: false, draftID })
      expect(permissionRequests).toEqual([])
      expect(yield* fs.existsSafe(path.join(test.directory, "src/blocked.ts"))).toBe(false)
      expect((yield* drafts.get(draftID)).status).toBe("sealed")
    }),
  )
})
