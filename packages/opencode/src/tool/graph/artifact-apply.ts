import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { planArtifactApplication } from "@opencode-ai/core/graph/workflow/artifact"
import type { Artifact as CoreArtifact } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
import { buildableNodes } from "@opencode-ai/core/graph/build-order"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { Artifact } from "./build-gate"
import {
  blockedArtifactDraft,
  blockedArtifactPath,
  formatJson,
  isArtifactPathError,
  normalizeArtifactSafe,
  resolveArtifactPathsSafe,
  resolveGraphSession,
  summarizeGate,
} from "./util"

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact.pipe(Schema.optional),
  draftID: Schema.String.pipe(Schema.optional),
})

const MAX_DIRECT_ARTIFACT_BYTES = 64_000

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
    const drafts = yield* GraphArtifactDraft.Service

    return {
      description:
        "Apply a graph-approved artifact to the worktree after the Build gate and graph artifact validation pass.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.artifact !== undefined && params.draftID !== undefined)
            return blockedArtifactSource(params.draftID)
          if (params.artifact === undefined && params.draftID === undefined) return blockedArtifactSource(undefined)

          const session = yield* resolveGraphSession(ctx, sessions)
          const instance = yield* InstanceState.context
          if (params.artifact !== undefined) {
            const artifact = normalizeArtifactSafe(params.artifact, instance)
            if (isArtifactPathError(artifact)) return blockedArtifactPath(artifact)
            const paths = resolveArtifactPathsSafe(artifact, instance)
            if (isArtifactPathError(paths)) return blockedArtifactPath(paths)
            const inputBytes = artifactInputBytes(artifact)
            if (inputBytes > MAX_DIRECT_ARTIFACT_BYTES) return blockedDirectArtifactTooLarge(paths, inputBytes)
            return yield* applyArtifact({ artifact, inputBytes })
          }

          const requestedDraftID = params.draftID
          if (requestedDraftID === undefined) return blockedArtifactSource(undefined)
          const draftID = GraphArtifactDraft.DraftID.make(requestedDraftID)
          const draftResult = yield* drafts.get(draftID).pipe(
            Effect.map((draft) => ({ _tag: "found" as const, draft })),
            Effect.catchTag("GraphArtifactDraft.NotFoundError", (error) =>
              Effect.succeed({ _tag: "blocked" as const, error }),
            ),
          )
          if (draftResult._tag === "blocked") {
            return blockedArtifactDraft({
              reason: "draft_not_found",
              draftID,
              error: draftResult.error,
              repairHints: applyDraftRepairHints,
            })
          }
          const draft = draftResult.draft
          if (
            draft.projectID !== session.projectID ||
            draft.sessionID !== session.sessionID ||
            draft.nodeID !== params.targetNodeID
          ) {
            return blockedDraft("draft_mismatch", draftID)
          }
          if (draft.status !== "sealed" || draft.artifact === undefined)
            return blockedDraft("draft_not_sealed", draftID)

          const artifact = normalizeArtifactSafe(draft.artifact, instance)
          if (isArtifactPathError(artifact)) return blockedArtifactPath(artifact)
          return yield* applyArtifact({ artifact, draftID, inputBytes: artifactInputBytes(artifact) })

          function applyArtifact(source: ApplySource) {
            return Effect.gen(function* () {
              const paths = resolveArtifactPathsSafe(source.artifact, instance)
              if (isArtifactPathError(paths)) return blockedArtifactPath(paths)
              const files = paths.map((item) => item.relative)
              const progress = (
                stage: ArtifactApplyStage,
                progressInput?: { bytesPlanned?: number; bytesWritten?: number; currentFile?: string },
              ) =>
                ctx.metadata({
                  title: `Artifact apply: ${stage}`,
                  metadata: {
                    stage,
                    applied: stage === "completed",
                    files,
                    fileCount: files.length,
                    bytesPlanned: progressInput?.bytesPlanned ?? source.inputBytes,
                    bytesWritten: progressInput?.bytesWritten ?? 0,
                    ...(progressInput?.currentFile ? { currentFile: progressInput.currentFile } : {}),
                    ...draftMetadata(source.draftID),
                  },
                })

              yield* progress("preparing")
              const gate = yield* build.evaluate({
                projectID: session.projectID,
                sessionID: session.sessionID,
                targetNodeID: params.targetNodeID,
                artifact: source.artifact,
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
                const metadata: Record<string, unknown> = {
                  gate: summarizeGate(gate),
                  applied: false,
                  files: [] as string[],
                  buildable,
                  ...draftMetadata(source.draftID),
                }
                return {
                  title: "Artifact blocked",
                  metadata,
                  output: formatJson({ applied: false, gate, ...draftMetadata(source.draftID) }),
                }
              }

              yield* progress("reading")
              const existing = yield* Effect.forEach(paths, (item) =>
                Effect.gen(function* () {
                  const content = yield* fs.readFileStringSafe(item.absolute)
                  return { ...item, existed: content !== undefined, content: content ?? "" }
                }),
              )

              yield* progress("planning")
              const plan = planArtifactApplication(
                source.artifact,
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
                const metadata: Record<string, unknown> = {
                  gate: summarizeGate(gate),
                  applied: false,
                  files: [] as string[],
                  buildable: [] as string[],
                  ...draftMetadata(source.draftID),
                }
                return {
                  title: "Artifact blocked",
                  metadata,
                  output: formatJson({ applied: false, gate, artifact: plan, ...draftMetadata(source.draftID) }),
                }
              }

              const bytesPlanned = artifactPlannedBytes(plan.files, files)
              const plannedWrites = existing.map((item) => ({
                path: item.relative,
                existed: item.existed,
                bytes: byteLength(plan.files[item.relative] ?? ""),
              }))
              yield* progress("permission", { bytesPlanned })
              yield* ctx.ask({
                permission: "graph.artifact_write",
                patterns: files,
                always: ["*"],
                metadata: {
                  paths: files,
                  fileCount: files.length,
                  bytesPlanned,
                  plannedWrites,
                  ...draftMetadata(source.draftID),
                },
              })

              yield* Effect.forEach(existing, (item, index) =>
                Effect.gen(function* () {
                  const content = plan.files[item.relative]
                  if (content === undefined)
                    return yield* Effect.die(new Error(`Artifact did not produce ${item.relative}`))
                  yield* fs.writeWithDirs(item.absolute, content)
                  yield* events.publish(FileSystem.Event.Edited, { file: item.absolute })
                  yield* events.publish(Watcher.Event.Updated, {
                    file: item.absolute,
                    event: item.existed ? "change" : "add",
                  })
                  yield* progress("writing", {
                    bytesPlanned,
                    bytesWritten: artifactPlannedBytes(
                      plan.files,
                      existing.slice(0, index + 1).map((file) => file.relative),
                    ),
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
              if (source.draftID !== undefined) yield* drafts.markApplied(source.draftID)
              yield* progress("completed", completedProgress)
              const metadata: Record<string, unknown> = {
                gate: summarizeGate(gate),
                applied: true,
                files,
                buildable: [] as string[],
                stage: "completed",
                fileCount: files.length,
                ...draftMetadata(source.draftID),
                ...completedProgress,
              }

              return {
                title: "Artifact applied",
                metadata,
                output: formatJson({ applied: true, files, gate, ...draftMetadata(source.draftID) }),
              }
            })
          }
        }).pipe(Effect.orDie),
    }
  }),
)

interface ApplySource {
  readonly artifact: CoreArtifact
  readonly draftID?: GraphArtifactDraft.DraftID
  readonly inputBytes: number
}

function summarizePaths(paths: ReadonlyArray<{ readonly relative: string }>) {
  return `files=${paths.map((item) => item.relative).join(",")}`
}

function blockedArtifactSource(draftID: string | undefined) {
  const repairHints = [
    "Provide exactly one of artifact or draftID.",
    "Use artifact for small direct artifacts.",
    "Use graph_artifact_begin, graph_artifact_chunk, graph_artifact_seal, then graph_artifact_apply with draftID for large or multi-file artifacts.",
  ]
  const metadata: Record<string, unknown> = {
    applied: false,
    files: [] as string[],
    buildable: [] as string[],
    reason: "artifact_source_required",
    repairHints,
    ...(draftID === undefined ? {} : { draftID }),
  }
  return {
    title: "Artifact blocked",
    metadata,
    output: formatJson({
      applied: false,
      reason: "artifact_source_required",
      repairHints,
      ...(draftID === undefined ? {} : { draftID }),
    }),
  }
}

function blockedDirectArtifactTooLarge(paths: ReadonlyArray<{ readonly relative: string }>, inputBytes: number) {
  const files = paths.map((item) => item.relative)
  const repairHints = [
    "Use graph_artifact_begin, graph_artifact_chunk, graph_artifact_seal, then graph_artifact_apply with draftID.",
    "Split the graph node into smaller buildable nodes if the artifact is too large to review at once.",
  ]
  const metadata: Record<string, unknown> = {
    applied: false,
    files,
    fileCount: files.length,
    bytesPlanned: inputBytes,
    bytesWritten: 0,
    limitBytes: MAX_DIRECT_ARTIFACT_BYTES,
    reason: "artifact_too_large",
    repairHints,
  }
  return {
    title: "Artifact blocked",
    metadata,
    output: formatJson({
      applied: false,
      reason: "artifact_too_large",
      bytes: inputBytes,
      limitBytes: MAX_DIRECT_ARTIFACT_BYTES,
      repairHints,
    }),
  }
}

function blockedDraft(reason: string, draftID: GraphArtifactDraft.DraftID) {
  const repairHints = applyDraftRepairHints
  const metadata: Record<string, unknown> = {
    applied: false,
    files: [] as string[],
    buildable: [] as string[],
    draftID,
    reason,
    repairHints,
  }
  return {
    title: "Artifact blocked",
    metadata,
    output: formatJson({ applied: false, draftID, reason, repairHints }),
  }
}

function draftMetadata(draftID: GraphArtifactDraft.DraftID | undefined) {
  return draftID === undefined ? {} : { draftID }
}

const applyDraftRepairHints = [
  "Use a sealed draft from the current graph session and target node.",
  "Call graph_artifact_seal before applying a staged artifact.",
]

function artifactInputBytes(artifact: CoreArtifact) {
  if (artifact.mode === "full") return byteLength(artifact.code)
  if (artifact.mode === "files") return artifact.files.reduce((sum, file) => sum + byteLength(file.code), 0)
  return artifact.operations.reduce(
    (sum, operation) =>
      sum +
      byteLength(operation.path) +
      byteLength(operation.preimageHash) +
      byteLength(operation.old) +
      byteLength(operation.replacement),
    0,
  )
}

function artifactPlannedBytes(files: Readonly<Record<string, string>>, paths: ReadonlyArray<string>) {
  return paths.reduce((sum, file) => sum + byteLength(files[file] ?? ""), 0)
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}
