import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { planArtifactApplication } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { buildableNodes } from "@opencode-ai/core/graph/build-order"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { Artifact } from "./build-gate"
import { formatJson, normalizeArtifact, resolveArtifactPaths, resolveGraphSession, summarizeGate } from "./util"

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact,
})

type ArtifactApplyStage =
  | "preparing"
  | "permission"
  | "reading"
  | "planning"
  | "writing"
  | "updating_graph"
  | "completed"

export const GraphArtifactApplyTool = Tool.define(
  "graph_artifact_apply",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const build = yield* GraphBuild.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const domain = yield* GraphDomain.Service

    return {
      description: "Apply a graph-approved artifact to the worktree after the Build gate and graph artifact validation pass.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const instance = yield* InstanceState.context
          const artifact = normalizeArtifact(params.artifact, instance)
          const paths = resolveArtifactPaths(artifact, instance)
          const files = paths.map((item) => item.relative)
          const inputBytes = artifactInputBytes(artifact)
          const progress = (stage: ArtifactApplyStage, input?: { bytesPlanned?: number; bytesWritten?: number; currentFile?: string }) =>
            ctx.metadata({
              title: `Artifact apply: ${stage}`,
              metadata: {
                stage,
                applied: stage === "completed",
                files,
                fileCount: files.length,
                bytesPlanned: input?.bytesPlanned ?? inputBytes,
                bytesWritten: input?.bytesWritten ?? 0,
                ...(input?.currentFile ? { currentFile: input.currentFile } : {}),
              },
            })

          yield* progress("preparing")
          const gate = yield* build.evaluate({
            projectID: session.projectID,
            sessionID: session.sessionID,
            targetNodeID: params.targetNodeID,
            artifact,
            executor: "manual",
          })

          if (!gate.allowed) {
            const cp = yield* domain.currentPlan({ sessionID: session.sessionID })
            const buildable = buildableNodes(cp.nodes, cp.edges).map((n) => n.name)
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
              metadata: { gate: summarizeGate(gate), applied: false, files: [] as string[], buildable },
              output: formatJson({ applied: false, gate }),
            }
          }

          yield* progress("permission")
          yield* ctx.ask({
            permission: "graph.artifact_write",
            patterns: files,
            always: ["*"],
            metadata: { paths: files },
          })

          yield* progress("reading")
          const existing = yield* Effect.forEach(paths, (item) =>
            Effect.gen(function* () {
              const content = yield* fs.readFileStringSafe(item.absolute)
              return { ...item, existed: content !== undefined, content: content ?? "" }
            }),
          )

          yield* progress("planning")
          const plan = planArtifactApplication(
            artifact,
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
              metadata: { gate: summarizeGate(gate), applied: false, files: [] as string[], buildable: [] as string[] },
              output: formatJson({ applied: false, gate, artifact: plan }),
            }
          }

          const bytesPlanned = artifactPlannedBytes(plan.files, files)
          yield* Effect.forEach(existing, (item, index) =>
            Effect.gen(function* () {
              const content = plan.files[item.relative]
              if (content === undefined) return yield* Effect.die(new Error(`Artifact did not produce ${item.relative}`))
              yield* fs.writeWithDirs(item.absolute, content)
              yield* events.publish(FileSystem.Event.Edited, { file: item.absolute })
              yield* events.publish(Watcher.Event.Updated, { file: item.absolute, event: item.existed ? "change" : "add" })
              yield* progress("writing", {
                bytesPlanned,
                bytesWritten: artifactPlannedBytes(plan.files, existing.slice(0, index + 1).map((file) => file.relative)),
                currentFile: item.relative,
              })
            }),
          )
          yield* progress("updating_graph", { bytesPlanned, bytesWritten: bytesPlanned })
          yield* storage.node.update(params.targetNodeID, { status: "implemented", testStatus: "pending" })
          const completedProgress = {
            bytesPlanned,
            bytesWritten: bytesPlanned,
            ...(files.length > 0 ? { currentFile: files[files.length - 1] } : {}),
          }
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
          yield* progress("completed", completedProgress)

          return {
            title: "Artifact applied",
            metadata: {
              gate: summarizeGate(gate),
              applied: true,
              files,
              buildable: [] as string[],
              stage: "completed",
              fileCount: files.length,
              ...completedProgress,
            },
            output: formatJson({ applied: true, files, gate }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function summarizePaths(paths: ReadonlyArray<{ readonly relative: string }>) {
  return `files=${paths.map((item) => item.relative).join(",")}`
}

function artifactInputBytes(artifact: typeof Artifact.Type) {
  if (artifact.mode === "full") return byteLength(artifact.code)
  if (artifact.mode === "files") return artifact.files.reduce((sum, file) => sum + byteLength(file.code), 0)
  return artifact.operations.reduce((sum, operation) => sum + byteLength(operation.replacement), 0)
}

function artifactPlannedBytes(files: Readonly<Record<string, string>>, paths: ReadonlyArray<string>) {
  return paths.reduce((sum, file) => sum + byteLength(files[file] ?? ""), 0)
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}
