export * as GraphBuild from "./build"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../../effect/layer-node"
import type { ProjectV2 } from "../../project"
import type { ConsistencyIssue } from "../derivation/checker"
import * as GraphStorage from "../storage"
import * as GraphAudit from "./audit"
import type { GenerationExecutor, GenerationRunStatus } from "./audit.sql"
import { evaluateBuildGate } from "./gate"
import type { GateResult } from "./gate"
import type { Artifact } from "./artifact"

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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphBuild") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service

    const evaluate = Effect.fn("GraphBuild.evaluate")(function* (input: BuildEvaluateInput) {
      const main = yield* storage.main({ projectID: input.projectID })
      const currentPlan = yield* storage.currentPlan({ sessionID: input.sessionID })
      const result = evaluateBuildGate({
        projectID: input.projectID,
        sessionID: input.sessionID,
        targetNodeID: input.targetNodeID,
        main,
        currentPlan,
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
      return result
    })

    return Service.of({ evaluate })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [GraphStorage.node, GraphAudit.node] })

export const defaultLayer = layer.pipe(Layer.provide(GraphAudit.defaultLayer), Layer.provide(GraphStorage.defaultLayer))

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
