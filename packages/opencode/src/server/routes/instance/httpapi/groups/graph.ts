import { Graph } from "@opencode-ai/schema"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ApiNotFoundError } from "../errors"

const GraphNodeResponse = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  sessionID: Schema.NullOr(Schema.String),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Schema.NullOr(Graph.Priority),
  category: Schema.NullOr(Schema.String),
  status: Graph.NodeStatus,
  desc: Schema.NullOr(Schema.String),
  content: Schema.NullOr(Graph.NodeContent),
  codeHash: Schema.NullOr(Schema.String),
  testStatus: Graph.TestStatus,
  confidence: Schema.Number,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "GraphNode" })

const GraphEdgeResponse = Schema.Struct({
  id: Schema.String,
  sourceID: Schema.String,
  targetID: Schema.String,
  relation: Graph.EdgeRelation,
  confidence: Schema.Number,
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphEdge" })

const GraphViewResponse = Schema.Struct({
  nodes: Schema.Array(GraphNodeResponse),
  edges: Schema.Array(GraphEdgeResponse),
}).annotate({ identifier: "GraphView" })

const SessionPlanViewResponse = Schema.Struct({
  source: Schema.Literals(["currentPlan", "version"]),
  versionNumber: Schema.NullOr(Schema.Number),
  publishedAt: Schema.NullOr(Schema.Number),
  nodes: Schema.Array(GraphNodeResponse),
  edges: Schema.Array(GraphEdgeResponse),
}).annotate({ identifier: "SessionPlanView" })

const PlanNodePayload = Schema.Struct({
  id: Schema.optional(Graph.NodeID),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Schema.optional(Graph.Priority),
  category: Schema.optional(Schema.String),
  status: Schema.optional(Graph.NodeStatus),
  desc: Schema.optional(Schema.String),
  content: Schema.optional(Graph.NodeContent),
  verification: Schema.optional(Graph.VerificationSpec),
  codeHash: Schema.optional(Schema.String),
  testStatus: Schema.optional(Graph.TestStatus),
  confidence: Schema.optional(Schema.Number),
}).annotate({ identifier: "GraphPlanNodePayload" })

const PlanEdgePayload = Schema.Struct({
  id: Schema.optional(Graph.EdgeID),
  sourceID: Schema.String,
  targetID: Schema.String,
  relation: Graph.EdgeRelation,
  confidence: Schema.optional(Schema.Number),
}).annotate({ identifier: "GraphPlanEdgePayload" })

export const PlanAdmitPayload = Schema.Struct({
  dryRun: Schema.optional(Schema.Boolean),
  nodes: Schema.Array(PlanNodePayload),
  edges: Schema.Array(PlanEdgePayload),
}).annotate({ identifier: "GraphPlanAdmitPayload" })

export const PromotePayload = Schema.Struct({
  message: Schema.optional(Schema.String),
  expectedRevision: Schema.optional(Schema.Number),
}).annotate({ identifier: "GraphPromotePayload" })

export const WorkflowModePayload = Schema.Struct({
  mode: Graph.ExecutionMode,
  expectedRevision: Schema.Number,
}).annotate({ identifier: "GraphWorkflowModePayload" })

export const WorkflowApprovePayload = Schema.Struct({
  expectedRevision: Schema.Number,
}).annotate({ identifier: "GraphWorkflowApprovePayload" })

export const WorkflowPausePayload = Schema.Struct({
  expectedRevision: Schema.Number,
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "GraphWorkflowPausePayload" })

export class GraphWorkflowRevisionConflict extends Schema.TaggedErrorClass<GraphWorkflowRevisionConflict>()(
  "GraphWorkflowRevisionConflict",
  {
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class GraphWorkflowActiveOperation extends Schema.TaggedErrorClass<GraphWorkflowActiveOperation>()(
  "GraphWorkflowActiveOperation",
  {
    operationKind: Schema.Literal("artifact_apply"),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

const AdmitResultResponse = Schema.Struct({
  nodesCreated: Schema.Number,
  edgesCreated: Schema.Number,
  dryRun: Schema.Boolean,
}).annotate({ identifier: "GraphPlanAdmitResult" })

const PromoteResultResponse = Schema.Struct({
  versionID: Schema.String,
  versionNumber: Schema.Number,
  nodes: Schema.Number,
  edges: Schema.Number,
}).annotate({ identifier: "GraphPromoteResult" })

const GraphVersionResponse = Schema.Struct({
  id: Schema.String,
  versionNumber: Schema.Number,
  message: Schema.NullOr(Schema.String),
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphVersion" })

const NodeBlocker = Schema.Struct({
  nodeID: Schema.String,
  nodeName: Schema.String,
  nodeStatus: Graph.NodeStatus,
}).annotate({ identifier: "GraphNodeBlocker" })

const ValidationIssueItem = Schema.Struct({
  rule: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "GraphValidationIssue" })

const NodeReadinessResponse = Schema.Struct({
  nodeID: Schema.String,
  status: Graph.NodeStatus,
  inCurrentPlan: Schema.Boolean,
  blockers: Schema.Array(NodeBlocker),
  validationIssues: Schema.Array(ValidationIssueItem),
}).annotate({ identifier: "GraphNodeReadiness" })

const ToolRunItem = Schema.Struct({
  id: Schema.String,
  toolName: Schema.String,
  toolType: Schema.String,
  inputSummary: Schema.NullOr(Schema.String),
  outputSummary: Schema.NullOr(Schema.String),
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(Graph.ToolEvidence),
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphToolRun" })

const GenerationRunItem = Schema.Struct({
  id: Schema.String,
  executor: Schema.String,
  status: Schema.String,
  gateAllowed: Schema.Boolean,
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphGenerationRun" })

const NodeAuditResponse = Schema.Struct({
  toolRuns: Schema.Array(ToolRunItem),
  generationRuns: Schema.Array(GenerationRunItem),
}).annotate({ identifier: "GraphNodeAudit" })

const WorkflowTaskResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  order: Schema.Number,
  moduleID: Schema.NullOr(Schema.String),
  moduleName: Schema.NullOr(Schema.String),
  status: Graph.NodeStatus,
  testStatus: Graph.TestStatus,
  buildable: Schema.Boolean,
  current: Schema.Boolean,
  verification: Schema.NullOr(Graph.VerificationSpec),
  latestEvidence: Schema.NullOr(Graph.VerificationEvidence),
}).annotate({ identifier: "GraphWorkflowTask" })

const WorkflowRollupResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["prd", "composite"]),
  status: Schema.Literals(["pending", "implemented", "verified", "failed"]),
  taskIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "GraphWorkflowRollup" })

const WorkflowModuleResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literal("composite"),
  status: Schema.Literals(["pending", "implemented", "verified", "failed"]),
  taskIDs: Schema.Array(Schema.String),
  tasks: Schema.Array(WorkflowTaskResponse),
}).annotate({ identifier: "GraphWorkflowModule" })

const WorkflowResponse = Schema.Struct({
  mode: Schema.NullOr(Graph.ExecutionMode),
  revision: Schema.Number,
  activeOperationKind: Schema.NullOr(Schema.Literal("artifact_apply")),
  phase: Schema.Literals(["planning", "building", "verifying", "checkpoint", "complete", "failed"]),
  checkpoint: Schema.Struct({
    status: Graph.CheckpointStatus,
    kind: Schema.NullOr(Graph.CheckpointKind),
    scopeNodeID: Schema.NullOr(Schema.String),
    scopeName: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  }),
  currentTask: Schema.NullOr(WorkflowTaskResponse),
  modules: Schema.Array(WorkflowModuleResponse),
  tasks: Schema.Array(WorkflowTaskResponse),
  rollups: Schema.Array(WorkflowRollupResponse),
  progress: Schema.Struct({
    total: Schema.Number,
    verified: Schema.Number,
    failed: Schema.Number,
    percent: Schema.Number,
  }),
}).annotate({ identifier: "GraphWorkflow" })

export const ProjectQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
})

export const SessionRequiredQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  session: Schema.String,
})

export const SessionOptionalQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  session: Schema.optional(Schema.String),
})

const DiffResponse = Schema.Struct({
  summary: Schema.Struct({
    nodesAdded: Schema.Number,
    nodesRemoved: Schema.Number,
    nodesModified: Schema.Number,
    edgesAdded: Schema.Number,
    edgesRemoved: Schema.Number,
  }),
  nodesAdded: Schema.Array(Schema.String),
  nodesRemoved: Schema.Array(Schema.String),
  nodesModified: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fields: Schema.Array(Schema.String),
    }),
  ),
  edgesAdded: Schema.Number,
  edgesRemoved: Schema.Number,
}).annotate({ identifier: "GraphDiff" })

export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  left: Schema.String,
  right: Schema.String,
  session: Schema.optional(Schema.String),
})

export const GraphPaths = {
  main: "/graph/main",
  currentPlan: "/graph/current-plan",
  planView: "/graph/plan-view",
  node: "/graph/node/:nodeID",
  nodeReadiness: "/graph/node/:nodeID/readiness",
  nodeAudit: "/graph/node/:nodeID/audit",
  versions: "/graph/versions",
  deleteNode: "/graph/node/:nodeID",
  deleteEdge: "/graph/edge/:edgeID",
  diff: "/graph/diff",
  planAdmit: "/graph/plan/admit",
  workflow: "/graph/workflow",
  workflowMode: "/graph/workflow/mode",
  workflowApprove: "/graph/workflow/approve",
  workflowPause: "/graph/workflow/pause",
  promote: "/graph/current-plan/promote",
} as const

export const GraphApi = HttpApi.make("graph")
  .add(
    HttpApiGroup.make("graph")
      .add(
        HttpApiEndpoint.get("main", GraphPaths.main, {
          query: ProjectQuery,
          success: described(GraphViewResponse, "Project main graph"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.main",
            summary: "Get project main graph",
            description: "Retrieve the project main graph (committed nodes and edges with session_id IS NULL).",
          }),
        ),
        HttpApiEndpoint.get("currentPlan", GraphPaths.currentPlan, {
          query: SessionRequiredQuery,
          success: described(GraphViewResponse, "Session CurrentPlan graph"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.currentPlan",
            summary: "Get session CurrentPlan",
            description: "Retrieve the session-scoped CurrentPlan graph (nodes and edges with session_id = session).",
          }),
        ),
        HttpApiEndpoint.get("planView", GraphPaths.planView, {
          query: SessionRequiredQuery,
          success: described(SessionPlanViewResponse, "Session plan view"),
          error: [ApiNotFoundError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.planView",
            summary: "Get session plan view",
            description: "Retrieve the current session plan or its latest published version snapshot.",
          }),
        ),
        HttpApiEndpoint.get("node", GraphPaths.node, {
          params: { nodeID: Schema.String },
          query: ProjectQuery,
          success: described(GraphNodeResponse, "Graph node detail"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.node",
            summary: "Get graph node",
            description: "Retrieve a single graph node by ID.",
          }),
        ),
        HttpApiEndpoint.get("nodeReadiness", GraphPaths.nodeReadiness, {
          params: { nodeID: Schema.String },
          query: SessionRequiredQuery,
          success: described(NodeReadinessResponse, "Node build readiness"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.nodeReadiness",
            summary: "Get node build readiness",
            description: "Check whether a node is ready to build: blockers, dependency status, validation issues.",
          }),
        ),
        HttpApiEndpoint.get("nodeAudit", GraphPaths.nodeAudit, {
          params: { nodeID: Schema.String },
          query: SessionOptionalQuery,
          success: described(NodeAuditResponse, "Node audit history"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.nodeAudit",
            summary: "Get node audit history",
            description: "Retrieve tool runs and generation runs for a specific node.",
          }),
        ),
        HttpApiEndpoint.get("versions", GraphPaths.versions, {
          query: ProjectQuery,
          success: described(Schema.Array(GraphVersionResponse), "Graph version snapshots"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.versions",
            summary: "List graph versions",
            description: "Retrieve version snapshots for the project graph.",
          }),
        ),
        HttpApiEndpoint.delete("deleteNode", GraphPaths.deleteNode, {
          params: { nodeID: Schema.String },
          query: ProjectQuery,
          success: described(Schema.Boolean, "Node deleted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ProductMigration.Required],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.deleteNode",
            summary: "Delete graph node",
            description: "Delete a node from the graph. Cascades to connected edges.",
          }),
        ),
        HttpApiEndpoint.delete("deleteEdge", GraphPaths.deleteEdge, {
          params: { edgeID: Schema.String },
          query: ProjectQuery,
          success: described(Schema.Boolean, "Edge deleted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ProductMigration.Required],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.deleteEdge",
            summary: "Delete graph edge",
            description: "Delete an edge from the graph.",
          }),
        ),
        HttpApiEndpoint.get("diff", GraphPaths.diff, {
          query: DiffQuery,
          success: described(DiffResponse, "Graph diff"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.diff",
            summary: "Compare two graph states",
            description: "Compare graph states: left/right can be 'currentPlan', 'main', or 'version:N'.",
          }),
        ),
        HttpApiEndpoint.post("planAdmit", GraphPaths.planAdmit, {
          query: SessionRequiredQuery,
          payload: PlanAdmitPayload,
          success: described(AdmitResultResponse, "CurrentPlan admission result"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ProductMigration.Required],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.planAdmit",
            summary: "Admit nodes and edges into the CurrentPlan",
            description: "Admit nodes and edges into the session-scoped CurrentPlan graph before implementation.",
          }),
        ),
        HttpApiEndpoint.get("workflow", GraphPaths.workflow, {
          query: SessionRequiredQuery,
          success: described(WorkflowResponse, "Session workflow projection"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.workflow",
            summary: "Get session workflow",
            description: "Retrieve durable workflow mode, revision, checkpoints, tasks, modules, and progress.",
          }),
        ),
        HttpApiEndpoint.patch("workflowMode", GraphPaths.workflowMode, {
          query: SessionRequiredQuery,
          payload: WorkflowModePayload,
          success: described(WorkflowResponse, "Updated session workflow projection"),
          error: [
            HttpApiError.BadRequest,
            ApiNotFoundError,
            GraphWorkflowRevisionConflict,
            GraphWorkflowActiveOperation,
            HttpApiError.InternalServerError,
            ProductMigration.Required,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.workflowMode",
            summary: "Select workflow execution mode",
            description: "Select execution mode using the exact current workflow revision.",
          }),
        ),
        HttpApiEndpoint.patch("workflowApprove", GraphPaths.workflowApprove, {
          query: SessionRequiredQuery,
          payload: WorkflowApprovePayload,
          success: described(WorkflowResponse, "Updated session workflow projection"),
          error: [
            HttpApiError.BadRequest,
            ApiNotFoundError,
            GraphWorkflowRevisionConflict,
            HttpApiError.InternalServerError,
            ProductMigration.Required,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.workflowApprove",
            summary: "Approve the pending workflow checkpoint",
            description: "Approve a pending checkpoint using its exact workflow revision.",
          }),
        ),
        HttpApiEndpoint.patch("workflowPause", GraphPaths.workflowPause, {
          query: SessionRequiredQuery,
          payload: WorkflowPausePayload,
          success: described(WorkflowResponse, "Updated session workflow projection"),
          error: [
            HttpApiError.BadRequest,
            ApiNotFoundError,
            GraphWorkflowRevisionConflict,
            HttpApiError.InternalServerError,
            ProductMigration.Required,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.workflowPause",
            summary: "Pause the workflow",
            description: "Create a pause checkpoint using the exact current workflow revision.",
          }),
        ),
        HttpApiEndpoint.post("promote", GraphPaths.promote, {
          query: SessionRequiredQuery,
          payload: [HttpApiSchema.NoContent, PromotePayload],
          success: described(PromoteResultResponse, "CurrentPlan promotion result"),
          error: [
            HttpApiError.BadRequest,
            ApiNotFoundError,
            GraphWorkflowRevisionConflict,
            ProductMigration.Required,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.promote",
            summary: "Promote the CurrentPlan into the main graph",
            description:
              "Promote the session-scoped CurrentPlan into the project main graph, recording a versioned snapshot.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "graph",
          description: "Graph read API for project and CurrentPlan data.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode graph HttpApi",
      version: "0.0.1",
      description: "Graph read API surface.",
    }),
  )
