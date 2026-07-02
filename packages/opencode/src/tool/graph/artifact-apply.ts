import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { planArtifactApplication } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { Artifact } from "./build-gate"
import { formatJson, resolveArtifactPaths, resolveGraphSession, summarizeGate } from "./util"

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact,
})

export const GraphArtifactApplyTool = Tool.define(
  "graph_artifact_apply",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const build = yield* GraphBuild.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: "Apply a graph-approved artifact to the worktree after the Build gate and graph artifact validation pass.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const instance = yield* InstanceState.context
          const paths = resolveArtifactPaths(params.artifact, instance)
          const gate = yield* build.evaluate({
            projectID: session.projectID,
            sessionID: session.sessionID,
            targetNodeID: params.targetNodeID,
            artifact: params.artifact,
            executor: "manual",
          })

          if (!gate.allowed) {
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.artifact.apply",
              toolType: "graph",
              status: "blocked",
              inputSummary: summarizePaths(paths),
              outputSummary: summarizeGate(gate),
            })
            return {
              title: "Artifact blocked",
              metadata: { gate: summarizeGate(gate), applied: false, files: [] },
              output: formatJson({ applied: false, gate }),
            }
          }

          yield* ctx.ask({
            permission: "graph.artifact_write",
            patterns: paths.map((item) => item.relative),
            always: ["*"],
            metadata: { paths: paths.map((item) => item.relative) },
          })

          const existing = yield* Effect.forEach(paths, (item) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileStringSafe(item.absolute)
              return { ...item, existed: content !== undefined, content: content ?? "" }
            }),
          )
          const plan = planArtifactApplication(
            params.artifact,
            Object.fromEntries(existing.map((item) => [item.relative, item.content])),
          )

          if (!plan.valid) {
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.artifact.apply",
              toolType: "graph",
              status: "blocked",
              inputSummary: summarizePaths(paths),
              outputSummary: `artifact:${plan.issues.length}`,
            })
            return {
              title: "Artifact blocked",
              metadata: { gate: summarizeGate(gate), applied: false, files: [] },
              output: formatJson({ applied: false, gate, artifact: plan }),
            }
          }

          yield* Effect.forEach(existing, (item) =>
            Effect.gen(function* () {
              const content = plan.files[item.relative]
              if (content === undefined) return yield* Effect.die(new Error(`Artifact did not produce ${item.relative}`))
              yield* fs.writeWithDirs(item.absolute, content)
              yield* events.publish(FileSystem.Event.Edited, { file: item.absolute })
              yield* events.publish(Watcher.Event.Updated, { file: item.absolute, event: item.existed ? "change" : "add" })
            }),
          )
          yield* storage.node.update(params.targetNodeID, { status: "implemented", testStatus: "pending" })
          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: params.targetNodeID,
            toolName: "graph.artifact.apply",
            toolType: "graph",
            status: "succeeded",
            inputSummary: summarizePaths(paths),
            outputSummary: `applied:${paths.length}`,
          })

          return {
            title: "Artifact applied",
            metadata: { gate: summarizeGate(gate), applied: true, files: paths.map((item) => item.relative) },
            output: formatJson({ applied: true, files: paths.map((item) => item.relative), gate }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function summarizePaths(paths: ReadonlyArray<{ readonly relative: string }>) {
  return `files=${paths.map((item) => item.relative).join(",")}`
}
