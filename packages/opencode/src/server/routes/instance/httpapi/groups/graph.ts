import { Graph } from "@opencode-ai/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
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
  status: Schema.String,
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
  nodesModified: Schema.Array(Schema.Struct({
    id: Schema.String,
    fields: Schema.Array(Schema.String),
  })),
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
  node: "/graph/node/:nodeID",
  nodeReadiness: "/graph/node/:nodeID/readiness",
  nodeAudit: "/graph/node/:nodeID/audit",
  versions: "/graph/versions",
  deleteNode: "/graph/node/:nodeID",
  deleteEdge: "/graph/edge/:edgeID",
  diff: "/graph/diff",
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
            description:
              "Retrieve the project main graph (committed nodes and edges with session_id IS NULL).",
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
            description:
              "Retrieve the session-scoped CurrentPlan graph (nodes and edges with session_id = session).",
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
            description:
              "Check whether a node is ready to build: blockers, dependency status, validation issues.",
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
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
