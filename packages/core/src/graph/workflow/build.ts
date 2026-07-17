export * as GraphBuild from "./build"

import { Context, Effect, Layer } from "effect"
import { Database } from "../../database/database"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import type { ConsistencyIssue } from "../derivation/checker"
import * as GraphStorage from "../storage"
import * as GraphAudit from "./audit"
import type { GenerationExecutor, GenerationRunStatus } from "./audit.sql"
import { evaluateBuildGate } from "./gate"
import type { GateResult } from "./gate"
import type { Artifact } from "./artifact"
import * as GraphWorkflowState from "./state"

export interface BuildEvaluateInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly targetNodeID: GraphStorage.NodeID
  readonly executor: GenerationExecutor
  readonly backend?: string
  readonly model?: string
  readonly contextSnapshotHash?: string
  readonly consistencyIssues?: ReadonlyArray<ConsistencyIssue>
  readonly artifact?: Artifact
  readonly diagnosticsRequested?: boolean
  readonly dryRun?: boolean
}

export interface Interface {
  readonly evaluate: (input: BuildEvaluateInput) => Effect.Effect<GateResult>
  readonly evaluateWithRevision: (input: BuildEvaluateInput) => Effect.Effect<{
    readonly gate: GateResult
    readonly workflowRevision: number
  }>
  readonly advanceVerified: GraphWorkflowState.Interface["advanceVerified"]
  readonly completeVerification: GraphWorkflowState.Interface["completeVerification"]
  readonly beginArtifactApply: GraphWorkflowState.Interface["beginArtifactApply"]
  readonly assertArtifactApplyOwner: GraphWorkflowState.Interface["assertArtifactApplyOwner"]
  readonly completeArtifactApply: GraphWorkflowState.Interface["completeArtifactApply"]
  readonly failArtifactApply: GraphWorkflowState.Interface["failArtifactApply"]
  readonly failVerification: GraphWorkflowState.Interface["failVerification"]
  readonly fail: GraphWorkflowState.Interface["fail"]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphBuild") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const workflowState = yield* GraphWorkflowState.Service

    const evaluateWithRevision = Effect.fn("GraphBuild.evaluateWithRevision")(function* (input: BuildEvaluateInput) {
      yield* workflowState.recoverAbandonedArtifactApply(input.sessionID)
      const main = yield* storage.main({ projectID: input.projectID })
      const currentPlan = yield* storage.currentPlan({ sessionID: input.sessionID })
      const state = yield* workflowState.get(input.sessionID)
      const evidence = yield* audit.tool.list({ projectID: input.projectID, sessionID: input.sessionID, nodeID: input.targetNodeID })
      const latestEvidence = evidence.flatMap((record) => record.evidence?.kind === "diagnostics" ? [record.evidence] : []).at(-1)
      const result = evaluateBuildGate({
        projectID: input.projectID,
        sessionID: input.sessionID,
        targetNodeID: input.targetNodeID,
        main,
        currentPlan,
        workflow: {
          mode: state?.mode ?? null,
          currentNodeID: state?.currentNodeID ?? null,
          checkpointKind: state?.checkpointKind ?? null,
          checkpointScopeNodeID: state?.checkpointScopeNodeID ?? null,
          checkpointStatus: state?.checkpointStatus ?? "none",
          artifactApplyActive: state?.activeOperationKind === "artifact_apply",
          ...(latestEvidence == null || input.diagnosticsRequested
            ? {}
            : { latestEvidenceComplete: latestEvidence.complete }),
        },
        consistencyIssues: input.consistencyIssues,
        artifact: input.artifact,
        diagnosticsRequested: input.diagnosticsRequested,
      })
      const status = buildStatus(result, input.dryRun === true)
      yield* audit.generation.record({
        projectID: input.projectID,
        sessionID: input.sessionID,
        nodeID: input.targetNodeID,
        executor: input.executor,
        backend: input.backend,
        model: input.model,
        contextSnapshotHash: input.contextSnapshotHash,
        status,
        gateResult: result,
        artifactSummary: summarizeArtifact(input.artifact),
      })
      yield* audit.tool.record({
        projectID: input.projectID,
        sessionID: input.sessionID,
        nodeID: input.targetNodeID,
        toolName: "graph.build.gate",
        toolType: "graph",
        status,
        inputSummary: `target=${input.targetNodeID}`,
        outputSummary: result.allowed ? "allowed" : `blocked:${result.issues.length}`,
      })
      return { gate: result, workflowRevision: state?.revision ?? 0 }
    })

    const evaluate = Effect.fn("GraphBuild.evaluate")((input: BuildEvaluateInput) =>
      Effect.map(evaluateWithRevision(input), (result) => result.gate),
    )

    return Service.of({
      evaluate,
      evaluateWithRevision,
      advanceVerified: workflowState.advanceVerified,
      completeVerification: workflowState.completeVerification,
      beginArtifactApply: workflowState.beginArtifactApply,
      assertArtifactApplyOwner: workflowState.assertArtifactApplyOwner,
      completeArtifactApply: workflowState.completeArtifactApply,
      failArtifactApply: workflowState.failArtifactApply,
      failVerification: workflowState.failVerification,
      fail: workflowState.fail,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [GraphStorage.node, GraphAudit.node, GraphWorkflowState.node],
})

export const layerFromDatabase = (database: Layer.Layer<Database.Service>) =>
  layer.pipe(Layer.provideMerge(GraphWorkflowState.layerFromDatabase(database)))

export const defaultLayer = layerFromDatabase(Database.layerFromPath(Database.path()))

function buildStatus(result: GateResult, dryRun: boolean): GenerationRunStatus {
  if (!result.allowed) return "blocked"
  if (dryRun) return "dry_run"
  return "succeeded"
}

function summarizeArtifact(artifact: Artifact | undefined) {
  if (!artifact) return undefined
  if (artifact.mode === "full") return `full ${artifact.path}`
  if (artifact.mode === "files") return `files ${artifact.files.length} files`
  return `patch ${artifact.operations.length} operations`
}
