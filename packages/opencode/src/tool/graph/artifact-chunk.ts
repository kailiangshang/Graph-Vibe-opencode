import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import {
  blockedArtifactDraft,
  blockedArtifactPath,
  formatJson,
  isArtifactPathError,
  normalizeArtifactSafe,
  resolveGraphSession,
} from "./util"

export const Parameters = Schema.Struct({
  draftID: Schema.String,
  path: Schema.String,
  index: Schema.Number,
  content: Schema.String,
})

export const GraphArtifactChunkTool = Tool.define(
  "graph_artifact_chunk",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const drafts = yield* GraphArtifactDraft.Service

    return {
      description: "Store or replace one chunk in an open staged graph artifact draft without touching the worktree.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const instance = yield* InstanceState.context
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
          const path = normalizeDraftPath(params.path, instance)
          if (isArtifactPathError(path)) return blockedArtifactPath(path)
          const updatedResult = yield* drafts
            .putChunk({ id: draftID, path, index: params.index, content: params.content })
            .pipe(
              Effect.map((draft) => ({ _tag: "updated" as const, draft })),
              Effect.catchTags({
                "GraphArtifactDraft.NotFoundError": (error) =>
                  Effect.succeed({ _tag: "blocked" as const, reason: "draft_not_found", error }),
                "GraphArtifactDraft.ValidationError": (error) =>
                  Effect.succeed({ _tag: "blocked" as const, reason: error.rule, error }),
              }),
            )
          if (updatedResult._tag === "blocked") {
            return blockedArtifactDraft({ reason: updatedResult.reason, draftID, error: updatedResult.error })
          }
          const updated = updatedResult.draft
          const metadata: Record<string, unknown> = {
            stage: "chunk_stored",
            applied: false,
            draftID,
            status: updated.status,
            path,
            index: params.index,
            bytes: byteLength(params.content),
          }
          yield* ctx.metadata({ title: "Artifact chunk stored", metadata })
          return {
            title: "Artifact chunk stored",
            metadata,
            output: formatJson(metadata),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function normalizeDraftPath(input: string, instance: InstanceContext) {
  const artifact = normalizeArtifactSafe({ mode: "files", test: "x", files: [{ path: input, code: "x" }] }, instance)
  if (isArtifactPathError(artifact)) return artifact
  if (artifact.mode !== "files") throw new Error("expected files artifact")
  const file = artifact.files[0]
  if (!file) throw new Error("expected normalized file")
  return file.path
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}
