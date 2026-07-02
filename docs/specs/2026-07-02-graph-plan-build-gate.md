# Plan/Build Gate（子项目 4）— 设计 Spec

- **日期**：2026-07-02
- **状态**：已设计，待实现
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；遵循 `docs/UPSTREAM-DIVERGENCE.md`「扩展不修改」；**原则 3（硬阻断只在 Build gate）**与**原则 5（agent 硬锁）**为本层核心。
- **前置**：子项目 1（存储）、子项目 2（领域核心）、子项目 3（结构派生）已完成并合入 `dev`。
- **代码级真相参考**：`docs/graph-vibe/workflow.md` §3–6、`docs/graph-vibe/domain.md` §1–4/§9、`docs/graph-vibe/data-model.md` §3/§5。

## 1. 目标与背景

建立图驱动开发的**执行边界**：Plan 把意图持久化为 session-scoped CurrentPlan；Build gate 在真正写文件或跑生成之前做硬门控；Artifact 模型把裸 `edit/write` 降级为可校验、可审计的受控变更；Audit 记录每次 gate/工具/生成动作。

这是后续 opencode 图工具注册、权限接入、Autopilot 主循环、Web 可视化的共同底座。本子项目不直接改 opencode agent loop，也不把新工具挂进 registry；它先提供可测试的 core primitives。

## 2. 架构决策

### 决策 1：Core-first，不直接接 opencode 工具注册表

本层新增 `packages/core/src/graph/workflow/`，提供 Plan/Build gate 的纯函数和 Effect 服务。opencode-facing 工具注册、系统提示、TUI/Web 操作面属于后续集成层。

原因：
- 保持上游同步友好，不修改 `packages/opencode/src/tool/registry.ts` 等高冲突面。
- 先用 package-level tests 锁定行为，再把 registry/tool affordance 接到稳定 API。
- 符合原则 1/5：扩展优先，agent 硬锁通过组合落地。

### 决策 2：硬阻断只发生在 Build gate

Plan admission 负责把用户/agent 提出的节点和边存入 CurrentPlan，并使用领域层写入校验拦截结构错误。它**不**因为冲突、stale、drift、依赖未完成而阻断规划。

Build gate 是唯一硬阻断点，阻断条件包括：
- 目标节点不在当前 session 的 CurrentPlan。
- 目标节点已 `verified` 或 `deprecated`。
- 入向 `blocks` 依赖未达到 `implemented` 或 `verified`。
- CurrentPlan 全量语义校验失败。
- CurrentPlan 与 main graph 存在冲突。
- 目标或相关意图节点被派生层标记 `content.stale === true`。
- 传入的一致性问题包含未和解的结构漂移或 code_ref 错误。
- Artifact 不满足受控变更格式。

### 决策 3：CurrentPlan 仍由 `session_id` 派生

不新增独立 plan 表。Plan admission 只写 `graph_node.session_id = sessionID` 和 `graph_edge.session_id = sessionID` 的行。合并仍复用 `GraphStorage.promote`。

### 决策 4：Artifact 是唯一写入边界

图模式下未来不会给 agent 裸 `write_file/edit` affordance。文件变更统一表达为 Artifact：
- `full`：完整文件产物，必须有非空 `path`、`code`、`test`。
- `patch`：严格字符串替换，每条 operation 必须有 `path`、`preimageHash`、`old`、`new`；应用前文件内容 hash 必须匹配 `preimageHash`，且 `old` 必须存在。

本子项目实现 Artifact 的纯校验和纯应用计划，不直接把它接到真实 FS 写入工具。真实写入由后续 opencode tool integration 调用该校验结果后执行。

### 决策 5：审计是 first-class core 数据，不是日志字符串

新增 graph workflow 审计表，记录 gate/tool/generation 结果。先实现最小完整字段集：足以回答“谁在什么 session/node 上尝试了什么、输入输出摘要是什么、结果是什么、失败原因是什么”。

## 3. 范围

**在本子项目内（完整实现）：**

- Plan admission：把节点/边写入 CurrentPlan，使用 `GraphDomain.Service` 做写入校验；支持 dry-run。
- Build gate 纯评价器：输入 `main`、`currentPlan`、目标节点、可选 consistency issues、可选 artifact，输出 structured `GateResult`。
- Build workflow Effect 服务：从 storage/domain 读取 CurrentPlan/main，调用 gate，记录审计。
- Artifact 纯模型：validate、hash、patch/full apply plan。
- Audit 持久化：`graph_tool_run`、`graph_generation_run` 表 + `GraphAudit.Service`。
- 完整 TDD 测试：纯函数无 DB 测试 + service integration tests。

**显式不在本子项目：**

- 把图模式工具注册进 `packages/opencode/src/tool/registry.ts`。
- opencode 权限交互 UI/TUI 提示接线。
- Protocol/Server HTTP API 和 SDK 生成。
- Autopilot Plan→Build→Check/Fix 循环。
- LLM 代码生成器或 prompt 模板。
- 真实 FS 写入工具；本层只产生可审计的 Artifact apply plan。

## 4. 数据模型

新增两张表，放在 graph workflow 子系统下。

### 4.1 `graph_tool_run`

记录每次图工具或受控本地工具动作。

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | text PK | `gtr_` 前缀 ID |
| `project_id` | text FK project | 项目分区 |
| `session_id` | text nullable FK session | 所属 CurrentPlan/session |
| `node_id` | text nullable FK graph_node | 目标节点 |
| `tool_name` | text | 例如 `graph.plan.admit`、`graph.build.gate` |
| `tool_type` | text | `graph` / `local` / `mcp` / `permission` / `artifact` / `diagnostics` |
| `input_summary` | text nullable | 截断摘要，不存大 payload |
| `output_summary` | text nullable | 截断摘要 |
| `status` | text | `succeeded` / `failed` / `blocked` / `dry_run` |
| `error` | text nullable | 失败原因 |
| `time_created` | integer | 创建时间 |

### 4.2 `graph_generation_run`

记录 Build gate / generation attempt 的结构化结果。

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | text PK | `ggr_` 前缀 ID |
| `project_id` | text FK project | 项目分区 |
| `session_id` | text nullable FK session | 所属 session |
| `node_id` | text FK graph_node | 目标节点 |
| `executor` | text | `agent` / `template` / `manual` |
| `backend` | text nullable | provider/backend 名 |
| `model` | text nullable | 模型名 |
| `context_snapshot_hash` | text nullable | 后续 context snapshot gate 使用 |
| `status` | text | `succeeded` / `failed` / `blocked` / `dry_run` |
| `gate_result` | JSON | `GateResult` 摘要 |
| `artifact_summary` | text nullable | artifact 摘要 |
| `diagnostics_summary` | text nullable | diagnostics 摘要 |
| `time_created` | integer | 创建时间 |

不实现 `generation_jobs` durable queue；那属于 Autopilot/Server 层。

## 5. 模块设计

```
packages/core/src/graph/workflow/
  artifact.ts  — 纯: Artifact schema/types, validate, hash, apply plan
  gate.ts      — 纯: Build gate evaluator
  audit-sql.ts — Drizzle tables for graph_tool_run / graph_generation_run
  audit.ts     — Effect: GraphAudit.Service
  plan.ts      — Effect: CurrentPlan admission service
  build.ts     — Effect: BuildWorkflow.Service
```

### 5.1 Artifact `artifact.ts`

```ts
export type Artifact = FullArtifact | PatchArtifact

export interface FullArtifact {
  readonly mode: "full"
  readonly path: string
  readonly code: string
  readonly test: string
}

export interface PatchOperation {
  readonly path: string
  readonly preimageHash: string
  readonly old: string
  readonly replacement: string
}

export interface PatchArtifact {
  readonly mode: "patch"
  readonly operations: ReadonlyArray<PatchOperation>
}

export interface ArtifactIssue {
  readonly code:
    | "empty_path"
    | "empty_code"
    | "empty_test"
    | "empty_patch"
    | "empty_old"
    | "preimage_hash_mismatch"
    | "old_text_not_found"
  readonly path?: string
  readonly message: string
}
```

函数：
- `hashContent(content: string): string`：sha256 hex。
- `validateArtifact(artifact: Artifact): ArtifactIssue[]`：格式校验。
- `planArtifactApplication(artifact, files): ArtifactApplyResult`：纯应用计划，`files` 是 path→content map；不写磁盘。

### 5.2 Build gate `gate.ts`

```ts
export interface BuildGateInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly targetNodeID: NodeID
  readonly main: GraphView
  readonly currentPlan: GraphView
  readonly consistencyIssues?: ReadonlyArray<ConsistencyIssue>
  readonly artifact?: Artifact
  readonly diagnosticsRequested?: boolean
}

export interface GateIssue {
  readonly code:
    | "target_not_in_current_plan"
    | "target_status_blocked"
    | "blocked_by_dependency"
    | "current_plan_invalid"
    | "conflict_detected"
    | "stale_intent"
    | "structural_drift"
    | "missing_code_reference"
    | "invalid_artifact"
  readonly severity: "block" | "warn"
  readonly nodeID?: NodeID
  readonly message: string
}

export interface GateResult {
  readonly allowed: boolean
  readonly issues: ReadonlyArray<GateIssue>
  readonly requiredPermissions: ReadonlyArray<"artifact_write" | "diagnostics_run">
}
```

行为：
- 目标节点必须在 CurrentPlan。
- `verified` / `deprecated` 目标不能 Build。
- 对目标节点的入向 `blocks` 边：source 必须 `implemented` 或 `verified`。
- `validateSubgraph(currentPlan)` 任一错误都产生 `current_plan_invalid` block。
- `detectConflicts(currentPlan, main)` 任一冲突都产生 `conflict_detected` block。
- CurrentPlan 中 `content.stale === true` 的意图节点产生 `stale_intent` block。
- 派生 consistency issues 中结构漂移产生 `structural_drift` block；code_ref 问题产生 `missing_code_reference` block。
- artifact 校验问题产生 `invalid_artifact` block。
- `artifact` 存在则要求 `artifact_write`；`diagnosticsRequested` 为 true 则要求 `diagnostics_run`。

### 5.3 Plan admission `plan.ts`

```ts
export interface AdmitPlanInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly nodes: ReadonlyArray<Omit<GraphStorage.NodeCreate, "projectID" | "sessionID">>
  readonly edges: ReadonlyArray<Omit<GraphStorage.EdgeCreate, "projectID" | "sessionID">>
  readonly dryRun?: boolean
}

export interface AdmitPlanResult {
  readonly nodesCreated: number
  readonly edgesCreated: number
  readonly dryRun: boolean
}
```

`dryRun` 只跑同步写入校验和子图校验，不落库。实际写入使用 `GraphDomain.Service.node.create` / `edge.create`，确保运行时 gate 直接复用领域规则。

### 5.4 Audit `audit.ts`

`GraphAudit.Service` 提供：
- `tool.record(input): Effect<ToolRunID>`
- `tool.list(input): Effect<ToolRun[]>`
- `generation.record(input): Effect<GenerationRunID>`
- `generation.list(input): Effect<GenerationRun[]>`

列表按 `time_created` 升序，支持 project/session/node 过滤。

### 5.5 Build workflow `build.ts`

`GraphBuild.Service.evaluate(input)`：
1. 读取 `storage.main({ projectID })` 与 `storage.currentPlan({ sessionID })`。
2. 调用 `evaluateBuildGate`。
3. 写 `graph_generation_run` 和 `graph_tool_run` 审计。
4. 返回 `GateResult`。

不执行生成、不写文件、不调用 opencode Permission 服务；权限资源只在 `requiredPermissions` 中返回，供后续集成层接入 opencode 原生 permission prompt。

## 6. 测试策略

新增测试文件：
- `packages/core/test/graph-artifact.test.ts`：full/patch 校验、preimage hash、纯应用计划。
- `packages/core/test/graph-gate.test.ts`：每个 Build gate 阻断条件 + required permissions。
- `packages/core/test/graph-audit.test.ts`：审计表 record/list/filter。
- `packages/core/test/graph-plan.test.ts`：Plan admission dry-run 与落库。
- `packages/core/test/graph-build.test.ts`：Effect workflow 读取图、评价 gate、记录审计。

运行命令：
- 单测：`cd packages/core && bun test test/graph-*.test.ts`
- 类型：`cd packages/core && bun typecheck`
- migration drift：`cd packages/core && bun run script/migration.ts --check`

## 7. 成功标准

- Plan admission 正确写入 session-scoped CurrentPlan，dry-run 不落库。
- Build gate 对所有阻断条件返回结构化 issue，`allowed` 语义稳定。
- Artifact full/patch 校验和纯应用计划可重放、可审计、无裸 FS 副作用。
- Audit 表和服务可记录/查询 tool/generation run。
- 不修改 opencode agent loop / tool registry / server/protocol。
- package tests、typecheck、migration check 全绿。
