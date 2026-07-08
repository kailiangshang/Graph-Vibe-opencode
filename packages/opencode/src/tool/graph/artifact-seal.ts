import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { blockedArtifactDraft, formatJson, resolveGraphSession } from "./util"

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
          const draftResult = yield* drafts.get(draftID).pipe(
            Effect.map((draft) => ({ _tag: "found" as const, draft })),
            Effect.catchTag("GraphArtifactDraft.NotFoundError", (error) =>
              Effect.succeed({ _tag: "blocked" as const, error }),
            ),
          )
          if (draftResult._tag === "blocked") {
            return blockedArtifactDraft({ reason: "draft_not_found", draftID, error: draftResult.error })
          }
          const draft = draftResult.draft
          if (draft.projectID !== session.projectID || draft.sessionID !== session.sessionID) {
            return blockedArtifactDraft({ reason: "draft_session_mismatch", draftID })
          }
          const sealedResult = yield* drafts.seal(draftID).pipe(
            Effect.map((draft) => ({ _tag: "sealed" as const, draft })),
            Effect.catchTags({
              "GraphArtifactDraft.NotFoundError": (error) =>
                Effect.succeed({ _tag: "blocked" as const, reason: "draft_not_found", error }),
              "GraphArtifactDraft.ValidationError": (error) =>
                Effect.succeed({ _tag: "blocked" as const, reason: error.rule, error }),
            }),
          )
          if (sealedResult._tag === "blocked") {
            return blockedArtifactDraft({ reason: sealedResult.reason, draftID, error: sealedResult.error })
          }
          const sealed = sealedResult.draft
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

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}
