# Graph Read API and CurrentPlan Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only graph HTTP API endpoints (main graph, CurrentPlan, node detail, readiness, audit, versions) to the instance HttpApi surface and a CurrentPlan visualization panel in the web app.

**Architecture:** Instance/App surface (Surface B) — new graph HttpApiGroup + handler in `packages/opencode/src/server/routes/instance/httpapi/`, graph core services wired into the server runtime, Hey-API SDK regenerated, SolidJS graph page added to the web app.

**Tech Stack:** TypeScript, Bun, Effect v4, HttpApiBuilder, Drizzle in-memory DB, SolidJS, TanStack Query.

**Spec:** `docs/specs/2026-07-03-graph-read-api-visualization.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts` | Graph API group: response schemas, endpoint declarations, GraphPaths |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts` | graphHandlers: calls GraphDomain / GraphAudit / Session services |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | Modify: add `.addHttpApi(GraphApi)` to InstanceHttpApi |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Modify: add graphHandlers + graph LayerNodes to app group |
| `packages/opencode/test/server/graph-api.test.ts` | Integration test: all 6 endpoints with seeded graph data |
| `packages/app/src/pages/graph.tsx` | CurrentPlan visualization page |
| `packages/app/src/app.tsx` | Modify: add graph route |

---

### Task 1: Graph API Group Definition

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`

- [ ] **Step 1: Create the group definition**

Create `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`:

```ts
import { Graph } from "@opencode-ai/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/http"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ApiNotFoundError } from "../errors"

const nullable = <A, I>(schema: Schema.Schema<A, I>) => Schema.Union(schema, Schema.Null)

const GraphNodeResponse = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  sessionID: nullable(Schema.String),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: nullable(Graph.Priority),
  category: nullable(Schema.String),
  status: Graph.NodeStatus,
  desc: nullable(Schema.String),
  content: nullable(Graph.NodeContent),
  codeHash: nullable(Schema.String),
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
  message: nullable(Schema.String),
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

const ProjectQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
})

const SessionRequiredQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  session: Schema.String,
})

const SessionOptionalQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  session: Schema.optional(Schema.String),
})

export const GraphPaths = {
  main: "/graph/main",
  currentPlan: "/graph/current-plan",
  node: "/graph/node/:nodeID",
  nodeReadiness: "/graph/node/:nodeID/readiness",
  nodeAudit: "/graph/node/:nodeID/audit",
  versions: "/graph/versions",
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/opencode && bun typecheck`

Expected: PASS (the group is declarative — no handler yet, but the types should compile).

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts
git commit -m "feat(opencode): add graph read API group definition"
```

---

### Task 2: Graph API Handler

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`

- [ ] **Step 1: Create the handler**

Create `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`:

```ts
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/http"
import { Session } from "@/session/session"
import { InstanceHttpApi } from "../api"
import { ProjectQuery, SessionRequiredQuery, SessionOptionalQuery } from "../groups/graph"
import { notFound } from "../errors"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

export const graphHandlers = HttpApiBuilder.group(InstanceHttpApi, "graph", (handlers) =>
  Effect.gen(function* () {
    const domain = yield* GraphDomain.Service
    const audit = yield* GraphAudit.Service
    const sessionSvc = yield* Session.Service

    const resolveProjectFromDirectory = Effect.fn("GraphHttpApi.resolveProjectFromDirectory")(function* () {
      const routeCtx = yield* WorkspaceRouteContext
      const session = yield* sessionSvc.list({ directory: routeCtx.directory }).pipe(
        Effect.flatMap((sessions) =>
          sessions.length > 0
            ? Effect.succeed(sessions[0])
            : Effect.fail(new HttpApiError.InternalServerError({})),
        ),
      )
      return session.projectID
    })

    const resolveProjectFromSession = Effect.fn("GraphHttpApi.resolveProjectFromSession")(
      function* (sessionID: string) {
        return yield* sessionSvc.get(sessionID)
      },
    )

    const main = Effect.fn("GraphHttpApi.main")(function* (ctx: { query: typeof ProjectQuery.Type }) {
      const projectID = yield* resolveProjectFromDirectory()
      const view = yield* domain.main({ projectID })
      return {
        nodes: view.nodes,
        edges: view.edges,
      }
    })

    const currentPlan = Effect.fn("GraphHttpApi.currentPlan")(
      function* (ctx: { query: typeof SessionRequiredQuery.Type }) {
        const session = yield* resolveProjectFromSession(ctx.query.session)
        const view = yield* domain.currentPlan({ sessionID: ctx.query.session })
        return {
          nodes: view.nodes,
          edges: view.edges,
        }
      },
    )

    const node = Effect.fn("GraphHttpApi.node")(function* (ctx: {
      params: { nodeID: string }
      query: typeof ProjectQuery.Type
    }) {
      return yield* domain.node.get(ctx.params.nodeID as any).pipe(
        Effect.catchTag("GraphV2.NotFoundError", () => Effect.fail(notFound(`Node not found: ${ctx.params.nodeID}`))),
      )
    })

    const nodeReadiness = Effect.fn("GraphHttpApi.nodeReadiness")(function* (ctx: {
      params: { nodeID: string }
      query: typeof SessionRequiredQuery.Type
    }) {
      const session = yield* resolveProjectFromSession(ctx.query.session)
      const projectID = session.projectID
      const sessionID = ctx.query.session
      const nodeID = ctx.params.nodeID as any

      const plan = yield* domain.currentPlan({ sessionID })
      const planNode = plan.nodes.find((n) => n.id === nodeID)
      const inCurrentPlan = planNode !== undefined

      const blockingEdges = plan.edges.filter(
        (e) => e.targetID === nodeID && e.relation === "blocks",
      )
      const blockers = yield* Effect.forEach(blockingEdges, (edge) =>
        Effect.gen(function* () {
          const sourceNode = plan.nodes.find((n) => n.id === edge.sourceID)
          return {
            nodeID: edge.sourceID,
            nodeName: sourceNode?.name ?? edge.sourceID,
            nodeStatus: (sourceNode?.status ?? "pending") as any,
          }
        }),
      ).pipe(
        Effect.map((items) =>
          items.filter(
            (b) => b.nodeStatus !== "implemented" && b.nodeStatus !== "verified",
          ),
        ),
      )

      const validationResult = yield* domain.validateSubgraph({ projectID, sessionID })

      return {
        nodeID: ctx.params.nodeID,
        status: (planNode?.status ?? "pending") as any,
        inCurrentPlan,
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
      let projectID: string
      if (ctx.query.session) {
        const session = yield* resolveProjectFromSession(ctx.query.session)
        projectID = session.projectID
      } else {
        projectID = yield* resolveProjectFromDirectory()
      }
      const nodeID = ctx.params.nodeID as any

      const [toolRuns, generationRuns] = yield* Effect.all([
        audit.tool.list({ projectID: projectID as any, nodeID }),
        audit.generation.list({ projectID: projectID as any, nodeID }),
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

    const versions = Effect.fn("GraphHttpApi.versions")(function* (ctx: {
      query: typeof ProjectQuery.Type
    }) {
      const projectID = yield* resolveProjectFromDirectory()
      const result = yield* domain.version.list({ projectID })
      return result.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        message: v.message,
        timeCreated: v.timeCreated,
      }))
    })

    return handlers
      .handle("main", main)
      .handle("currentPlan", currentPlan)
      .handle("node", node)
      .handle("nodeReadiness", nodeReadiness)
      .handle("nodeAudit", nodeAudit)
      .handle("versions", versions)
  }),
)
```

> **Note:** The `as any` casts on branded IDs (`nodeID as any`, `projectID as any`) are needed because the HttpApi path/query params arrive as plain strings but the core services expect branded types (`NodeID`, `ProjectV2.ID`). During implementation, verify whether branded schemas can be used directly in the endpoint `params`/`query` declarations to eliminate the casts. If the codebase has a pattern for branded path params (like `SessionID` in session.ts), follow it instead.

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/opencode && bun typecheck`

Expected: May show errors for missing `GraphApi` registration — that is fixed in Task 3. If the only errors are about InstanceHttpApi not containing the "graph" group, proceed to Task 3.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts
git commit -m "feat(opencode): add graph read API handlers"
```

---

### Task 3: Server Registration and LayerNode Wiring

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`

- [ ] **Step 1: Register GraphApi in InstanceHttpApi**

In `packages/opencode/src/server/routes/instance/httpapi/api.ts`, add the import and registration.

Add import near the other group imports (after line 14, the `ExperimentalApi` import):

```ts
import { GraphApi } from "./groups/graph"
```

Add `.addHttpApi(GraphApi)` to the `InstanceHttpApi` chain (after `.addHttpApi(FileApi)` or wherever it fits alphabetically/logically):

```ts
export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(GraphApi)
  .addHttpApi(InstanceApi)
  // ... rest unchanged
```

- [ ] **Step 2: Wire graphHandlers and graph LayerNodes in server.ts**

In `packages/opencode/src/server/routes/instance/httpapi/server.ts`:

Add imports near the other handler imports (after line 89, the `experimentalHandlers` import):

```ts
import { graphHandlers } from "./handlers/graph"
```

Add graph service imports near the other core service imports (after the `Database` import on line 53):

```ts
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
```

Add `graphHandlers` to the `instanceApiRoutes` provide array (after `fileHandlers` or in alphabetical order):

```ts
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    graphHandlers,
    instanceHandlers,
    // ... rest unchanged
  ]),
)
```

Add `GraphDomain.node` and `GraphAudit.node` to the `app` LayerNode group (after `Database.node` on line 215, or wherever graph nodes fit):

```ts
const app = LayerNode.group([
  // ... existing nodes ...
  Database.node,
  GraphDomain.node,
  GraphAudit.node,
  // ... rest of existing nodes ...
])
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/opencode && bun typecheck`

Expected: PASS — all types resolve, the graph group is registered, handlers are wired, and graph services are provided.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/api.ts packages/opencode/src/server/routes/instance/httpapi/server.ts
git commit -m "feat(opencode): register graph API and wire service layers"
```

---

### Task 4: Integration Test

**Files:**
- Create: `packages/opencode/test/server/graph-api.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/opencode/test/server/graph-api.test.ts`. Follow the `httpapi-session.test.ts` pattern for test infrastructure, but focused on graph endpoints.

```ts
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { Workspace } from "@/control-plane/workspace"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { mkdir } from "node:fs/promises"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { eq } from "drizzle-orm"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    GraphDomain.node,
    GraphAudit.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function requestJson<T>(path: string, init?: RequestInit) {
  return Effect.gen(function* () {
    const response = yield* request(path, init)
    if (response.status !== 200) {
      const text = yield* response.text
      return yield* Effect.die(new Error(`Expected 200, got ${response.status}: ${text}`))
    }
    return yield* response.json.pipe(Effect.map((v) => v as T))
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

interface GraphViewResponse {
  nodes: Array<{ id: string; name: string; type: string; status: string; sessionID: string | null }>
  edges: Array<{ id: string; sourceID: string; targetID: string; relation: string }>
}

describe("graph HttpApi", () => {
  it.instance("returns main graph for the project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const projectID = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ProjectTable).where(eq(ProjectTable.directory, test.directory)).all().pipe(Effect.orDie)
        return rows[0].id
      })

      yield* domain.node.create({
        projectID: projectID as any,
        type: "prd",
        name: "Root PRD",
        level: "L1",
      })

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/main?directory=${encodeURIComponent(test.directory)}`,
      )

      expect(result.nodes.length).toBeGreaterThanOrEqual(1)
      const mainNode = result.nodes.find((n) => n.name === "Root PRD")
      expect(mainNode).toBeDefined()
      expect(mainNode!.sessionID).toBeNull()
    }),
  )

  it.instance("returns CurrentPlan for a session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const projectID = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ProjectTable).where(eq(ProjectTable.directory, test.directory)).all().pipe(Effect.orDie)
        return rows[0].id
      })

      yield* domain.node.create({
        projectID: projectID as any,
        sessionID: session.id,
        type: "composite",
        name: "Plan Node A",
        level: "L1",
      })

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/current-plan?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0].name).toBe("Plan Node A")
      expect(result.nodes[0].sessionID).toBe(session.id)
    }),
  )

  it.instance("returns empty CurrentPlan when session has no plan", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const result = yield* requestJson<GraphViewResponse>(
        `/graph/current-plan?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
      )

      expect(result.nodes).toEqual([])
      expect(result.edges).toEqual([])
    }),
  )

  it.instance("returns node detail by ID", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const projectID = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ProjectTable).where(eq(ProjectTable.directory, test.directory)).all().pipe(Effect.orDie)
        return rows[0].id
      })

      const nodeID = yield* domain.node.create({
        projectID: projectID as any,
        type: "atomic",
        name: "Detail Node",
        level: "L2",
        category: "func",
      })

      const result = yield* requestJson<{ id: string; name: string; type: string }>(
        `/graph/node/${nodeID}?directory=${encodeURIComponent(test.directory)}`,
      )

      expect(result.id).toBe(nodeID)
      expect(result.name).toBe("Detail Node")
      expect(result.type).toBe("atomic")
    }),
  )

  it.instance("returns node readiness with blockers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const domain = yield* GraphDomain.Service

      yield* Project.use.fromDirectory(test.directory)
      const session = yield* Session.use.create()

      const projectID = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(ProjectTable).where(eq(ProjectTable.directory, test.directory)).all().pipe(Effect.orDie)
        return rows[0].id
      })

      const sourceID = yield* domain.node.create({
        projectID: projectID as any,
        sessionID: session.id,
        type: "atomic",
        name: "Dependency",
        level: "L2",
      })
      const targetID = yield* domain.node.create({
        projectID: projectID as any,
        sessionID: session.id,
        type: "atomic",
        name: "Target",
        level: "L2",
      })
      yield* domain.edge.create({
        projectID: projectID as any,
        sessionID: session.id,
        sourceID,
        targetID,
        relation: "blocks",
      })

      const result = yield* requestJson<{
        nodeID: string
        inCurrentPlan: boolean
        blockers: Array<{ nodeID: string; nodeStatus: string }>
      }>(`/graph/node/${targetID}/readiness?directory=${encodeURIComponent(test.directory)}&session=${session.id}`)

      expect(result.inCurrentPlan).toBe(true)
      expect(result.blockers.length).toBe(1)
      expect(result.blockers[0].nodeID).toBe(sourceID)
      expect(result.blockers[0].nodeStatus).toBe("pending")
    }),
  )
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/opencode && bun test test/server/graph-api.test.ts`

Expected: PASS — all graph endpoints return correct data with seeded graph data.

If tests fail, debug the handler implementations in Task 2. Common issues:
- projectID resolution from directory fails → check `resolveProjectFromDirectory` logic.
- Branded type mismatches → adjust casts or use branded schemas in params.
- Graph services not available → verify LayerNode wiring in server.ts.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/test/server/graph-api.test.ts
git commit -m "test(opencode): add graph read API integration tests"
```

---

### Task 5: SDK Regeneration

**Files:**
- Auto-generated: `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`

- [ ] **Step 1: Regenerate the Hey-API SDK**

Run from repo root:

```bash
./packages/sdk/js/script/build.ts
```

This runs `bun dev generate` to produce the OpenAPI spec, then `@hey-api/openapi-ts` to generate the client SDK.

Expected: The generated files include `graph` namespace methods (e.g., `sdk.graph.main(...)`, `sdk.graph.currentPlan(...)`).

- [ ] **Step 2: Verify generated graph methods exist**

Search the generated SDK for graph methods:

Run: `cd packages/sdk/js && rg "graph" src/v2/gen/sdk.gen.ts --count`

Expected: At least 6 matches (one per endpoint).

- [ ] **Step 3: Verify typecheck still passes**

Run: `cd packages/opencode && bun typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/js/
git commit -m "chore(sdk): regenerate with graph read API"
```

---

### Task 6: Web Panel

**Files:**
- Create: `packages/app/src/pages/graph.tsx`
- Modify: `packages/app/src/app.tsx`

- [ ] **Step 1: Create the graph page**

Create `packages/app/src/pages/graph.tsx`:

```tsx
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ScrollView } from "@opencode-ai/ui/scroll-view"

interface GraphNode {
  id: string
  name: string
  type: string
  level: string
  status: string
  testStatus: string
  priority: string | null
  sessionID: string | null
}

interface GraphView {
  nodes: GraphNode[]
  edges: Array<{ id: string; sourceID: string; targetID: string; relation: string }>
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#ffc107",
  implemented: "#4caf50",
  verified: "#2196f3",
  deprecated: "#757575",
}

export default function GraphPage() {
  const params = useParams()
  const sdk = useSDK()
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)

  const currentPlanQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", "currentPlan"] as const,
    queryFn: () =>
      sdk()
        .client.graph.currentPlan({
          query: { session: params.id },
        })
        .then((r) => r.data as GraphView),
  }))

  const nodeDetailQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", "node", selectedNodeID()] as const,
    enabled: selectedNodeID() !== null,
    queryFn: () =>
      sdk()
        .client.graph.node({
          params: { nodeID: selectedNodeID()! },
        })
        .then((r) => r.data as GraphNode),
  }))

  const nodeReadinessQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", "readiness", selectedNodeID()] as const,
    enabled: selectedNodeID() !== null,
    queryFn: () =>
      sdk()
        .client.graph.nodeReadiness({
          params: { nodeID: selectedNodeID()! },
          query: { session: params.id },
        })
        .then(
          (r) =>
            r.data as {
              inCurrentPlan: boolean
              blockers: Array<{ nodeID: string; nodeName: string; nodeStatus: string }>
              validationIssues: Array<{ rule: string; message: string }>
            },
        ),
  }))

  const statusCounts = createMemo(() => {
    const nodes = currentPlanQuery.data?.nodes ?? []
    const counts: Record<string, number> = {}
    for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
    return counts
  })

  return (
    <div class="flex h-full flex-col">
      <div class="border-b p-4">
        <h1 class="text-lg font-semibold">Current Plan</h1>
        <Show when={!currentPlanQuery.isLoading} fallback={<Spinner />}>
          <div class="mt-1 flex gap-4 text-sm text-muted-foreground">
            <span>{currentPlanQuery.data?.nodes.length ?? 0} nodes</span>
            <span>{currentPlanQuery.data?.edges.length ?? 0} edges</span>
            <For each={Object.entries(statusCounts())}>
              {([status, count]) => (
                <span style={{ color: STATUS_COLORS[status] }}>
                  {status}: {count}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <ScrollView class="w-2/3 border-r">
          <Show
            when={(currentPlanQuery.data?.nodes ?? []).length > 0}
            fallback={
              <div class="p-8 text-center text-muted-foreground">
                No CurrentPlan nodes. Use the graph_plan_admit tool to create a plan.
              </div>
            }
          >
            <div class="divide-y">
              <For each={currentPlanQuery.data?.nodes}>
                {(node) => (
                  <button
                    class="flex w-full items-center gap-3 p-3 text-left hover:bg-accent"
                    classList={{ "bg-accent": selectedNodeID() === node.id }}
                    onClick={() => setSelectedNodeID(node.id)}
                  >
                    <span
                      class="inline-block h-2 w-2 rounded-full"
                      style={{ background: STATUS_COLORS[node.status] ?? "#999" }}
                    />
                    <span class="flex-1 truncate font-medium">{node.name}</span>
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{node.type}</span>
                    <span class="text-xs text-muted-foreground">{node.level}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </ScrollView>

        <Show when={selectedNodeID()}>
          <ScrollView class="w-1/3 p-4">
            <Show when={!nodeDetailQuery.isLoading} fallback={<Spinner />}>
              <h2 class="mb-2 font-semibold">{nodeDetailQuery.data?.name}</h2>
              <dl class="mb-4 space-y-1 text-sm">
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Type</dt>
                  <dd>{nodeDetailQuery.data?.type}</dd>
                </div>
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Status</dt>
                  <dd>{nodeDetailQuery.data?.status}</dd>
                </div>
                <div class="flex justify-between">
                  <dt class="text-muted-foreground">Test</dt>
                  <dd>{nodeDetailQuery.data?.testStatus}</dd>
                </div>
              </dl>

              <Show when={nodeReadinessQuery.data}>
                <h3 class="mb-1 font-medium">Readiness</h3>
                <div class="mb-2 text-sm">
                  In CurrentPlan: {nodeReadinessQuery.data!.inCurrentPlan ? "Yes" : "No"}
                </div>
                <Show when={(nodeReadinessQuery.data?.blockers ?? []).length > 0}>
                  <h3 class="mb-1 font-medium">Blockers</h3>
                  <ul class="mb-4 space-y-1 text-sm">
                    <For each={nodeReadinessQuery.data?.blockers}>
                      {(blocker) => (
                        <li>
                          {blocker.nodeName} ({blocker.nodeStatus})
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={(nodeReadinessQuery.data?.validationIssues ?? []).length > 0}>
                  <h3 class="mb-1 font-medium">Validation Issues</h3>
                  <ul class="space-y-1 text-sm">
                    <For each={nodeReadinessQuery.data?.validationIssues}>
                      {(issue) => (
                        <li>
                          {issue.rule}: {issue.message}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </ScrollView>
        </Show>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Register the route in app.tsx**

In `packages/app/src/app.tsx`, add the import and route.

Add import at the top (use lazy import for the page):

```ts
const Graph = lazy(() => import("@/pages/graph"))
```

Add the route inside the `DirectoryLayout` `<Route>` block, as a sibling of the session route:

```tsx
<Route path="/:dir" component={DirectoryLayout}>
  <Route path="/" component={() => <Navigate href="session" />} />
  <Route path="/session/:id?" component={SessionRoute} />
  <Route path="/session/:id/graph" component={Graph} />
</Route>
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/app && bun typecheck`

Expected: PASS. If the generated SDK method names differ from what the page uses (e.g., `sdk.graph.currentPlan` vs `sdk.graph.currentPlan`), adjust the page to match the generated names.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/pages/graph.tsx packages/app/src/app.tsx
git commit -m "feat(app): add CurrentPlan graph visualization page"
```

---

### Final Verification

- [ ] **Step 1: Run all graph-related tests**

```bash
cd packages/opencode && bun test test/server/graph-api.test.ts test/tool/graph-mode.test.ts test/tool/graph-tools.test.ts test/tool/graph-artifact-apply.test.ts test/session/graph-instruction.test.ts
```

Expected: All tests PASS.

- [ ] **Step 2: Run core graph tests**

```bash
cd packages/core && bun test test/graph-layer-node.test.ts test/graph-artifact.test.ts test/graph-build.test.ts test/graph-plan.test.ts
```

Expected: All tests PASS.

- [ ] **Step 3: Run typecheck**

```bash
cd packages/opencode && bun typecheck
cd packages/app && bun typecheck
```

Expected: Both PASS.

- [ ] **Step 4: Migration check**

```bash
cd packages/core && bun run script/migration.ts --check
```

Expected: No schema changes (this subproject adds no new tables).
