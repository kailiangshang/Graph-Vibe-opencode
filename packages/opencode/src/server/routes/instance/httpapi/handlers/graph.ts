import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { graphDiff } from "@opencode-ai/core/graph/diff"
import { Graph } from "@opencode-ai/schema"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { ProjectQuery, SessionRequiredQuery, SessionOptionalQuery, DiffQuery, PlanAdmitPayload, NodeStatusPayload, PromotePayload } from "../groups/graph"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { mapStorageNotFound } from "./session-errors"

export const graphHandlers = HttpApiBuilder.group(InstanceHttpApi, "graph", (handlers) =>
  Effect.gen(function* () {
    const domain = yield* GraphDomain.Service
    const plan = yield* GraphPlan.Service
    const audit = yield* GraphAudit.Service
    const sessionSvc = yield* Session.Service
    const projectSvc = yield* Project.Service
    const events = yield* EventV2Bridge.Service

    const resolveProjectFromDirectory = Effect.fn("GraphHttpApi.resolveProjectFromDirectory")(function* () {
      const routeCtx = yield* WorkspaceRouteContext
      const result = yield* projectSvc.fromDirectory(routeCtx.directory)
      return result.project.id
    })

    const resolveSession = (sessionID: string) =>
      mapStorageNotFound(sessionSvc.get(sessionID as SessionID))

    const main = Effect.fn("GraphHttpApi.main")(function* () {
      const projectID = yield* resolveProjectFromDirectory()
      const view = yield* domain.main({ projectID })
      return { nodes: view.nodes, edges: view.edges }
    })

    const currentPlan = Effect.fn("GraphHttpApi.currentPlan")(function* (ctx: {
      query: typeof SessionRequiredQuery.Type
    }) {
      const session = yield* resolveSession(ctx.query.session)
      const view = yield* domain.currentPlan({ sessionID: ctx.query.session })
      return { nodes: view.nodes, edges: view.edges }
    })

    const node = Effect.fn("GraphHttpApi.node")(function* (ctx: {
      params: { nodeID: string }
    }) {
      return yield* domain.node
        .get(ctx.params.nodeID as Graph.NodeID)
        .pipe(
          Effect.catchTag("GraphV2.NotFoundError", () =>
            Effect.fail(notFound(`Node not found: ${ctx.params.nodeID}`)),
          ),
        )
    })

    const nodeReadiness = Effect.fn("GraphHttpApi.nodeReadiness")(function* (ctx: {
      params: { nodeID: string }
      query: typeof SessionRequiredQuery.Type
    }) {
      const session = yield* resolveSession(ctx.query.session)
      const nodeID = ctx.params.nodeID as Graph.NodeID
      const sessionID = ctx.query.session

      const plan = yield* domain.currentPlan({ sessionID })
      const planNode = plan.nodes.find((n) => n.id === nodeID)

      const blockingEdges = plan.edges.filter(
        (e) => e.targetID === nodeID && e.relation === "blocks",
      )
      const blockers = blockingEdges
        .flatMap((edge) => {
          const sourceNode = plan.nodes.find((n) => n.id === edge.sourceID)
          if (!sourceNode) return []
          if (sourceNode.status === "implemented" || sourceNode.status === "verified") return []
          return [{
            nodeID: edge.sourceID,
            nodeName: sourceNode.name,
            nodeStatus: sourceNode.status,
          }]
        })

      const validationResult = yield* domain.validateSubgraph({
        projectID: session.projectID,
        sessionID,
      })

      return {
        nodeID: ctx.params.nodeID,
        status: planNode?.status ?? ("pending" as Graph.NodeStatus),
        inCurrentPlan: planNode !== undefined,
        blockers,
        validationIssues: validationResult.issues.map((issue) => ({
          rule: issue.rule,
          message: issue.message,
        })),
      }
    })

    const nodeAudit = Effect.fn("GraphHttpApi.nodeAudit")(function* (ctx: {
      params: { nodeID: string }
      query: typeof SessionOptionalQuery.Type
    }) {
      const nodeID = ctx.params.nodeID as Graph.NodeID
      let projectID: ProjectV2.ID
      let sessionID: string | undefined
      if (ctx.query.session) {
        const session = yield* resolveSession(ctx.query.session)
        projectID = session.projectID
        sessionID = ctx.query.session
      } else {
        projectID = yield* resolveProjectFromDirectory()
      }

      const [toolRuns, generationRuns] = yield* Effect.all([
        audit.tool.list({ projectID, nodeID, sessionID }),
        audit.generation.list({ projectID, nodeID, sessionID }),
      ])

      return {
        toolRuns: toolRuns.map((t) => ({
          id: t.id,
          toolName: t.toolName,
          toolType: t.toolType,
          status: t.status,
          timeCreated: t.timeCreated,
        })),
        generationRuns: generationRuns.map((g) => ({
          id: g.id,
          executor: g.executor,
          status: g.status,
          gateAllowed: g.gateResult.allowed,
          timeCreated: g.timeCreated,
        })),
      }
    })

    const versions = Effect.fn("GraphHttpApi.versions")(function* () {
      const projectID = yield* resolveProjectFromDirectory()
      const result = yield* domain.version.list({ projectID })
      return result.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        message: v.message,
        timeCreated: v.timeCreated,
      }))
    })

    const deleteNode = Effect.fn("GraphHttpApi.deleteNode")(function* (ctx: {
      params: { nodeID: string }
    }) {
      const projectID = yield* resolveProjectFromDirectory()
      yield* domain.node.delete(ctx.params.nodeID as Graph.NodeID)
      yield* events.publish(Graph.Event.PlanUpdated, { projectID })
      return true
    })

    const deleteEdge = Effect.fn("GraphHttpApi.deleteEdge")(function* (ctx: {
      params: { edgeID: string }
    }) {
      const projectID = yield* resolveProjectFromDirectory()
      yield* domain.edge.delete(ctx.params.edgeID as Graph.EdgeID)
      yield* events.publish(Graph.Event.PlanUpdated, { projectID })
      return true
    })

    const diff = Effect.fn("GraphHttpApi.diff")(function* (ctx: {
      query: typeof DiffQuery.Type
    }) {
      const routeCtx = yield* WorkspaceRouteContext
      const { project: proj } = yield* projectSvc.fromDirectory(routeCtx.directory)
      const projectID = proj.id

      const loadSide = (side: string) =>
        Effect.gen(function* () {
          if (side === "currentPlan") {
            const sessionID = ctx.query.session
            if (!sessionID) return yield* Effect.fail(new HttpApiError.BadRequest({}))
            return yield* domain.currentPlan({ sessionID })
          }
          if (side === "main") {
            return yield* domain.main({ projectID })
          }
          const match = side.match(/^version:(\d+)$/)
          if (match) {
            const version = yield* domain.version
              .get({ projectID, versionNumber: Number(match[1]) })
              .pipe(Effect.catchTag("GraphV2.NotFoundError", () => Effect.fail(new HttpApiError.BadRequest({}))))
            return {
              nodes: (version.snapshot.nodes ?? []) as any,
              edges: (version.snapshot.edges ?? []) as any,
            }
          }
          return yield* Effect.fail(new HttpApiError.BadRequest({}))
        })

      const leftView = yield* loadSide(ctx.query.left)
      const rightView = yield* loadSide(ctx.query.right)
      const result = graphDiff(leftView, rightView)

      return {
        summary: result.summary,
        nodesAdded: result.nodes.added.map((n) => n.name ?? n.id),
        nodesRemoved: result.nodes.removed.map((n) => n.name ?? n.id),
        nodesModified: result.nodes.modified.map((m) => ({ id: m.id, fields: m.fields })),
        edgesAdded: result.edges.added.length,
        edgesRemoved: result.edges.removed.length,
      }
    })

    const planAdmit = Effect.fn("GraphHttpApi.planAdmit")(function* (ctx: {
      query: typeof SessionRequiredQuery.Type
      payload: typeof PlanAdmitPayload.Type
    }) {
      const session = yield* resolveSession(ctx.query.session)
      const result = yield* plan.admit({
        projectID: session.projectID,
        sessionID: session.id,
        dryRun: ctx.payload.dryRun,
        nodes: ctx.payload.nodes,
        edges: ctx.payload.edges,
      }).pipe(
        Effect.catchTag("GraphV2.ValidationError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        Effect.catchTag("GraphV2.NotFoundError", (error) => Effect.fail(notFound(error.id))),
      )
      if (!ctx.payload.dryRun) yield* events.publish(Graph.Event.PlanUpdated, { projectID: session.projectID })
      return result
    })

    const updateNodeStatus = Effect.fn("GraphHttpApi.updateNodeStatus")(function* (ctx: {
      params: { nodeID: string }
      payload: typeof NodeStatusPayload.Type
    }) {
      const nodeID = ctx.params.nodeID as Graph.NodeID
      const projectID = yield* resolveProjectFromDirectory()
      yield* domain.node
        .update(nodeID, { status: ctx.payload.status })
        .pipe(
          Effect.catchTag("GraphV2.ValidationError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          Effect.catchTag("GraphV2.NotFoundError", () => Effect.fail(notFound(`Node not found: ${nodeID}`))),
        )
      yield* events.publish(Graph.Event.PlanUpdated, { projectID })
      return yield* domain.node.get(nodeID).pipe(
        Effect.catchTag("GraphV2.NotFoundError", () => Effect.fail(notFound(`Node not found: ${nodeID}`))),
      )
    })

    const promote = Effect.fn("GraphHttpApi.promote")(function* (ctx: {
      query: typeof SessionRequiredQuery.Type
      payload: void | typeof PromotePayload.Type
    }) {
      const session = yield* resolveSession(ctx.query.session)
      const result = yield* domain.promote({
        projectID: session.projectID,
        sessionID: session.id,
        message: ctx.payload?.message,
      })
      yield* events.publish(Graph.Event.MainUpdated, { projectID: session.projectID })
      return result
    })

    return handlers
      .handle("main", main)
      .handle("currentPlan", currentPlan)
      .handle("node", node)
      .handle("nodeReadiness", nodeReadiness)
      .handle("nodeAudit", nodeAudit)
      .handle("versions", versions)
      .handle("deleteNode", deleteNode)
      .handle("deleteEdge", deleteEdge)
      .handle("diff", diff)
      .handle("planAdmit", planAdmit)
      .handle("updateNodeStatus", updateNodeStatus)
      .handle("promote", promote)
  }),
)
