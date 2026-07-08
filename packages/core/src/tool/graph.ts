export * as GraphTools from "./graph"

import { ToolFailure } from "@opencode-ai/llm"
import { Graph } from "@opencode-ai/schema/graph"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Schema } from "effect"
import { realpathSync } from "node:fs"
import path from "node:path"
import { EventV2 } from "../event"
import { FileSystem } from "../filesystem"
import { Watcher } from "../filesystem/watcher"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { buildableNodes, topologicalOrder } from "../graph/build-order"
import { GraphDomain } from "../graph/domain"
import { GraphStorage } from "../graph/storage"
import { GraphArtifact } from "../graph/workflow/artifact"
import { GraphArtifactDraft } from "../graph/workflow/artifact-draft"
import { GraphAudit } from "../graph/workflow/audit"
import { GraphBuild } from "../graph/workflow/build"
import type { GateResult } from "../graph/workflow/gate"
import { GraphPlan } from "../graph/workflow/plan"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import { ProjectV2 } from "../project"
import { SessionStore } from "../session/store"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const PlanNode = Schema.Struct({
  id: GraphStorage.NodeID.pipe(Schema.optional),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Graph.Priority.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  desc: Schema.String.pipe(Schema.optional),
  content: Graph.NodeContent.pipe(Schema.optional),
  codeHash: Schema.String.pipe(Schema.optional),
  confidence: Schema.Number.pipe(Schema.optional),
})

const PlanEdge = Schema.Struct({
  id: GraphStorage.EdgeID.pipe(Schema.optional),
  sourceID: GraphStorage.NodeID,
  targetID: GraphStorage.NodeID,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number.pipe(Schema.optional),
})

const PlanAdmitInput = Schema.Struct({
  dryRun: Schema.Boolean.pipe(Schema.optional),
  nodes: Schema.Array(PlanNode),
  edges: Schema.Array(PlanEdge),
})

const FullArtifact = Schema.Struct({
  mode: Schema.Literal("full"),
  path: Schema.String,
  code: Schema.String,
  test: Schema.String,
})

const FilesArtifactFile = Schema.Struct({
  path: Schema.String,
  code: Schema.String,
})

const FilesArtifact = Schema.Struct({
  mode: Schema.Literal("files"),
  files: Schema.Array(FilesArtifactFile),
  test: Schema.String,
})

const PatchOperation = Schema.Struct({
  path: Schema.String,
  preimageHash: Schema.String,
  old: Schema.String,
  replacement: Schema.String,
})

const PatchArtifact = Schema.Struct({
  mode: Schema.Literal("patch"),
  operations: Schema.Array(PatchOperation),
})

const Artifact = Schema.Union([FullArtifact, FilesArtifact, PatchArtifact])

const BuildGateInput = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact.pipe(Schema.optional),
  diagnosticsRequested: Schema.Boolean.pipe(Schema.optional),
  dryRun: Schema.Boolean.pipe(Schema.optional),
})

const DraftFile = Schema.Struct({
  path: Schema.String,
  expectedChunks: Schema.Number.pipe(Schema.optional),
  expectedSha256: Schema.String.pipe(Schema.optional),
})

const ArtifactBeginInput = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  test: Schema.String,
  files: Schema.Array(DraftFile),
})

const ArtifactChunkInput = Schema.Struct({
  draftID: Schema.String,
  path: Schema.String,
  index: Schema.Number,
  content: Schema.String,
})

const ArtifactSealInput = Schema.Struct({
  draftID: Schema.String,
})

const ArtifactApplyInput = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  artifact: Artifact.pipe(Schema.optional),
  draftID: Schema.String.pipe(Schema.optional),
})

const DiagnosticsRunInput = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  timeout: Schema.Number.pipe(Schema.optional),
  filter: Schema.String.pipe(Schema.optional),
})

const GraphToolOutput = Schema.Struct({
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  output: Schema.String,
})

type ArtifactPath = {
  readonly relative: string
  readonly absolute: string
}

type ArtifactPathError = {
  readonly _tag: "ArtifactPathError"
  readonly reason: "absolute_path" | "path_escape"
  readonly path: string
  readonly message: string
}

type GraphSession = {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly directory: string
}

type CommandResult = {
  readonly name: string
  readonly command: string
  readonly exitCode: number | null
  readonly output: string
  readonly timedOut: boolean
  readonly passed: boolean
  readonly failureReason?: string
}

type NamedCommand = {
  readonly name: string
  readonly command: string
}

type ApplySource = {
  readonly artifact: GraphArtifact.Artifact
  readonly draftID?: GraphArtifactDraft.DraftID
  readonly inputBytes: number
}

const MAX_DIRECT_ARTIFACT_BYTES = 64_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_FIX_ATTEMPTS = 2
const MAX_OUTPUT_CHARS = 64_000

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!Flag.OPENCODE_EXPERIMENTAL_GRAPH_MODE) return
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const plan = yield* GraphPlan.Service
    const build = yield* GraphBuild.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const domain = yield* GraphDomain.Service
    const drafts = yield* GraphArtifactDraft.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const permission = yield* PermissionV2.Service
    const processes = yield* AppProcess.Service

    const graphSession = (context: Tool.Context) => resolveGraphSession(context, sessions, location)
    const source = (context: Tool.Context) => ({
      type: "tool" as const,
      messageID: context.assistantMessageID,
      callID: context.toolCallID,
    })

    yield* tools
      .register({
        graph_plan_admit: Tool.make({
          description: "Admit nodes and edges into the session CurrentPlan graph before implementation.",
          input: PlanAdmitInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const admission = yield* plan
                .admit({
                  projectID: session.projectID,
                  sessionID: session.sessionID,
                  dryRun: input.dryRun,
                  nodes: input.nodes.map(planNodeInput),
                  edges: input.edges,
                })
                .pipe(
                  Effect.map((result) => ({ _tag: "admitted" as const, result })),
                  Effect.catchTag("GraphV2.ValidationError", (error) =>
                    Effect.succeed({ _tag: "rejected" as const, error }),
                  ),
                )

              if (admission._tag === "rejected") {
                const metadata = planAdmissionRejection(admission.error, input)
                yield* audit.tool.record({
                  projectID: session.projectID,
                  sessionID: session.sessionID,
                  toolName: "graph.plan.admit",
                  toolType: "graph",
                  status: "failed",
                  inputSummary: `nodes=${input.nodes.length} edges=${input.edges.length}`,
                  outputSummary: `${admission.error.rule}: ${admission.error.message}`,
                })
                return toolOutput("CurrentPlan rejected", metadata)
              }

              const result = admission.result
              yield* audit.tool.record({
                projectID: session.projectID,
                sessionID: session.sessionID,
                toolName: "graph.plan.admit",
                toolType: "graph",
                status: input.dryRun ? "dry_run" : "succeeded",
                inputSummary: `nodes=${input.nodes.length} edges=${input.edges.length}`,
                outputSummary: `nodes=${result.nodesCreated} edges=${result.edgesCreated}`,
              })
              if (!input.dryRun) yield* events.publish(Graph.Event.PlanUpdated, { projectID: session.projectID })
              const currentPlan = input.dryRun ? undefined : yield* domain.currentPlan({ sessionID: session.sessionID })
              const suggestedOrder = currentPlan
                ? topologicalOrder(currentPlan.nodes, currentPlan.edges).map(
                    (node, index) => `${index + 1}. ${node.name} [${node.status}]`,
                  )
                : []
              return toolOutput(
                input.dryRun ? "CurrentPlan dry-run" : "CurrentPlan admitted",
                planAdmissionSuccess(result, suggestedOrder, input),
                result,
              )
            }).pipe(toToolFailure),
        }),
        graph_build_gate: Tool.make({
          description: "Evaluate the graph Build gate for a CurrentPlan target before applying any artifact.",
          input: BuildGateInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const result = yield* build.evaluate({
                projectID: session.projectID,
                sessionID: session.sessionID,
                targetNodeID: input.targetNodeID,
                artifact: input.artifact,
                diagnosticsRequested: input.diagnosticsRequested,
                dryRun: input.dryRun,
                executor: "manual",
              })
              return toolOutput(result.allowed ? "Build gate allowed" : "Build gate blocked", { gate: summarizeGate(result) }, result)
            }).pipe(toToolFailure),
        }),
        graph_artifact_begin: Tool.make({
          description: "Begin a durable staged graph artifact draft for large or multi-file graph artifacts.",
          input: ArtifactBeginInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const files = normalizeDraftFiles(input.test, input.files, session.directory)
              if (isArtifactPathError(files)) return blockedArtifactPath(files)
              const result = yield* drafts
                .create({
                  projectID: session.projectID,
                  sessionID: session.sessionID,
                  nodeID: input.targetNodeID,
                  test: input.test,
                  files,
                })
                .pipe(
                  Effect.map((draftID) => ({ _tag: "created" as const, draftID })),
                  Effect.catchTag("GraphArtifactDraft.ValidationError", (error) =>
                    Effect.succeed({ _tag: "blocked" as const, error }),
                  ),
                )
              if (result._tag === "blocked") return blockedArtifactDraft({ reason: result.error.rule, error: result.error })
              return toolOutput("Artifact draft opened", {
                stage: "draft_opened",
                opened: true,
                applied: false,
                draftID: result.draftID,
                targetNodeID: input.targetNodeID,
                status: "open",
                fileCount: files.length,
                files,
              })
            }).pipe(toToolFailure),
        }),
        graph_artifact_chunk: Tool.make({
          description: "Store or replace one chunk in an open staged graph artifact draft without touching the worktree.",
          input: ArtifactChunkInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const draftID = GraphArtifactDraft.DraftID.make(input.draftID)
              const draft = yield* getDraft(drafts, draftID)
              if (draft._tag === "blocked") return blockedArtifactDraft({ reason: "draft_not_found", draftID, error: draft.error })
              if (draft.draft.projectID !== session.projectID || draft.draft.sessionID !== session.sessionID) {
                return blockedArtifactDraft({ reason: "draft_session_mismatch", draftID })
              }
              const filePath = normalizeDraftPath(input.path, session.directory)
              if (isArtifactPathError(filePath)) return blockedArtifactPath(filePath)
              const updated = yield* drafts
                .putChunk({ id: draftID, path: filePath, index: input.index, content: input.content })
                .pipe(
                  Effect.map((draft) => ({ _tag: "updated" as const, draft })),
                  Effect.catchTags({
                    "GraphArtifactDraft.NotFoundError": (error) =>
                      Effect.succeed({ _tag: "blocked" as const, reason: "draft_not_found", error }),
                    "GraphArtifactDraft.ValidationError": (error) =>
                      Effect.succeed({ _tag: "blocked" as const, reason: error.rule, error }),
                  }),
                )
              if (updated._tag === "blocked") {
                return blockedArtifactDraft({ reason: updated.reason, draftID, error: updated.error })
              }
              return toolOutput("Artifact chunk stored", {
                stage: "chunk_stored",
                applied: false,
                draftID,
                status: updated.draft.status,
                path: filePath,
                index: input.index,
                bytes: byteLength(input.content),
              })
            }).pipe(toToolFailure),
        }),
        graph_artifact_seal: Tool.make({
          description: "Seal an open staged graph artifact draft and return assembled file metadata for review before apply.",
          input: ArtifactSealInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const draftID = GraphArtifactDraft.DraftID.make(input.draftID)
              const draft = yield* getDraft(drafts, draftID)
              if (draft._tag === "blocked") return blockedArtifactDraft({ reason: "draft_not_found", draftID, error: draft.error })
              if (draft.draft.projectID !== session.projectID || draft.draft.sessionID !== session.sessionID) {
                return blockedArtifactDraft({ reason: "draft_session_mismatch", draftID })
              }
              const sealed = yield* drafts.seal(draftID).pipe(
                Effect.map((draft) => ({ _tag: "sealed" as const, draft })),
                Effect.catchTags({
                  "GraphArtifactDraft.NotFoundError": (error) =>
                    Effect.succeed({ _tag: "blocked" as const, reason: "draft_not_found", error }),
                  "GraphArtifactDraft.ValidationError": (error) =>
                    Effect.succeed({ _tag: "blocked" as const, reason: error.rule, error }),
                }),
              )
              if (sealed._tag === "blocked") {
                return blockedArtifactDraft({ reason: sealed.reason, draftID, error: sealed.error })
              }
              const files = sealed.draft.artifact.files.map((file) => ({
                path: file.path,
                chunks: sealed.draft.files.find((stored) => stored.path === file.path)?.chunks.length ?? 0,
                bytes: byteLength(file.code),
              }))
              return toolOutput("Artifact draft sealed", {
                stage: "sealed",
                sealed: true,
                applied: false,
                draftID,
                status: sealed.draft.status,
                fileCount: files.length,
                bytes: files.reduce((sum, file) => sum + file.bytes, 0),
                files,
              })
            }).pipe(toToolFailure),
        }),
        graph_artifact_apply: Tool.make({
          description:
            "Apply a graph-approved artifact to the worktree after the Build gate and graph artifact validation pass.",
          input: ArtifactApplyInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              if (input.artifact !== undefined && input.draftID !== undefined) return blockedArtifactSource(input.draftID)
              if (input.artifact === undefined && input.draftID === undefined) return blockedArtifactSource(undefined)
              if (input.artifact !== undefined) {
                const artifact = normalizeArtifactSafe(input.artifact, session.directory)
                if (isArtifactPathError(artifact)) return blockedArtifactPath(artifact)
                const paths = resolveArtifactPathsSafe(artifact, session.directory)
                if (isArtifactPathError(paths)) return blockedArtifactPath(paths)
                const inputBytes = artifactInputBytes(artifact)
                if (inputBytes > MAX_DIRECT_ARTIFACT_BYTES) return blockedDirectArtifactTooLarge(paths, inputBytes)
                return yield* applyArtifact({ artifact, inputBytes }, input, context, session)
              }
              const requestedDraftID = input.draftID
              if (requestedDraftID === undefined) return blockedArtifactSource(undefined)
              const draftID = GraphArtifactDraft.DraftID.make(requestedDraftID)
              const draft = yield* getDraft(drafts, draftID)
              if (draft._tag === "blocked") {
                return blockedArtifactDraft({
                  reason: "draft_not_found",
                  draftID,
                  error: draft.error,
                  repairHints: applyDraftRepairHints,
                })
              }
              if (
                draft.draft.projectID !== session.projectID ||
                draft.draft.sessionID !== session.sessionID ||
                draft.draft.nodeID !== input.targetNodeID
              ) {
                return blockedDraft("draft_mismatch", draftID)
              }
              if (draft.draft.status !== "sealed" || draft.draft.artifact === undefined) {
                return blockedDraft("draft_not_sealed", draftID)
              }
              const artifact = normalizeArtifactSafe(draft.draft.artifact, session.directory)
              if (isArtifactPathError(artifact)) return blockedArtifactPath(artifact)
              return yield* applyArtifact({ artifact, draftID, inputBytes: artifactInputBytes(artifact) }, input, context, session)
            }).pipe(toToolFailure),
        }),
        graph_diagnostics_run: Tool.make({
          description:
            "Run project diagnostics (tests, type checks, lint) for a graph node after artifact application. Updates node test status and promotes to verified on success. Optional 'filter' selects auto-detected commands by name (e.g. 'test', 'typecheck'). Optional 'timeout' sets per-command timeout in milliseconds.",
          input: DiagnosticsRunInput,
          output: GraphToolOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* graphSession(context)
              const gate = yield* build.evaluate({
                projectID: session.projectID,
                sessionID: session.sessionID,
                targetNodeID: input.targetNodeID,
                diagnosticsRequested: true,
                executor: "manual",
              })
              if (!gate.allowed) {
                yield* audit.tool.record({
                  projectID: session.projectID,
                  sessionID: session.sessionID,
                  nodeID: input.targetNodeID,
                  toolName: "graph.diagnostics.run",
                  toolType: "diagnostics",
                  status: "blocked",
                  outputSummary: summarizeGate(gate),
                })
                return toolOutput("Diagnostics blocked", { gate: summarizeGate(gate), ran: false, passed: false, results: [] }, { ran: false, gate })
              }
              const previousFailures = yield* audit.tool.list({
                projectID: session.projectID,
                nodeID: input.targetNodeID,
              })
              const failedDiagCount = previousFailures.filter(
                (record) => record.toolName === "graph.diagnostics.run" && record.status === "failed",
              ).length
              if (failedDiagCount >= MAX_FIX_ATTEMPTS) {
                yield* audit.tool.record({
                  projectID: session.projectID,
                  sessionID: session.sessionID,
                  nodeID: input.targetNodeID,
                  toolName: "graph.diagnostics.run",
                  toolType: "diagnostics",
                  status: "blocked",
                  outputSummary: `budget_exhausted:${failedDiagCount}`,
                })
                return toolOutput(
                  "Diagnostics blocked - fix budget exhausted",
                  { gate: summarizeGate(gate), ran: false, passed: false, results: [] },
                  {
                    ran: false,
                    reason: `Node has ${failedDiagCount} previous failed diagnostics (max ${MAX_FIX_ATTEMPTS}). Review the failures and revise the plan or seek human input.`,
                  },
                )
              }
              const detected = yield* Effect.promise(() => detectDiagnosticsCommands(session.directory))
              const filter = input.filter
              const commands = filter ? detected.filter((command) => command.name.includes(filter)) : detected
              const completeDiagnostics = commands.length === detected.length
              if (commands.length === 0 && filter) {
                return toolOutput("Diagnostics skipped", { gate: summarizeGate(gate), ran: false, passed: false, results: [] }, { ran: false, reason: `No commands matched filter: ${filter}` })
              }
              yield* permission.assert({
                action: "graph.diagnostics_run",
                resources: commands.map((command) => command.command),
                save: commands.map((command) => command.command),
                metadata: { commands },
                sessionID: context.sessionID,
                agent: context.agent,
                source: source(context),
              })
              const results = yield* Effect.forEach(commands, (command) => runDiagnostic(processes, command, session.directory, input.timeout ?? DEFAULT_TIMEOUT_MS), { concurrency: 1 })
              const allPassed = results.every((result) => result.passed)
              const verified = allPassed && completeDiagnostics
              if (verified || !allPassed) {
                yield* storage.node.update(input.targetNodeID, {
                  testStatus: allPassed ? "passed" : "failed",
                  ...(verified ? { status: "verified" as const } : {}),
                })
              }
              yield* audit.tool.record({
                projectID: session.projectID,
                sessionID: session.sessionID,
                nodeID: input.targetNodeID,
                toolName: "graph.diagnostics.run",
                toolType: "diagnostics",
                status: allPassed ? "succeeded" : "failed",
                inputSummary: commands.map((command) => command.name).join("; "),
                outputSummary: results.map((result) => `${result.name}:${result.failureReason ?? result.exitCode}`).join(", "),
              })
              return toolOutput(verified ? "Diagnostics passed" : allPassed ? "Diagnostics passed - filtered subset" : "Diagnostics failed", {
                gate: summarizeGate(gate),
                ran: true,
                passed: allPassed,
                complete: completeDiagnostics,
                verified,
                results: results.map((result) => ({
                  name: result.name,
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  passed: result.passed,
                  ...(result.failureReason ? { failureReason: result.failureReason } : {}),
                })),
              }, { ran: true, passed: allPassed, complete: completeDiagnostics, verified, results })
            }).pipe(toToolFailure),
        }),
      })
      .pipe(Effect.orDie)

    function applyArtifact(
      sourceInput: ApplySource,
      input: typeof ArtifactApplyInput.Type,
      context: Tool.Context,
      session: GraphSession,
    ) {
      return Effect.gen(function* () {
        const paths = resolveArtifactPathsSafe(sourceInput.artifact, session.directory)
        if (isArtifactPathError(paths)) return blockedArtifactPath(paths)
        const files = paths.map((item) => item.relative)
        const gate = yield* build.evaluate({
          projectID: session.projectID,
          sessionID: session.sessionID,
          targetNodeID: input.targetNodeID,
          artifact: sourceInput.artifact,
          executor: "manual",
        })
        if (!gate.allowed) {
          const currentPlan = yield* domain.currentPlan({ sessionID: session.sessionID })
          const buildable = buildableNodes(currentPlan.nodes, currentPlan.edges).map((node) => node.name)
          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: input.targetNodeID,
            toolName: "graph.artifact.apply",
            toolType: "graph",
            status: "blocked",
            inputSummary: summarizePaths(paths),
            outputSummary: summarizeGate(gate),
          })
          return toolOutput("Artifact blocked", {
            gate: summarizeGate(gate),
            applied: false,
            files: [],
            buildable,
            ...draftMetadata(sourceInput.draftID),
          }, { applied: false, gate, ...draftMetadata(sourceInput.draftID) })
        }
        const existing = yield* Effect.forEach(paths, (item) =>
          Effect.gen(function* () {
            const content = yield* fs.readFileStringSafe(item.absolute)
            return { ...item, existed: content !== undefined, content: content ?? "" }
          }),
        )
        const artifactPlan = GraphArtifact.planArtifactApplication(
          sourceInput.artifact,
          Object.fromEntries(existing.map((item) => [item.relative, item.content])),
        )
        if (!artifactPlan.valid) {
          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: input.targetNodeID,
            toolName: "graph.artifact.apply",
            toolType: "graph",
            status: "blocked",
            inputSummary: summarizePaths(paths),
            outputSummary: `artifact:${artifactPlan.issues.length}`,
          })
          return toolOutput("Artifact blocked", {
            gate: summarizeGate(gate),
            applied: false,
            files: [],
            buildable: [],
            ...draftMetadata(sourceInput.draftID),
          }, { applied: false, gate, artifact: artifactPlan, ...draftMetadata(sourceInput.draftID) })
        }
        const bytesPlanned = artifactPlannedBytes(artifactPlan.files, files)
        yield* permission.assert({
          action: "graph.artifact_write",
          resources: files,
          save: ["*"],
          metadata: {
            paths: files,
            fileCount: files.length,
            bytesPlanned,
            plannedWrites: existing.map((item) => ({
              path: item.relative,
              existed: item.existed,
              bytes: byteLength(artifactPlan.files[item.relative] ?? ""),
            })),
            ...draftMetadata(sourceInput.draftID),
          },
          sessionID: context.sessionID,
          agent: context.agent,
          source: source(context),
        })
        yield* Effect.forEach(existing, (item) =>
          Effect.gen(function* () {
            const content = artifactPlan.files[item.relative]
            if (content === undefined) return yield* Effect.die(new Error(`Artifact did not produce ${item.relative}`))
            yield* fs.writeWithDirs(item.absolute, content)
            yield* events.publish(FileSystem.Event.Edited, { file: item.absolute })
            yield* events.publish(Watcher.Event.Updated, { file: item.absolute, event: item.existed ? "change" : "add" })
          }),
        )
        yield* storage.node.update(input.targetNodeID, { status: "implemented", testStatus: "pending" })
        yield* events.publish(Graph.Event.PlanUpdated, { projectID: session.projectID })
        yield* audit.tool.record({
          projectID: session.projectID,
          sessionID: session.sessionID,
          nodeID: input.targetNodeID,
          toolName: "graph.artifact.apply",
          toolType: "graph",
          status: "succeeded",
          inputSummary: summarizePaths(paths),
          outputSummary: `applied:${paths.length}`,
        })
        if (sourceInput.draftID !== undefined) yield* drafts.markApplied(sourceInput.draftID)
        return toolOutput("Artifact applied", {
          gate: summarizeGate(gate),
          applied: true,
          files,
          buildable: [],
          stage: "completed",
          fileCount: files.length,
          bytesPlanned,
          bytesWritten: bytesPlanned,
          ...(files.length > 0 ? { currentFile: files[files.length - 1] } : {}),
          ...draftMetadata(sourceInput.draftID),
        }, { applied: true, files, gate, ...draftMetadata(sourceInput.draftID) })
      })
    }
  }),
)

function resolveGraphSession(
  context: Tool.Context,
  sessions: SessionStore.Interface,
  location: Location.Interface,
): Effect.Effect<GraphSession, ToolFailure> {
  return Effect.gen(function* () {
    const session = yield* sessions.get(context.sessionID)
    if (!session) return yield* new ToolFailure({ message: `Session not found: ${context.sessionID}` })
    return { projectID: session.projectID, sessionID: session.id, directory: location.directory }
  })
}

function toolOutput(title: string, metadata: Record<string, unknown>, output: unknown = metadata) {
  return { title, metadata, output: formatJson(output) }
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "undefined"
}

function summarizeGate(result: GateResult) {
  if (result.allowed) return "allowed"
  return `blocked:${result.issues.length}`
}

function isArtifactPathError(value: unknown): value is ArtifactPathError {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "ArtifactPathError"
}

function blockedArtifactPath(error: ArtifactPathError) {
  const repairHints = [
    "Use a relative path inside the current worktree.",
    "Remove absolute prefixes, drive letters, and ../ segments before retrying.",
  ]
  return toolOutput(
    "Artifact blocked",
    {
      stage: "blocked",
      applied: false,
      files: [],
      buildable: [],
      reason: error.reason,
      path: error.path,
      message: error.message,
      repairHints,
    },
    { applied: false, reason: error.reason, path: error.path, message: error.message, repairHints },
  )
}

function blockedArtifactDraft(input: {
  readonly reason: string
  readonly draftID?: GraphArtifactDraft.DraftID
  readonly error?: GraphArtifactDraft.NotFoundError | GraphArtifactDraft.ValidationError
  readonly repairHints?: ReadonlyArray<string>
}) {
  const repairHints = input.repairHints ?? [
    "Use a draft from the current graph session and target node.",
    "If the draft failed validation, fix the declared files or chunks and retry.",
  ]
  const error = input.error === undefined ? undefined : draftError(input.error)
  return toolOutput(
    "Artifact blocked",
    {
      stage: "blocked",
      applied: false,
      files: [],
      buildable: [],
      reason: input.reason,
      repairHints,
      ...(input.draftID === undefined ? {} : { draftID: input.draftID }),
      ...(error === undefined ? {} : { error }),
    },
    {
      applied: false,
      reason: input.reason,
      repairHints,
      ...(input.draftID === undefined ? {} : { draftID: input.draftID }),
      ...(error === undefined ? {} : { error }),
    },
  )
}

function resolveArtifactPathsSafe(artifact: GraphArtifact.Artifact, directory: string) {
  const normalized = artifactPaths(artifact).map((item) => normalizeArtifactPathSafe(item, directory))
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return Array.from(
    new Map(
      normalized.filter((item): item is ArtifactPath => !isArtifactPathError(item)).map((item) => [item.relative, item]),
    ).values(),
  )
}

function normalizeArtifactSafe(artifact: GraphArtifact.Artifact, directory: string): GraphArtifact.Artifact | ArtifactPathError {
  if (artifact.mode === "full") {
    const filePath = normalizeArtifactPathSafe({ relative: artifact.path }, directory)
    if (isArtifactPathError(filePath)) return filePath
    return { ...artifact, path: filePath.relative }
  }
  if (artifact.mode === "files") {
    const files = normalizeArtifactFiles(artifact.files, directory)
    if (isArtifactPathError(files)) return files
    return { ...artifact, files }
  }
  const operations = normalizeArtifactOperations(artifact.operations, directory)
  if (isArtifactPathError(operations)) return operations
  return { ...artifact, operations }
}

function artifactPaths(artifact: GraphArtifact.Artifact) {
  if (artifact.mode === "full") return [{ relative: artifact.path }]
  if (artifact.mode === "files") return artifact.files.map((file) => ({ relative: file.path }))
  return artifact.operations.map((operation) => ({ relative: operation.path }))
}

function normalizeArtifactFiles(files: ReadonlyArray<GraphArtifact.FilesArtifactFile>, directory: string) {
  const normalized = files.map((file) => {
    const filePath = normalizeArtifactPathSafe({ relative: file.path }, directory)
    return isArtifactPathError(filePath) ? filePath : { ...file, path: filePath.relative }
  })
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return normalized.filter((file): file is GraphArtifact.FilesArtifactFile => !isArtifactPathError(file))
}

function normalizeArtifactOperations(operations: ReadonlyArray<GraphArtifact.PatchOperation>, directory: string) {
  const normalized = operations.map((operation) => {
    const filePath = normalizeArtifactPathSafe({ relative: operation.path }, directory)
    return isArtifactPathError(filePath) ? filePath : { ...operation, path: filePath.relative }
  })
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return normalized.filter((operation): operation is GraphArtifact.PatchOperation => !isArtifactPathError(operation))
}

function normalizeArtifactPathSafe(input: { readonly relative: string }, directory: string): ArtifactPath | ArtifactPathError {
  if (path.isAbsolute(input.relative) || path.win32.isAbsolute(input.relative)) {
    return artifactPathError("absolute_path", input.relative, `Artifact path must be relative: ${input.relative}`)
  }
  const relative = path.posix.normalize(input.relative.replaceAll("\\", "/"))
  if (relative === "." || relative === ".." || relative.startsWith("../")) {
    return artifactPathError("path_escape", input.relative, `Artifact path escapes the worktree: ${input.relative}`)
  }
  const absolute = path.resolve(directory, ...relative.split("/"))
  if (!FSUtil.contains(directory, absolute)) {
    return artifactPathError("path_escape", input.relative, `Artifact path escapes the worktree: ${input.relative}`)
  }
  if (!resolvesWithinWorktree(directory, relative.split("/"))) {
    return artifactPathError("path_escape", input.relative, `Artifact path escapes the worktree: ${input.relative}`)
  }
  return { relative, absolute }
}

function resolvesWithinWorktree(directory: string, segments: ReadonlyArray<string>) {
  let realBase: string
  try {
    realBase = realpathSync.native(directory)
  } catch {
    return false
  }
  let current = realBase
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    const candidate = path.join(current, segment)
    try {
      current = realpathSync.native(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") current = candidate
      else return false
    }
    if (!FSUtil.contains(realBase, current)) return false
  }
  return true
}

function artifactPathError(reason: ArtifactPathError["reason"], inputPath: string, message: string): ArtifactPathError {
  return { _tag: "ArtifactPathError", reason, path: inputPath, message }
}

function normalizeDraftFiles(test: string, files: ReadonlyArray<typeof DraftFile.Type>, directory: string) {
  const artifact = normalizeArtifactSafe(
    { mode: "files", test, files: files.map((file) => ({ path: file.path, code: "x" })) },
    directory,
  )
  if (isArtifactPathError(artifact)) return artifact
  if (artifact.mode !== "files") throw new Error("expected files artifact")
  return artifact.files.map((file, index) => ({
    path: file.path,
    ...(files[index]?.expectedChunks === undefined ? {} : { expectedChunks: files[index].expectedChunks }),
    ...(files[index]?.expectedSha256 === undefined ? {} : { expectedSha256: files[index].expectedSha256 }),
  }))
}

function normalizeDraftPath(input: string, directory: string) {
  const artifact = normalizeArtifactSafe({ mode: "files", test: "x", files: [{ path: input, code: "x" }] }, directory)
  if (isArtifactPathError(artifact)) return artifact
  if (artifact.mode !== "files") throw new Error("expected files artifact")
  const file = artifact.files[0]
  if (!file) throw new Error("expected normalized file")
  return file.path
}

function draftError(error: GraphArtifactDraft.NotFoundError | GraphArtifactDraft.ValidationError) {
  if (error._tag === "GraphArtifactDraft.ValidationError") {
    return {
      rule: error.rule,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.index === undefined ? {} : { index: error.index }),
    }
  }
  return { id: error.id }
}

function getDraft(drafts: GraphArtifactDraft.Interface, draftID: GraphArtifactDraft.DraftID) {
  return drafts.get(draftID).pipe(
    Effect.map((draft) => ({ _tag: "found" as const, draft })),
    Effect.catchTag("GraphArtifactDraft.NotFoundError", (error) =>
      Effect.succeed({ _tag: "blocked" as const, error }),
    ),
  )
}

function blockedArtifactSource(draftID: string | undefined) {
  const repairHints = [
    "Provide exactly one of artifact or draftID.",
    "Use artifact for small direct artifacts.",
    "Use graph_artifact_begin, graph_artifact_chunk, graph_artifact_seal, then graph_artifact_apply with draftID for large or multi-file artifacts.",
  ]
  return toolOutput(
    "Artifact blocked",
    {
      applied: false,
      files: [],
      buildable: [],
      reason: "artifact_source_required",
      repairHints,
      ...(draftID === undefined ? {} : { draftID }),
    },
    { applied: false, reason: "artifact_source_required", repairHints, ...(draftID === undefined ? {} : { draftID }) },
  )
}

function blockedDirectArtifactTooLarge(paths: ReadonlyArray<{ readonly relative: string }>, inputBytes: number) {
  const files = paths.map((item) => item.relative)
  const repairHints = [
    "Use graph_artifact_begin, graph_artifact_chunk, graph_artifact_seal, then graph_artifact_apply with draftID.",
    "Split the graph node into smaller buildable nodes if the artifact is too large to review at once.",
  ]
  return toolOutput(
    "Artifact blocked",
    {
      applied: false,
      files,
      fileCount: files.length,
      bytesPlanned: inputBytes,
      bytesWritten: 0,
      limitBytes: MAX_DIRECT_ARTIFACT_BYTES,
      reason: "artifact_too_large",
      repairHints,
    },
    { applied: false, reason: "artifact_too_large", bytes: inputBytes, limitBytes: MAX_DIRECT_ARTIFACT_BYTES, repairHints },
  )
}

function blockedDraft(reason: string, draftID: GraphArtifactDraft.DraftID) {
  const repairHints = applyDraftRepairHints
  return toolOutput(
    "Artifact blocked",
    {
      applied: false,
      files: [],
      buildable: [],
      draftID,
      reason,
      repairHints,
    },
    { applied: false, draftID, reason, repairHints },
  )
}

function draftMetadata(draftID: GraphArtifactDraft.DraftID | undefined) {
  return draftID === undefined ? {} : { draftID }
}

const applyDraftRepairHints = [
  "Use a sealed draft from the current graph session and target node.",
  "Call graph_artifact_seal before applying a staged artifact.",
]

function artifactInputBytes(artifact: GraphArtifact.Artifact) {
  if (artifact.mode === "full") return byteLength(artifact.code)
  if (artifact.mode === "files") return artifact.files.reduce((sum, file) => sum + byteLength(file.code), 0)
  return artifact.operations.reduce(
    (sum, operation) =>
      sum + byteLength(operation.path) + byteLength(operation.preimageHash) + byteLength(operation.old) + byteLength(operation.replacement),
    0,
  )
}

function artifactPlannedBytes(files: Readonly<Record<string, string>>, paths: ReadonlyArray<string>) {
  return paths.reduce((sum, file) => sum + byteLength(files[file] ?? ""), 0)
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}

function summarizePaths(paths: ReadonlyArray<{ readonly relative: string }>) {
  return `files=${paths.map((item) => item.relative).join(",")}`
}

function planAdmissionSuccess(
  result: GraphPlan.AdmitPlanResult,
  suggestedOrder: ReadonlyArray<string>,
  input: typeof PlanAdmitInput.Type,
) {
  return {
    admitted: true,
    dryRun: input.dryRun ?? false,
    result,
    suggestedOrder,
    error: null,
    repairHints: [],
    allowedEdgeMatrix: [],
    requested: { nodes: input.nodes.length, edges: input.edges.length },
  }
}

function planNodeInput(node: typeof PlanNode.Type): GraphPlan.PlanNodeCreate {
  return {
    ...(node.id === undefined ? {} : { id: node.id }),
    type: node.type,
    name: node.name,
    level: node.level,
    ...(node.priority === undefined ? {} : { priority: node.priority }),
    ...(node.category === undefined ? {} : { category: node.category }),
    ...(node.desc === undefined ? {} : { desc: node.desc }),
    ...(node.content === undefined ? {} : { content: node.content }),
    ...(node.codeHash === undefined ? {} : { codeHash: node.codeHash }),
    ...(node.confidence === undefined ? {} : { confidence: node.confidence }),
  }
}

function planAdmissionRejection(error: GraphDomain.ValidationError, input: typeof PlanAdmitInput.Type) {
  return {
    admitted: false,
    dryRun: input.dryRun ?? false,
    result: null,
    suggestedOrder: [],
    error: {
      rule: error.rule,
      message: error.message,
      ...(error.context === undefined ? {} : { context: error.context }),
    },
    repairHints: repairHintsFor(error.rule),
    allowedEdgeMatrix: allowedEdgeMatrix(),
    requested: { nodes: input.nodes.length, edges: input.edges.length },
  }
}

function repairHintsFor(rule: string) {
  if (rule === "edge.type_matrix") {
    return [
      "Use a relation allowed by the graph edge matrix for the source/target types and levels.",
      "Use blocks only for ordering nodes with the same type and level.",
      "Use contains for graph hierarchy, for example prd/composite to implementation nodes.",
      "Use uses for composite(L2) to atomic(L2) implementation dependencies, or same-tier imported code nodes.",
    ]
  }
  if (rule === "edge.self_loop") return ["Point the edge at a different target node; self-loops are not allowed."]
  if (rule === "edge.dangling_endpoint") return ["Reference an admitted node id or an in-request node index like @0, @1."]
  if (rule === "graph.cycle") return ["Remove or reverse one dependency edge so the CurrentPlan remains acyclic."]
  return ["Revise the plan input and retry graph_plan_admit after satisfying the validation rule."]
}

function allowedEdgeMatrix() {
  return [
    "contains: prd -> composite, prd -> atomic, composite -> atomic, atomic -> atomic, or same-type L1 -> L2",
    "blocks: same type and same level",
    "addresses: composite(L2) -> prd(L2)",
    "uses: composite(L2) -> atomic(L2), or same-tier imported code nodes at L2",
    "deprecated_by: same type and same level",
  ]
}

function runDiagnostic(processes: AppProcess.Interface, command: NamedCommand, directory: string, timeoutMs: number) {
  return processes
    .run(
      ChildProcess.make(command.command, [], {
        shell: process.env.SHELL ?? "/bin/sh",
        cwd: directory,
        env: process.env,
        stdin: "ignore",
      }),
      { combineOutput: true, maxOutputBytes: MAX_OUTPUT_CHARS, timeout: `${timeoutMs} millis` },
    )
    .pipe(
      Effect.map((result): CommandResult => {
        const output = (result.output ?? Buffer.concat([result.stdout, result.stderr])).toString("utf8")
        const truncatedOutput = output.slice(0, MAX_OUTPUT_CHARS)
        const failureReason = diagnosticFailureReason(command.command, result.exitCode, false, truncatedOutput)
        return {
          name: command.name,
          command: command.command,
          exitCode: result.exitCode,
          output: truncatedOutput,
          timedOut: false,
          passed: failureReason === undefined,
          ...(failureReason ? { failureReason } : {}),
        }
      }),
      Effect.catchTag("AppProcessError", (error) => {
        const timedOut = error.message.includes("Timed out")
        const output = (error.stderr ?? error.message).slice(0, MAX_OUTPUT_CHARS)
        return Effect.succeed({
          name: command.name,
          command: command.command,
          exitCode: error.exitCode ?? null,
          output,
          timedOut,
          passed: false,
          failureReason: timedOut ? "timeout" : error.exitCode === undefined ? "process_error" : `exit_code:${error.exitCode}`,
        })
      }),
    )
}

function diagnosticFailureReason(command: string, exitCode: number, timedOut: boolean, output: string) {
  if (timedOut) return "timeout"
  if (exitCode !== 0) return `exit_code:${exitCode}`
  if (isBunRunUsageOutput(command, output)) return "bun_run_usage"
}

function isBunRunUsageOutput(command: string, output: string) {
  return /\bbun\b/.test(command) && /\brun\b/.test(command) && output.includes("Usage: bun run [flags] <file or script>")
}

async function detectDiagnosticsCommands(directory: string): Promise<NamedCommand[]> {
  const pkg = await Bun.file(path.join(directory, "package.json"))
    .json()
    .catch(() => ({ scripts: {} }))
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {}
  const commands = [
    ...(scripts.test ? [{ name: "test", command: "bun run test" }] : []),
    ...(scripts.typecheck ? [{ name: "typecheck", command: "bun run typecheck" }] : []),
    ...(scripts.lint ? [{ name: "lint", command: "bun run lint" }] : []),
  ]
  return commands.length > 0 ? commands : [{ name: "test", command: "bun test" }]
}

function toToolFailure<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ToolFailure> {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof ToolFailure) return error
      if (error instanceof Error) return new ToolFailure({ message: error.message })
      return new ToolFailure({ message: String(error) })
    }),
  )
}

export const node = makeLocationNode({
  name: "tool/graph",
  layer,
  deps: [
    ToolRegistry.node,
    SessionStore.node,
    Location.node,
    GraphPlan.node,
    GraphBuild.node,
    GraphStorage.node,
    GraphAudit.node,
    GraphDomain.node,
    GraphArtifactDraft.node,
    FSUtil.node,
    EventV2.node,
    PermissionV2.node,
    AppProcess.node,
  ],
})
