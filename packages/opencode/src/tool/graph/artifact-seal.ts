import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession } from "./util"

export const Parameters = Schema.Struct({
  draftID: Schema.String,
})

export const GraphArtifactSealTool = Tool.define(
  "graph_artifact_seal",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const drafts = yield* GraphArtifactDraft.Service

    return {
      description:
        "Seal an open staged graph artifact draft and return assembled file metadata for review before apply.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const draftID = GraphArtifactDraft.DraftID.make(params.draftID)
          const draft = yield* drafts.get(draftID)
          if (draft.projectID !== session.projectID || draft.sessionID !== session.sessionID) {
            return blockedDraft("draft_session_mismatch", draftID)
          }
          const sealed = yield* drafts.seal(draftID)
          const files = sealed.artifact.files.map((file) => ({
            path: file.path,
            chunks: sealed.files.find((stored) => stored.path === file.path)?.chunks.length ?? 0,
            bytes: byteLength(file.code),
          }))
          const metadata: Record<string, unknown> = {
            stage: "sealed",
            sealed: true,
            applied: false,
            draftID,
            status: sealed.status,
            fileCount: files.length,
            bytes: files.reduce((sum, file) => sum + file.bytes, 0),
            files,
          }
          yield* ctx.metadata({ title: "Artifact draft sealed", metadata })
          return {
            title: "Artifact draft sealed",
            metadata,
            output: formatJson(metadata),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function blockedDraft(reason: string, draftID: GraphArtifactDraft.DraftID) {
  const repairHints = ["Use the draft from the current graph session."]
  const metadata: Record<string, unknown> = { stage: "blocked", applied: false, draftID, reason, repairHints }
  return {
    title: "Artifact draft blocked",
    metadata,
    output: formatJson({ applied: false, draftID, reason, repairHints }),
  }
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}
