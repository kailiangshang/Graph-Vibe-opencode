import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, normalizeArtifact, resolveGraphSession } from "./util"

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
          const draft = yield* drafts.get(draftID)
          if (draft.projectID !== session.projectID || draft.sessionID !== session.sessionID) {
            return blockedDraft("draft_session_mismatch", draftID)
          }
          const path = normalizeDraftPath(params.path, instance)
          const updated = yield* drafts.putChunk({ id: draftID, path, index: params.index, content: params.content })
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
  const artifact = normalizeArtifact({ mode: "files", test: "x", files: [{ path: input, code: "x" }] }, instance)
  if (artifact.mode !== "files") throw new Error("expected files artifact")
  const file = artifact.files[0]
  if (!file) throw new Error("expected normalized file")
  return file.path
}

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
