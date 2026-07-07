import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession, summarizeGate } from "./util"

export const FullArtifact = Schema.Struct({
  mode: Schema.Literal("full"),
  path: Schema.String,
  code: Schema.String,
  test: Schema.String,
})

export const PatchOperation = Schema.Struct({
  path: Schema.String,
  preimageHash: Schema.String,
  old: Schema.String,
  replacement: Schema.String,
})

export const PatchArtifact = Schema.Struct({
  mode: Schema.Literal("patch"),
  operations: Schema.Array(PatchOperation),
})

export const Artifact = Schema.Union([FullArtifact, PatchArtifact])

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact.pipe(Schema.optional),
  diagnosticsRequested: Schema.Boolean.pipe(Schema.optional),
  dryRun: Schema.Boolean.pipe(Schema.optional),
})

export const GraphBuildGateTool = Tool.define(
  "graph_build_gate",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const build = yield* GraphBuild.Service

    return {
      description: "Evaluate the graph Build gate for a CurrentPlan target before applying any artifact.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const result = yield* build.evaluate({
            projectID: session.projectID,
            sessionID: session.sessionID,
            targetNodeID: params.targetNodeID,
            artifact: params.artifact,
            diagnosticsRequested: params.diagnosticsRequested,
            dryRun: params.dryRun,
            executor: "manual",
          })
          return {
            title: result.allowed ? "Build gate allowed" : "Build gate blocked",
            metadata: { gate: summarizeGate(result) },
            output: formatJson(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
