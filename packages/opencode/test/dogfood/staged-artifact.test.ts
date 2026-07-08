/**
 * End-to-end dogfood test for the full staged artifact workflow.
 *
 * Exercises every graph mode tool interface in sequence:
 *   Plan → Build Gate → Begin → Chunk → Seal → Apply
 *
 * No direct service calls for staging or apply — only real tool interfaces.
 */

import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
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
import { GraphArtifactBeginTool } from "@/tool/graph/artifact-begin"
import { GraphArtifactChunkTool } from "@/tool/graph/artifact-chunk"
import { GraphArtifactSealTool } from "@/tool/graph/artifact-seal"
import { GraphBuildGateTool } from "@/tool/graph/build-gate"
import { GraphPlanAdmitTool } from "@/tool/graph/plan-admit"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type PermissionRequest = Parameters<Tool.Context["ask"]>[0]
type MetadataUpdate = Parameters<Tool.Context["metadata"]>[0]

const projectID = ProjectV2.ID.make("proj_staged")
const sessionID = SessionID.descending("ses_staged")

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node, Session.node, GraphStorage.node, GraphDomain.node,
      GraphAudit.node, GraphPlan.node, GraphBuild.node,
      GraphArtifactDraft.node, FSUtil.node, EventV2Bridge.node,
      Truncate.node, Agent.node,
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
        id: sessionID, project_id: projectID, slug: "staged",
        directory: AbsolutePath.make(directory), title: "staged artifact",
        version: "0.0.0-test", time_created: 0, time_updated: 0,
      }).run().pipe(Effect.orDie)
    }),
  )
}

function context(requests: PermissionRequest[], updates: MetadataUpdate[]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: (input) =>
      Effect.sync(() => { updates.push(input) }),
    ask: (input) =>
      Effect.sync(() => { requests.push(input) }),
  }
}

describe("staged artifact end-to-end dogfood", () => {
  it.instance("full workflow: plan → gate → begin → chunk → seal → apply", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* seed(test.directory)

      const permissionRequests: PermissionRequest[] = []
      const metadataUpdates: MetadataUpdate[] = []
      const ctx = context(permissionRequests, metadataUpdates)

      // ── Plan: admit a 3-node hierarchy with @N index references ──
      const planAdmitInfo = yield* GraphPlanAdmitTool
      const planAdmit = yield* Tool.init(planAdmitInfo)
      const planResult = yield* planAdmit.execute(
        {
          nodes: [
            { type: "prd", name: "Staged Artifact PRD", level: "L1", desc: "Product requirements" },
            { type: "composite", name: "Module Group", level: "L1" },
            { type: "atomic", name: "Hello World Module", level: "L2" },
          ],
          edges: [
            { sourceID: "@0" as GraphStorage.NodeID, targetID: "@1" as GraphStorage.NodeID, relation: "contains" },
            { sourceID: "@1" as GraphStorage.NodeID, targetID: "@2" as GraphStorage.NodeID, relation: "contains" },
          ],
        },
        ctx,
      )
      const planOutput = JSON.parse(planResult.output)
      expect(planOutput.nodesCreated).toBe(3)
      expect(planOutput.edgesCreated).toBe(2)

      const domain = yield* GraphDomain.Service
      const cp = yield* domain.currentPlan({ sessionID })
      const targetNodeID = cp.nodes.find((n) => n.name === "Hello World Module")!.id

      // ── Build Gate: verify the target is allowed (no blockers) ──
      const gateInfo = yield* GraphBuildGateTool
      const gate = yield* Tool.init(gateInfo)
      const gateResult = yield* gate.execute({ targetNodeID }, ctx)
      expect(JSON.parse(gateResult.output).allowed).toBe(true)

      // ── Begin: open a draft with 2 files ──
      const beginInfo = yield* GraphArtifactBeginTool
      const begin = yield* Tool.init(beginInfo)
      const beginResult = yield* begin.execute(
        {
          targetNodeID,
          test: "bun test src/hello.test.ts src/world.test.ts\n",
          files: [
            { path: "src/hello.ts", expectedChunks: 2 },
            { path: "src/world.ts", expectedChunks: 1 },
          ],
        },
        ctx,
      )
      const beginOutput = JSON.parse(beginResult.output) as { readonly draftID: string }
      const draftID = beginOutput.draftID
      expect(beginResult.title).toBe("Artifact draft opened")

      // ── Chunk: send all chunks for both files ──
      const chunkInfo = yield* GraphArtifactChunkTool
      const chunk = yield* Tool.init(chunkInfo)
      yield* chunk.execute({ draftID, path: "src/hello.ts", index: 0, content: "export const " }, ctx)
      yield* chunk.execute({ draftID, path: "src/hello.ts", index: 1, content: "hello = 'world'\n" }, ctx)
      yield* chunk.execute({ draftID, path: "src/world.ts", index: 0, content: "export const world = 42\n" }, ctx)

      // ── Seal: finalize the draft ──
      const sealInfo = yield* GraphArtifactSealTool
      const seal = yield* Tool.init(sealInfo)
      const sealResult = yield* seal.execute({ draftID }, ctx)
      const sealOutput = JSON.parse(sealResult.output)
      expect(sealOutput.sealed).toBe(true)
      expect(sealOutput.fileCount).toBe(2)

      // ── Apply: write files through the sealed draft ──
      const applyInfo = yield* GraphArtifactApplyTool
      const apply = yield* Tool.init(applyInfo)
      const applyResult = yield* apply.execute({ targetNodeID, draftID }, ctx)
      const applyOutput = JSON.parse(applyResult.output)
      expect(applyOutput.applied).toBe(true)
      expect(applyOutput.files).toEqual(["src/hello.ts", "src/world.ts"])

      // ── Verify: permission asked exactly once ──
      expect(permissionRequests).toHaveLength(1)
      expect(permissionRequests[0]).toMatchObject({
        permission: "graph.artifact_write",
        patterns: ["src/hello.ts", "src/world.ts"],
      })

      // ── Verify: files written to disk ──
      const fs = yield* FSUtil.Service
      expect(yield* fs.readFileString(path.join(test.directory, "src/hello.ts"))).toBe("export const hello = 'world'\n")
      expect(yield* fs.readFileString(path.join(test.directory, "src/world.ts"))).toBe("export const world = 42\n")

      // ── Verify: node status implemented, testStatus pending ──
      const storage = yield* GraphStorage.Service
      const node = yield* storage.node.get(targetNodeID)
      expect(node.status).toBe("implemented")
      expect(node.testStatus).toBe("pending")

      // ── Verify: draft status applied ──
      const drafts = yield* GraphArtifactDraft.Service
      expect((yield* drafts.get(GraphArtifactDraft.DraftID.make(draftID))).status).toBe("applied")

      // ── Verify: metadata progress contains stage/files/fileCount ──
      const completed = metadataUpdates.at(-1)
      expect(completed?.metadata).toMatchObject({
        stage: "completed",
        applied: true,
        files: ["src/hello.ts", "src/world.ts"],
        fileCount: 2,
      })
    }),
  )
})
