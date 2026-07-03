# Graph Read API 与 CurrentPlan 可视化（子项目 6A）— 设计 Spec

- **日期**：2026-07-03
- **状态**：已设计，待实现
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；遵循 `docs/UPSTREAM-DIVERGENCE.md`「扩展不修改」。
- **前置**：子项目 1–5 已完成并合入 `dev`：图存储、领域核心、结构派生、Plan/Build gate、graph mode 工具集成。
- **代码级真相参考**：`docs/graph-vibe/web-viz.md`，`packages/schema/src/graph.ts`，`packages/core/src/graph/`。

## 1. 目标与背景

子项目 5 让 agent 在 graph mode 下用 graph-aware 工具（plan admit / build gate / artifact apply），但用户目前没有任何可见入口观察 graph 状态。本子项目提供：

1. **Graph Read API**：通过 HTTP 端点暴露已有的 graph 查询能力（主图、CurrentPlan、节点详情、就绪度、审计历史、版本快照）。
2. **CurrentPlan 可视化面板**：在 Web 端新增一个页面，展示当前 session 的 CurrentPlan 节点/边/状态。

Autopilot 主循环（后续子项目）、Canvas 力导向图（6B）、durable generation jobs、mascot 动画均不在本子项目。

## 2. 架构决策

### 决策 1：Instance/App surface（Surface B），不改 protocol/server 包

graph API 放在 `packages/opencode/src/server/routes/instance/httpapi/`，与 `experimental`、`session` 组同层。

理由：
- graph 是 fork 专有能力，不属于上游 protocol 契约。
- `packages/protocol` 和 `packages/server` 零改动 → 上游 merge 风险为零。
- Hey-API SDK 从完整 OpenAPI spec 生成（`bun dev generate > openapi.json`），Surface B 端点自动变成 `sdk.graph.*`。
- 与子项目 5 的 graph 工具保持一致（全在 `packages/opencode` 内）。

### 决策 2：6A 只做 Read API（全部 GET），不做写 API / graph 专属 SSE

写操作（plan admit / build gate / artifact apply）已在子项目 5 通过 agent 工具落地。Web 端用 TanStack Query 轮询 + 复用既有 SSE 事件（`file.watcher.updated` / `message.updated`）触发 refetch，不新增 graph 专属推送通道。

### 决策 3：Web 面板从结构化列表/表格起步，不做 Canvas 力导向图

6A 的 Web 面板是一个 CurrentPlan 节点列表 + 状态摘要 + 节点详情的结构化视图。Canvas 力导向图渲染留给 6B。

### 决策 4：projectID 从 workspace routing context 解析

Handler 通过 `WorkspaceRoutingMiddleware` 拿到 `WorkspaceRouteContext`（提供 `{ directory, workspaceID }`），再解析 projectID。session 级端点（current-plan / readiness / audit）通过 `Session.Service.get(sessionID)` 解析 projectID，与子项目 5 graph 工具的解析路径一致。

## 3. 范围

**在本子项目内（完整实现）：**

- Graph API group 定义（端点 + response Schema + OpenApi 注解）。
- Graph API handler 实现（调用 GraphDomain / GraphAudit / GraphBuild / GraphStorage 服务）。
- Graph service LayerNode 接入 server handler runtime（当前仅在 ToolRegistry.node 中，需扩展到 handler runtime）。
- InstanceHttpApi 注册 + server.ts handler layer 提供。
- Hey-API SDK 重新生成（`./packages/sdk/js/script/build.ts`）。
- Web 面板页面（`packages/app/src/pages/graph.tsx`）+ 路由注册。
- TDD 测试：handler 级（in-memory DB + seeded graph data）、Web 面板路由/数据绑定。

**显式不在本子项目：**

- Autopilot Plan→Build→Check/Fix 循环。
- Canvas 力导向图、吉祥物动画、高亮路径 → 6B。
- Graph 专属 SSE / WebSocket 推送通道。
- 写 API（plan admit / build gate / artifact apply via HTTP）→ 已由 agent 工具覆盖。
- Protocol surface（`packages/protocol` / `packages/server`）的 graph 组。
- Effect 类型化客户端（`packages/client/src/generated-effect`）的 graph 方法 → 非本子项目消费者。

## 4. 模块设计

```
packages/opencode/src/server/routes/instance/httpapi/
  groups/graph.ts          — GraphApi HttpApiGroup 定义（端点 + response Schema + paths）
  handlers/graph.ts        — graphHandlers（调用 GraphDomain / GraphAudit 服务）
  api.ts                   — modify: add .addHttpApi(GraphApi)
  server.ts                — modify: add graphHandlers + graph service LayerNode provision

packages/opencode/src/server/routes/instance/httpapi/middleware/
  workspace-routing.ts     — no change (reuse WorkspaceRouteContext)

packages/app/src/
  pages/graph.tsx          — CurrentPlan 可视化面板页面
  app.tsx                  — modify: add <Route path="/session/:id/graph" component={GraphRoute} />
```

### 4.1 Graph API group（`groups/graph.ts`）

遵循 `experimental.ts` / `session.ts` 的模式：

```ts
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
      .add(/* endpoints */)
      .annotateMerge(OpenApi.annotations({ title: "graph", description: "Graph read API." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "opencode graph HttpApi", version: "0.0.1" }))
```

每个端点使用 `WorkspaceRoutingQueryFields`（`directory` + `workspace` optional query）保持与其它 instance 端点一致。session 级端点增加 `session: Schema.optional(Schema.String)` query param。

### 4.2 Graph API handler（`handlers/graph.ts`）

遵循 `session.ts` handler 的模式：`HttpApiBuilder.group(InstanceHttpApi, "graph", (handlers) => Effect.gen(...))`。

在 `Effect.gen` 内 yield 稳定服务一次：
- `GraphDomain.Service`（主图 / CurrentPlan / 节点详情 / 版本列表 / assessImpact / validateSubgraph）
- `GraphAudit.Service`（审计历史）
- `Session.Service`（session → projectID 解析）
- `WorkspaceRouteContext`（directory → projectID 解析）

projectID 解析策略：
- session 级端点（currentPlan / nodeReadiness / nodeAudit）：`yield* Session.Service.use(svc => svc.get(sessionID))` → `session.projectID`（与子项目 5 graph 工具一致）。
- project 级端点（main / versions）：从 `WorkspaceRouteContext.directory` 解析 projectID。实现时通过 `InstanceState` 或直接查 `ProjectTable`（`WHERE directory = ?`）拿到 `ProjectV2.ID`。具体解析路径在 TDD 实现阶段确认——复用 instance 内既有的 directory → project 解析模式。

### 4.3 Graph service LayerNode 接入

当前 graph LayerNode 接入状态：
- `registry.ts:441-444` 组合了 `GraphStorage.node`、`GraphAudit.node`、`GraphPlan.node`、`GraphBuild.node`（供 tool 执行上下文使用）。
- `GraphDomain.node`（`domain.ts:129`）存在但**不在** ToolRegistry 中——它通过 `GraphPlan.node` 的依赖链被间接提供。
- Handler 需要 `GraphDomain.Service` 直接访问（main / currentPlan / node.get / validateSubgraph / version.list），因此必须显式提供 `GraphDomain.node`。

本子项目在 server handler layer 组合处（`server.ts` 的 `instanceApiRoutes` provide 链）提供 graph service layers：`GraphDomain.node`（自带 `GraphStorage.node` 依赖）+ `GraphAudit.node`。GraphStorage 依赖 Database——Database 已在 server runtime 中提供。

实现时用 `LayerNode.compile(LayerNode.group([...]))` 或直接在 `Layer.provide([...])` 中展开 graph nodes，遵循 `server.ts` 既有组合风格。不在 `packages/core` 的 `defaultLayer` 中添加（保持「不修改 core default layer」原则）。

### 4.4 Web 面板（`packages/app/src/pages/graph.tsx`）

新增路由 `/:dir/session/:id/graph`，挂在 `DirectoryLayout` 下（与 `/:dir/session/:id?` 同级），共享全部 providers。

页面组件结构：

```
GraphRoute
├── resolve directory + sessionID from useParams()
├── createQuery: sdk.graph.currentPlan({ session: sessionID })
├── Header
│   └── CurrentPlan 摘要（节点数、边数、状态分布计数）
├── NodeList (<For>)
│   └── 每行：name、type badge、level、status dot、testStatus、priority
│       └── click → setSelectedNodeID
├── NodeDetailPanel (<Show when={selectedNodeID}>)
│   ├── createQuery: sdk.graph.node({ nodeID })
│   ├── createQuery: sdk.graph.nodeReadiness({ nodeID, session: sessionID })
│   ├── createQuery: sdk.graph.nodeAudit({ nodeID, session: sessionID })
│   └── blockers 列表 + 依赖关系 + audit 历史
└── EmptyState (<Show when={!currentPlan()?.nodes.length}>)
    └── 引导文案
```

数据获取用 TanStack Query（`createQuery`），query key 结构 `[dir, sessionID, "graph", "<endpoint>"]`。refetch 触发：复用 `sdk().event.listen` 监听 `file.watcher.updated` / `message.updated` 事件 invalidate query（与 `session.tsx` 的 VCS diff refetch 模式一致）。

UI 组件复用 `@opencode-ai/ui`（spinner、card、scroll-view 等）和 app 既有组件。状态颜色复用 `web-viz.md` §3 配色约定（pending `#ffc107`、implemented `#4caf50`、verified `#2196f3`、deprecated `#757575`），以 CSS variable 或 inline style 实现。

页面不做 graph mode flag 门控——无数据时自然显示空态。

### 4.5 SDK 重新生成

实现 API group + handler + 注册后，运行 `./packages/sdk/js/script/build.ts` 重新生成 Hey-API SDK。生成产物 `packages/sdk/js/src/v2/gen/sdk.gen.ts` 和 `types.gen.ts` 会包含 `sdk.graph.*` 命名空间。

不运行 `packages/client` 的 `bun run generate`（Surface B 不经 packages/client codegen）。

## 5. 端点规格

所有端点使用 GET 方法，query 包含 `WorkspaceRoutingQueryFields`。

| 端点名 | 路径 | path params | 额外 query | 成功响应 | 错误 |
|---|---|---|---|---|---|
| `graph.main` | `/graph/main` | — | — | `GraphViewResponse` | `InternalServerError` |
| `graph.currentPlan` | `/graph/current-plan` | — | `session: string` | `GraphViewResponse` | `BadRequest`, `ApiNotFoundError` |
| `graph.node` | `/graph/node/:nodeID` | `nodeID` | — | `GraphNodeResponse` | `BadRequest`, `ApiNotFoundError` |
| `graph.nodeReadiness` | `/graph/node/:nodeID/readiness` | `nodeID` | `session: string` | `NodeReadinessResponse` | `BadRequest`, `ApiNotFoundError` |
| `graph.nodeAudit` | `/graph/node/:nodeID/audit` | `nodeID` | `session: string`（optional） | `NodeAuditResponse` | `BadRequest`, `ApiNotFoundError` |
| `graph.versions` | `/graph/versions` | — | — | `Schema.Array(GraphVersionResponse)` | `InternalServerError` |

### 端点语义

- **main**：返回 project 主图（`session_id IS NULL` 的全部 nodes + edges）。通过 `WorkspaceRouteContext.directory` 解析 projectID，调 `GraphDomain.main({ projectID })`。
- **currentPlan**：返回 session 级 CurrentPlan（`session_id = ?` 的全部 nodes + edges）。通过 `session` query 解析 sessionID → projectID，调 `GraphDomain.currentPlan({ sessionID })`。
- **node**：返回单节点详情。调 `GraphDomain.node.get(nodeID)`。
- **nodeReadiness**：返回节点构建就绪度。不调 `GraphBuild.evaluate`（避免 audit 噪音）。组装逻辑：
  1. 通过 session query 解析 projectID + sessionID。
  2. 调 `GraphDomain.currentPlan({ sessionID })` 加载 CurrentPlan。
  3. 判断 `inCurrentPlan`：nodeID 是否在 CurrentPlan nodes 中。
  4. 查 CurrentPlan edges 中 `targetID = nodeID && relation = "blocks"` 的边，取每条边的 sourceID 节点，若 source status 不是 `implemented` 或 `verified` 则列入 blockers。
  5. 调 `GraphDomain.validateSubgraph({ projectID, sessionID })` 取 validation issues。
  6. 返回 `{ nodeID, status, inCurrentPlan, blockers, validationIssues }`。
- **nodeAudit**：返回节点的工具运行 + 生成运行历史。调 `GraphAudit.tool.list({ projectID, nodeID })` + `GraphAudit.generation.list({ projectID, nodeID })`。
- **versions**：返回 project 的版本快照列表。调 `GraphDomain.version.list({ projectID })`。

## 6. 响应 Schema

所有 response Schema 带 `identifier` 注解（Hey-API codegen 生成稳定类型名）。复用 `@opencode-ai/schema/graph` 的枚举类型。

```ts
import { Graph } from "@opencode-ai/schema"

const GraphNodeResponse = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  sessionID: Schema.String.pipe(Schema.nullable),
  type: Graph.NodeType,
  name: Schema.String,
  level: Graph.Level,
  priority: Graph.Priority.pipe(Schema.nullable),
  category: Schema.String.pipe(Schema.nullable),
  status: Graph.NodeStatus,
  desc: Schema.String.pipe(Schema.nullable),
  content: Graph.NodeContent.pipe(Schema.nullable),
  codeHash: Schema.String.pipe(Schema.nullable),
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
  message: Schema.String.pipe(Schema.nullable),
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphVersion" })

const NodeBlocker = Schema.Struct({
  nodeID: Schema.String,
  nodeName: Schema.String,
  nodeStatus: Graph.NodeStatus,
}).annotate({ identifier: "GraphNodeBlocker" })

const NodeReadinessResponse = Schema.Struct({
  nodeID: Schema.String,
  status: Graph.NodeStatus,
  inCurrentPlan: Schema.Boolean,
  blockers: Schema.Array(NodeBlocker),
  validationIssues: Schema.Array(Schema.Struct({
    rule: Schema.String,
    message: Schema.String,
  })),
}).annotate({ identifier: "GraphNodeReadiness" })

const ToolRunResponse = Schema.Struct({
  id: Schema.String,
  toolName: Schema.String,
  toolType: Schema.String,
  status: Schema.String,
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphToolRun" })

const GenerationRunResponse = Schema.Struct({
  id: Schema.String,
  executor: Schema.String,
  status: Schema.String,
  gateAllowed: Schema.Boolean,
  timeCreated: Schema.Number,
}).annotate({ identifier: "GraphGenerationRun" })

const NodeAuditResponse = Schema.Struct({
  toolRuns: Schema.Array(ToolRunResponse),
  generationRuns: Schema.Array(GenerationRunResponse),
}).annotate({ identifier: "GraphNodeAudit" })
```

## 7. 错误处理

- **projectID 解析失败**：返回 `HttpApiError.InternalServerError`（不应该发生——workspace routing 保证 directory 存在）。
- **session 不存在**：返回 `ApiNotFoundError`（复用 `errors.ts` 的 `ApiNotFoundError`）。
- **node 不存在**：返回 `ApiNotFoundError`。`GraphDomain.node.get` 的 `NotFoundError` 在 handler 边界翻译为 `ApiNotFoundError`。
- **graph 服务 defect**：不捕获，让 Effect runtime 的 defect 处理器返回 500。
- **空 CurrentPlan**：返回 `GraphViewResponse` with empty arrays（不是错误）。
- **graph mode 关闭时**：API 仍可访问（端点不做 flag 门控）。无数据时返回空结果。

Handler 不在请求级别 `Effect.provide(SomeLayer)`（遵循 httpapi AGENTS.md）。所有 graph service layers 在 layer 边界一次性提供。

## 8. 测试策略

### Handler 级测试（`packages/opencode/test/server/`）

新增 `test/server/graph-api.test.ts`：
- 使用 `Database.layerFromPath(":memory:")` 提供内存 DB。
- Seed `ProjectTable` + `SessionTable` + graph nodes/edges（main + session-scoped）。
- 初始化 graph handler layer + graph service layers。
- 测试每个端点：
  - `main`：返回 project 主图 nodes + edges。
  - `currentPlan`：返回 session 级 CurrentPlan。
  - `node`：返回单节点详情；不存在时返回 `ApiNotFoundError`。
  - `nodeReadiness`：返回 blockers（有 `blocks` 边且 source 未 implemented 时）+ validation issues。
  - `nodeAudit`：返回 tool runs + generation runs。
  - `versions`：返回版本列表。
- 测试空态：无 CurrentPlan 时返回 empty arrays。

### Web 面板测试

遵循 `packages/app` 的 `test-browser/` 模式（如果存在 graph 相关的 browser test 基础设施），或最小化路由渲染测试。如果 app 包没有合适的 browser test 基础设施来测 graph 面板，则跳过 Web 测试，仅手动验证。

### 运行命令

- Handler tests: `cd packages/opencode && bun test test/server/graph-api.test.ts`
- Core safety: `cd packages/core && bun typecheck && bun test test/graph-*.test.ts`
- Typecheck: `cd packages/opencode && bun typecheck`

## 9. 成功标准

- 6 个 graph read 端点可通过 HTTP 访问，返回正确数据。
- Hey-API SDK 重新生成后包含 `sdk.graph.*` 命名空间。
- Web 端 `/session/:id/graph` 页面渲染 CurrentPlan 节点列表 + 状态 + 详情。
- 默认 opencode 行为不变（graph API 不影响现有端点）。
- `packages/protocol` 和 `packages/server` 零改动。
- Handler 测试全部通过。
- Typecheck 全部通过。
- `docs/UPSTREAM-DIVERGENCE.md` 不需要新增分叉登记（改动全在 `packages/opencode` 和 `packages/app` 内的新文件 + composition 行）。

## 10. UPSTREAM-DIVERGENCE 影响

- `packages/opencode/src/server/routes/instance/httpapi/api.ts`：+1 行 `.addHttpApi(GraphApi)`。这是 composition 行，非逻辑修改。上游重构该文件时需检查。
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`：graph handler + service layer provision。同上。
- `packages/app/src/app.tsx`：+1 行 `<Route>` 注册。同上。
- 其余全部为新文件。

以上 3 处 composition 行在每次 upstream merge 时检查是否仍 apply 即可。不登记在 §2 分叉表（不是对 opencode 原文件逻辑的修改，只是 additive composition）。
