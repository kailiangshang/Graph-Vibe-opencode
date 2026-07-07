import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, normalizeArtifact, resolveGraphSession } from "./util"

export const DraftFile = Schema.Struct({
  path: Schema.String,
  expectedChunks: Schema.Number.pipe(Schema.optional),
  expectedSha256: Schema.String.pipe(Schema.optional),
})

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  test: Schema.String,
  files: Schema.Array(DraftFile),
})

export const GraphArtifactBeginTool = Tool.define(
  "graph_artifact_begin",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const drafts = yield* GraphArtifactDraft.Service

    return {
      description: "Begin a durable staged graph artifact draft for large or multi-file graph artifacts.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const instance = yield* InstanceState.context
          const files = normalizeDraftFiles(params.test, params.files, instance)
          const draftID = yield* drafts.create({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: params.targetNodeID,
            test: params.test,
            files,
          })
          const metadata: Record<string, unknown> = {
            stage: "draft_opened",
            opened: true,
            applied: false,
            draftID,
            targetNodeID: params.targetNodeID,
            status: "open",
            fileCount: files.length,
            files,
          }
          yield* ctx.metadata({ title: "Artifact draft opened", metadata })
          return {
            title: "Artifact draft opened",
            metadata,
            output: formatJson(metadata),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function normalizeDraftFiles(test: string, files: ReadonlyArray<typeof DraftFile.Type>, instance: InstanceContext) {
  const artifact = normalizeArtifact(
    { mode: "files", test, files: files.map((file) => ({ path: file.path, code: "x" })) },
    instance,
  )
  if (artifact.mode !== "files") throw new Error("expected files artifact")
  return artifact.files.map((file, index) => ({
    path: file.path,
    ...(files[index]?.expectedChunks === undefined ? {} : { expectedChunks: files[index].expectedChunks }),
    ...(files[index]?.expectedSha256 === undefined ? {} : { expectedSha256: files[index].expectedSha256 }),
  }))
}
