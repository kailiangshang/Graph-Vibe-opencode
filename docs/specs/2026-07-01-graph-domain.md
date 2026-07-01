# 图领域核心（子项目 2）— 设计 Spec

- **日期**：2026-07-01
- **状态**：已 brainstorm，待评审 → writing-plans
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；遵循 `docs/UPSTREAM-DIVERGENCE.md`「扩展不修改」；**原则 6：无 MVP、完整生产级实现**。
- **前置**：子项目 1（图存储地基）已完成并合入 `dev`。`GraphStorage.Service`（node/edge CRUD、main/currentPlan、promote、version）+ 3 张表（graph_node/graph_edge/graph_version）已就绪。
- **代码级真相参考**：`docs/graph-vibe/domain.md` §3–8、`docs/graph-vibe/data-model.md` §1–2。

## 1. 目标与背景

在存储层之上构建图的**领域逻辑层**：校验、冲突检测、影响评估、图遍历。这些是纯图算法，从 graph-vibe-coding 的 Go 实现移植为 TS，采用代码级真相（边类型矩阵、冲突 5 类、影响走全关系、风险阈值），修正旧代码的割裂与 quirk。

领域层是 Plan/Build 工作流（子项目 4）、AI 层（子项目 5）、可视化（子项目 6）的共同基础——它们都需要"这张图合法吗？""合并会冲突吗？""改这个节点影响多大？"的答案。

## 2. 架构决策（brainstorm 已定）

### 决策 1：领域层纯函数，策略上移

`detectConflicts`、`validateSubgraph`、`assessImpact` 是**纯查询**，返回数据。`promote`（存储原语）只搬数据。**是否因冲突/校验失败而阻断合并是调用方的策略决定**（子项目 4 Build gate 硬阻断；合并时不阻断）。

严格遵循原则 3（"Hard-block only at the CurrentPlan Build gate"）。修复旧代码的割裂——`detectConflicts` 是可靠的 first-class 操作，可被任意流程组合。

### 决策 2：双层防御校验

- **写入时**（领域服务包装器）：结构完整性——自环禁止、边端点必须存在且同一 session scope、字段级合法性（confidence 范围）、边类型矩阵。
- **合并时**（`validateSubgraph`）：全量语义——边类型矩阵（复核）、环检测、名称唯一（跨 session）。

写入时即时拦截给 AI agent 反馈（原则 5 runtime gate）；环检测/名称唯一需全图上下文，批量在合并时做。

### 决策 3：全量边类型矩阵（含 imported-code）

边类型校验包含 imported-code 特殊规则 + `isImportedCodeNode` 检测。子项目 3 的 importer 产生的节点立即可校验。规则本身是已明确 spec（data-model.md §2），不投机。

### 决策 4：混合架构（纯内核 + Effect 封装）

算法核心是纯函数（`NodeRow[]`/`EdgeRow[]` 输入，无需 DB 即可 TDD）。`GraphDomain.Service`（Effect Service）负责加载图数据 + 委托纯函数 + 写入时校验包装。符合 AGENTS.md 风格指南（"同步校验/option 构建保持同步"）。

## 3. 范围

**在本子项目内（完整实现）：**

- 校验（validation）：节点规则、边类型矩阵（全量含 imported-code）、自环禁止、环检测、名称唯一、validateSubgraph。
- 冲突检测（conflict）：5 类冲突、nodesEqual 修复、4 趟检测流程。
- 影响评估（impact）：direct/indirect/upstream/downstream、风险阈值。
- 图遍历（traversal）：BFS/DFS、findPath、extractSubgraph、detectCycle。
- 领域服务（domain）：Effect Service，写入校验包装 + 查询委托。

**显式不在本子项目（属其它层）：**

- 同步/一致性检测、tree-sitter 派生、软和解 → **子项目 3**。
- Plan/Build 工作流、gated 工具运行时、审计表 → **子项目 4/5**。
- 可视化 → **子项目 6**。
- 版本 diff/回滚 → 存储层已有 `version.list/get`；diff/rollback 后续补，不阻塞。
- 自动冲突解决（旧代码 `AutoResolve` 基本是空操作）→ 不实现。

**不新增表/migration**：复用子项目 1 的 3 张表，纯逻辑层。

## 4. 模块设计

文件位于 `packages/core/src/graph/`（纯新增）：

```
storage.ts        (已有) 原始 CRUD，无校验
traversal.ts      (新) 纯: bfs/dfs/findPath/extractSubgraph/detectCycle
validation.ts     (新) 纯: validateNode/validateEdge/checkNameUnique/validateSubgraph/isImportedCodeNode
conflict.ts       (新) 纯: detectConflicts(5类)/nodesEqual
impact.ts         (新) 纯: assessImpact/calculateRisk
domain.ts         (新) Effect: GraphDomain.Service
```

### 4.1 图遍历 `traversal.ts`（纯函数）

domain.md §7 的代码级真相。

| 函数 | 签名 | 行为 |
|---|---|---|
| `bfs` | `(startIDs: NodeID[], edges: EdgeRow[], opts?: { maxDepth?: number; relation?: EdgeRelation }) => NodeID[]` | 前向 BFS（source→target）；`maxDepth=0` 或负数 = 无限；`relation` 过滤 |
| `dfs` | 同上 | DFS 版本，语义相同 |
| `findPath` | `(sourceID: NodeID, targetID: NodeID, edges: EdgeRow[]) => NodeID[] \| null` | BFS 最短路，返回 ID 路径；不可达返回 null |
| `extractSubgraph` | `(nodeIDs: Set<NodeID>, nodes: NodeRow[], edges: EdgeRow[]) => GraphView` | 诱导子图：两端点都在集合内的边 |
| `detectCycle` | `(nodes: NodeRow[], edges: EdgeRow[]) => NodeID[] \| null` | DFS + 递归栈；relation 无关；返回第一个发现的环路径；无环返回 null |

约定：
- 所有遍历 **仅前向**（source→target）；upstream 靠传入反向边或单独深度-1 入边扫描。
- 所有遍历 **visited 守卫**，环安全。
- `bfs`/`dfs` 返回**新到达的节点**（不含 startIDs 本身，除非自环边到达）。

### 4.2 校验 `validation.ts`（纯函数）

domain.md §6 + data-model.md §2 的代码级真相。

#### 4.2.1 imported-code 检测

```ts
function isImportedCodeNode(node: NodeRow): boolean
```

返回 true 当且仅当：
- `node.category ∈ {"package", "file", "func", "method", "type", "const", "var"}`，
- 或 `node.content` 同时含 `"project_type"` 和 `"module"` 键。

#### 4.2.2 节点校验 `validateNode`

```ts
function validateNode(node: NodeRow): ValidationIssue[]
```

| 规则 | 检查 |
|---|---|
| confidence 范围 | `0 <= node.confidence <= 1`，否则 issue `{rule: "node.confidence_range"}` |

> type/level/priority/status 枚举已由 Schema 层（`Schema.Literals`）在写入时强制。confidence 范围是纯函数补充（Schema 层未限制）。

#### 4.2.3 边类型矩阵 `validateEdge`

```ts
function validateEdge(source: NodeRow, target: NodeRow, edge: EdgeRow): ValidationIssue[]
```

**前置（所有 relation）**：自环禁止——`edge.sourceID === edge.targetID` → `{rule: "edge.self_loop"}`。

**按 relation 校验**（非法 → `{rule: "edge.type_matrix", message: <具体原因>}`）：

| relation | 普通节点规则（两端都非 imported-code） | imported-code 规则（至少一端 imported-code） |
|---|---|---|
| `contains` | `source.type === target.type && source.level === "L1" && target.level === "L2"` | 类型链：`(prd→composite)` 或 `(composite→atomic)` 或 `(atomic→atomic)`，至少一端 `isImportedCodeNode` |
| `blocks` | `source.type === target.type && source.level === target.level` | —（同规则） |
| `addresses` | `source.type === "composite" && target.type === "prd" && source.level === "L2" && target.level === "L2"` | —（同规则） |
| `uses` | `source.type === "composite" && target.type === "atomic" && source.level === "L2" && target.level === "L2"` | package↔package、file↔file、decl↔decl（两端都 imported-code，双边 L2） |
| `deprecated_by` | `source.type === target.type && source.level === target.level` | —（同规则） |

> imported-code `contains` 链说明：允许 prd→composite、composite→atomic、atomic→atomic 的类型递进，前提是至少一端为 imported-code 节点。这对应 data-model.md §2 的 `prd(L1)→composite(package) / composite(package)→atomic(file) / atomic(file)→atomic(decl)` 链。

#### 4.2.4 名称唯一 `checkNameUnique`

```ts
function checkNameUnique(node: NodeRow, allNodes: NodeRow[]): ValidationIssue[]
```

同 `(type, level)` 内 `name` 不重复。违反 → `{rule: "node.name_not_unique"}`。

#### 4.2.5 子图校验 `validateSubgraph`

```ts
function validateSubgraph(nodes: NodeRow[], edges: EdgeRow[]): ValidationIssue[]
```

流程（domain.md §6，**错误不短路，全部收集**）：

1. 逐节点 `validateNode` → 收集 issues
2. 逐边：查 source/target 节点 → `validateEdge` → 收集 issues
3. 边端点必须在子图节点集内 → 否则 `{rule: "edge.dangling_endpoint"}`
4. 环检测 `detectCycle(mergedNodes, mergedEdges)` → 有环则 `{rule: "graph.cycle", context: {cycle: NodeID[]}}`
5. 返回全部 issues

#### 4.2.6 ValidationIssue 类型

```ts
interface ValidationIssue {
  readonly rule: string             // "edge.self_loop" | "edge.type_matrix" | "edge.dangling_endpoint" | "node.confidence_range" | "node.name_not_unique" | "graph.cycle"
  readonly message: string          // 人类可读描述
  readonly nodeId?: NodeID
  readonly edgeId?: EdgeID
  readonly context?: unknown        // 额外数据（如环路径）
}
```

### 4.3 冲突检测 `conflict.ts`（纯函数）

domain.md §4 的代码级真相。

```ts
interface Conflict {
  readonly type: "node_modified" | "node_deleted" | "edge_modified" | "cycle" | "constraint"
  readonly nodeId?: NodeID
  readonly edgeId?: EdgeID
  readonly detail: string
  readonly mainState?: unknown
  readonly planState?: unknown
}

function detectConflicts(plan: GraphView, main: GraphView): Conflict[]
```

**4 趟检测**：

1. **逐节点**：对 plan 中每个节点，查 main 同 ID：
   - main 无此 ID → 无冲突（视为新增）。
   - main 节点 `status === "deprecated"` → `{type: "node_deleted"}`。
   - 否则 `!nodesEqual(planNode, mainNode)` → `{type: "node_modified", mainState, planState}`。

2. **逐边**：对 plan 中每条边，查 main 同 ID：
   - main 有同 ID → 只比 `confidence`，不等 → `{type: "edge_modified"}`。
   - main 无同 ID → 查 `(sourceID, targetID, relation)` 三元组是否已在 main 存在 → 存在则 `{type: "edge_modified", detail: "triple exists in main"}`。

3. **约束**：模拟合并后视图（main ∪ plan，plan 覆盖同 ID）→ `validateSubgraph(mergedNodes, mergedEdges)` → 每个 issue → `{type: "constraint"}`。

4. **环检测**：模拟合并后视图 → `detectCycle` → 有环 → `{type: "cycle", context: {cycle: NodeID[]}}`（**最多报 1 个环**）。

**关键修复——`nodesEqual`**：

旧代码把 `sessionID`/`versionID` 纳入比较 → 子图节点几乎总因 session_id 不同而"不等"。我们的版本**只比语义字段**：`type`、`name`、`level`、`priority`、`status`、`desc`。**排除**：`sessionID`、`versionID`、`timeCreated`、`timeUpdated`、`content`（同步元数据）、`codeHash`、`testStatus`、`confidence`（元数据字段，变化不构成语义冲突）。

### 4.4 影响评估 `impact.ts`（纯函数）

domain.md §5 的代码级真相——走**全关系**（不限 relation），无层级影响。

```ts
interface ImpactResult {
  readonly direct: NodeID[]        // 该节点出边（任意 relation）的 target
  readonly indirect: NodeID[]      // 从 direct 递归走出边，新到达的节点
  readonly upstream: NodeID[]      // 该节点入边的 source（仅深度 1，不传递）
  readonly downstream: NodeID[]    // direct ∪ indirect
  readonly risk: "high" | "medium" | "low"
}

function assessImpact(nodeID: NodeID, nodes: NodeRow[], edges: EdgeRow[]): ImpactResult
```

**计算逻辑**：

- **Direct**：`edges.filter(e => e.sourceID === nodeID).map(e => e.targetID)` 去重。
- **Indirect**：从 direct 出发前向 BFS（`traversal.bfs`，全 relation），排除 direct 本身和 nodeID。
- **Upstream**：`edges.filter(e => e.targetID === nodeID).map(e => e.sourceID)` 去重，**深度 1 不递归**。
- **Downstream**：`direct ∪ indirect` 去重。

**风险阈值** `calculateRisk(downstream, nodes)`：

| 条件 | 风险 |
|---|---|
| `downstream.length > 10` **或** downstream 中任一节点 `priority === "P0"` | `high` |
| `3 <= downstream.length <= 10` | `medium` |
| `0 <= downstream.length <= 2` | `low` |

> Upstream 不计入风险。自环 `A→A` 的 quirk：A 会出现在自己的 Direct 中——校验层已禁自环，impact 不额外防御。

### 4.5 领域服务 `domain.ts`（Effect 封装）

```ts
class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphDomain") {}
```

依赖 `GraphStorage.Service`。

#### 写入时校验包装

```ts
node: {
  create(input: NodeCreate): Effect.Effect<NodeID, ValidationError>
  // → validateNode(input) + checkNameUnique(input, sessionNodes) → storage.node.create
  update(id: NodeID, patch: NodePatch): Effect.Effect<void, NotFoundError | ValidationError>
  // → validateNode(merged) → storage.node.update
}
edge: {
  create(input: EdgeCreate): Effect.Effect<EdgeID, ValidationError>
  // → load source/target nodes → validateEdge → 端点同 scope 检查 → storage.edge.create
}
```

校验失败 → `yield* new ValidationError({ rule, message })`，不入库。

> `node.get/delete/list`、`edge.get/delete/list`、`main`、`currentPlan`、`promote`、`version.*` 直接透传 storage（无校验需要）。通过 `GraphDomain.Service` 的 `storage` 字段暴露原始 `GraphStorage.Service`（供 importer 绕过校验批量写入）。

#### 领域查询（加载数据 + 委托纯函数）

```ts
detectConflicts(input: { projectID: ProjectV2.ID; sessionID: string }): Effect.Effect<Conflict[]>
// → storage.main({projectID}) + storage.currentPlan({sessionID}) → conflict.detectConflicts(plan, main)

validateSubgraph(input: { projectID: ProjectV2.ID; sessionID: string }): Effect.Effect<{ issues: ValidationIssue[]; valid: boolean }>
// → storage.currentPlan({sessionID}) → validation.validateSubgraph(nodes, edges)

assessImpact(input: { projectID: ProjectV2.ID; nodeID: NodeID }): Effect.Effect<ImpactResult>
// → storage.main({projectID}) → impact.assessImpact(nodeID, mainNodes, mainEdges)

findPath(input: { projectID: ProjectV2.ID; sourceID: NodeID; targetID: NodeID }): Effect.Effect<NodeID[] | null>
// → storage.main({projectID}) → traversal.findPath(sourceID, targetID, mainEdges)
```

#### 错误类型

```ts
class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("GraphV2.ValidationError", {
  rule: Schema.String,
  message: Schema.String,
  context: Schema.Unknown.pipe(Schema.optional),
}) {}
```

#### Layer

```ts
export const layer = Layer.effect(Service, Effect.gen(function* () {
  const storage = yield* GraphStorage.Service
  // ... wrap + delegate
}))
export const defaultLayer = layer.pipe(Layer.provide(GraphStorage.defaultLayer))
```

## 5. 测试计划（TDD，`bun test`）

测试位于 `packages/core/test/`（opencode 测试惯例）。

### 纯函数测试（无 DB，快）——占测试主体

| 文件 | 关键用例 |
|---|---|
| `graph-traversal.test.ts` | BFS maxDepth=0 无限 vs 有限；relation 过滤；findPath 最短路 + 不可达返回 null；extractSubgraph 诱导子图；detectCycle 有环返回路径/无环返回 null/自环检测 |
| `graph-validation.test.ts` | 每种 relation × 合法/非法组合；imported-code contains 链（prd→composite、composite→atomic、atomic→atomic）；imported-code uses 对；自环拒绝；confidence 越界；名称唯一违反；validateSubgraph 全流程多错误不短路；dangling endpoint |
| `graph-conflict.test.ts` | node_modified（字段不等）；node_deleted（deprecated）；edge_modified（ID 匹配比 confidence / 三元组匹配）；cycle（合并后产生环）；constraint（合并后违反矩阵）；nodesEqual 排除 sessionID（key fix 验证）；主图无此节点=无冲突（新增） |
| `graph-impact.test.ts` | direct（出边 target）；indirect（递归新节点）；upstream（深度 1 不传递）；downstream=direct∪indirect；风险 high(>10)/high(P0)/medium(3-10)/low(0-2)；自环 quirk |

### Effect Service 测试（带 DB）

| 文件 | 关键用例 |
|---|---|
| `graph-domain.test.ts` | 写入非法边→ValidationError+不入库；写入合法边→成功存储；node.create confidence 越界→ValidationError；detectConflicts 从 DB 加载→委托→返回 Conflict[]；assessImpact 从 DB 加载→委托→返回 ImpactResult；storage 透传（main/currentPlan/promote）；findPath 委托 |

## 6. 实现要求

- **Effect 化**：纯函数不返回 Effect（同步函数）；`GraphDomain.Service` 方法用 `Effect.fn` 包装；错误用 `Schema.TaggedErrorClass`。
- **零 `any`**：ValidationIssue/Conflict/ImpactResult 等用 interface 或 Schema 定义。
- **DB 访问**：经 `GraphStorage.Service`（已有），不直接碰 `Database.Service`。
- **零手改 opencode 原文件**：全部为新增文件（`packages/core/src/graph/{traversal,validation,conflict,impact,domain}.ts` + 测试）。
- **命名**：snake_case DB 字段已在存储层处理；领域层用 camelCase interface 字段（与 `NodeRow`/`EdgeRow` 一致）。
- **无新表/migration**：复用子项目 1 的 3 张表。

## 7. 验收标准

- 校验：`validateNode`/`validateEdge`（全量矩阵含 imported-code）/`validateSubgraph` 全部行为正确。
- 冲突：5 类冲突检测正确；`nodesEqual` 排除 sessionID。
- 影响：direct/indirect/upstream/downstream + 风险阈值正确。
- 遍历：BFS/DFS/findPath/extractSubgraph/detectCycle 行为正确。
- 领域服务：写入校验拦截 + 查询委托工作。
- `bun typecheck` 过；`bun test`（在 `packages/core`）全绿（含已有 `graph.test.ts`）。
- migration 漂移检查：`bun run script/migration.ts --check` 输出 "No schema changes"。
- **零分叉**：不手改任何 opencode 原文件；无需登记 UPSTREAM-DIVERGENCE。

## 8. 与上游同步

全部为新增文件。merge 上游时无冲突。
