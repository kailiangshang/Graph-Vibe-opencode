import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { topologicalOrder } from "@opencode-ai/core/graph/build-order"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { Graph } from "@opencode-ai/schema/graph"
import { Effect, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession } from "./util"

export const PlanNode = Schema.Struct({
  id: GraphStorage.NodeID.pipe(Schema.optional),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Graph.Priority.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  status: Graph.NodeStatus.pipe(Schema.optional),
  desc: Schema.String.pipe(Schema.optional),
  content: Graph.NodeContent.pipe(Schema.optional),
  codeHash: Schema.String.pipe(Schema.optional),
  testStatus: Graph.TestStatus.pipe(Schema.optional),
  confidence: Schema.Number.pipe(Schema.optional),
})

export const PlanEdge = Schema.Struct({
  id: GraphStorage.EdgeID.pipe(Schema.optional),
  sourceID: GraphStorage.NodeID,
  targetID: GraphStorage.NodeID,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number.pipe(Schema.optional),
})

export const Parameters = Schema.Struct({
  dryRun: Schema.Boolean.pipe(Schema.optional),
  nodes: Schema.Array(PlanNode),
  edges: Schema.Array(PlanEdge),
})

interface PlanAdmitMetadata {
  admitted: boolean
  dryRun: boolean
  result: GraphPlan.AdmitPlanResult | null
  suggestedOrder: string[]
  error: { rule: string; message: string; context?: unknown } | null
  repairHints: string[]
  allowedEdgeMatrix: string[]
  requested: { nodes: number; edges: number }
}

export const GraphPlanAdmitTool = Tool.define(
  "graph_plan_admit",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const plan = yield* GraphPlan.Service
    const audit = yield* GraphAudit.Service
    const domain = yield* GraphDomain.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: "Admit nodes and edges into the session CurrentPlan graph before implementation.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const admission = yield* plan.admit({
            projectID: session.projectID,
            sessionID: session.sessionID,
            dryRun: params.dryRun,
            nodes: params.nodes,
            edges: params.edges,
          }).pipe(
            Effect.map((result) => ({ _tag: "admitted" as const, result })),
            Effect.catchTag("GraphV2.ValidationError", (error) =>
              Effect.succeed({ _tag: "rejected" as const, error }),
            ),
          )

          if (admission._tag === "rejected") {
            const rejection = planAdmissionRejection(admission.error, params)
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              toolName: "graph.plan.admit",
              toolType: "graph",
              status: "failed",
              inputSummary: `nodes=${params.nodes.length} edges=${params.edges.length}`,
              outputSummary: `${admission.error.rule}: ${admission.error.message}`,
            })

            return {
              title: "CurrentPlan rejected",
              metadata: rejection,
              output: formatJson(rejection),
            }
          }

          const result = admission.result
          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            toolName: "graph.plan.admit",
            toolType: "graph",
            status: params.dryRun ? "dry_run" : "succeeded",
            inputSummary: `nodes=${params.nodes.length} edges=${params.edges.length}`,
            outputSummary: `nodes=${result.nodesCreated} edges=${result.edgesCreated}`,
          })

          if (!params.dryRun) yield* events.publish(Graph.Event.PlanUpdated, { projectID: session.projectID })

          let suggestedOrder: string[] = []
          if (!params.dryRun) {
            const cp = yield* domain.currentPlan({ sessionID: session.sessionID })
            const order = topologicalOrder(cp.nodes, cp.edges)
            suggestedOrder = order.map((n, i) => `${i + 1}. ${n.name} [${n.status}]`)
          }

          return {
            title: params.dryRun ? "CurrentPlan dry-run" : "CurrentPlan admitted",
            metadata: planAdmissionSuccess(result, suggestedOrder, params),
            output: formatJson(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function planAdmissionSuccess(
  result: GraphPlan.AdmitPlanResult,
  suggestedOrder: string[],
  params: typeof Parameters.Type,
): PlanAdmitMetadata {
  return {
    admitted: true,
    dryRun: params.dryRun ?? false,
    result,
    suggestedOrder,
    error: null,
    repairHints: [],
    allowedEdgeMatrix: [],
    requested: {
      nodes: params.nodes.length,
      edges: params.edges.length,
    },
  }
}

function planAdmissionRejection(error: GraphDomain.ValidationError, params: typeof Parameters.Type): PlanAdmitMetadata {
  return {
    admitted: false,
    dryRun: params.dryRun ?? false,
    result: null,
    suggestedOrder: [],
    error: {
      rule: error.rule,
      message: error.message,
      ...(error.context === undefined ? {} : { context: error.context }),
    },
    repairHints: repairHintsFor(error.rule),
    allowedEdgeMatrix: allowedEdgeMatrix(),
    requested: {
      nodes: params.nodes.length,
      edges: params.edges.length,
    },
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
