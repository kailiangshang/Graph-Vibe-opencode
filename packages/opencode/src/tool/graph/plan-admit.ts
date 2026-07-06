import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { topologicalOrder } from "@opencode-ai/core/graph/build-order"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { Graph } from "@opencode-ai/schema/graph"
import { Effect, Schema } from "effect"
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

export const GraphPlanAdmitTool = Tool.define(
  "graph_plan_admit",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const plan = yield* GraphPlan.Service
    const audit = yield* GraphAudit.Service
    const domain = yield* GraphDomain.Service

    return {
      description: "Admit nodes and edges into the session CurrentPlan graph before implementation.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)
          const result = yield* plan.admit({
            projectID: session.projectID,
            sessionID: session.sessionID,
            dryRun: params.dryRun,
            nodes: params.nodes,
            edges: params.edges,
          })
          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            toolName: "graph.plan.admit",
            toolType: "graph",
            status: params.dryRun ? "dry_run" : "succeeded",
            inputSummary: `nodes=${params.nodes.length} edges=${params.edges.length}`,
            outputSummary: `nodes=${result.nodesCreated} edges=${result.edgesCreated}`,
          })

          let suggestedOrder: string[] = []
          if (!params.dryRun) {
            const cp = yield* domain.currentPlan({ sessionID: session.sessionID })
            const order = topologicalOrder(cp.nodes, cp.edges)
            suggestedOrder = order.map((n, i) => `${i + 1}. ${n.name} [${n.status}]`)
          }

          return {
            title: params.dryRun ? "CurrentPlan dry-run" : "CurrentPlan admitted",
            metadata: { result, suggestedOrder },
            output: formatJson(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
