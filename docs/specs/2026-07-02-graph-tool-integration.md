# 图模式工具集成（子项目 5）— 设计 Spec

- **日期**：2026-07-02
- **状态**：已设计，待实现
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；遵循 `docs/UPSTREAM-DIVERGENCE.md`「扩展不修改」；核心是**原则 5（agent 硬锁）**与**原则 3（硬阻断只在 Build gate）**。
- **前置**：子项目 1–4 已完成并合入 `dev`：图存储、领域核心、结构派生、Plan/Build gate core primitives。
- **代码级真相参考**：`docs/graph-vibe/workflow.md` §3–6，`docs/specs/2026-07-02-graph-plan-build-gate.md`。

## 1. 目标与背景

把子项目 4 的 core primitives 接到 opencode agent 工具面：在一个**显式 opt-in 的 graph mode** 下，agent 看到的是 graph-aware 工具集，而不是裸 `write/edit/apply_patch/shell`。图模式工具在运行时通过 CurrentPlan、Build gate、Artifact 校验、opencode 原生 permission prompt、graph audit 来约束落地动作。

本子项目是“agent 硬锁”的第一层落地：工具 affordance + 运行时 gate + 提示词手册。Autopilot 主循环仍是后续子项目。

## 2. 架构决策

### 决策 1：Opt-in graph mode，不改变默认 opencode 行为

新增 runtime flag：`OPENCODE_EXPERIMENTAL_GRAPH_MODE`（也受 `OPENCODE_EXPERIMENTAL` 统一开关控制）。默认关闭。

关闭时：ToolRegistry 行为不变。

开启时：ToolRegistry 使用 graph-safe builtins：
- 保留只读/上下文工具：`read`、`glob`、`grep`、`task`、`fetch`、`todo`、`search`、`skill`，以及可选 `lsp`/`plan`。
- 移除裸写入/执行工具：`edit`、`write`、`apply_patch`、`shell`。
- 新增 graph 工具：`graph_plan_admit`、`graph_build_gate`、`graph_artifact_apply`。

### 决策 2：新增文件为主，Registry 只做最小组合修改

新工具放在 `packages/opencode/src/tool/graph/`。`tool/registry.ts` 只新增 imports、init、flag 分支与 LayerNode 依赖，不改 SessionRunner/LLM loop。

原因：
- 保持 upstream merge 风险低。
- 图工具本身可独立测试。
- 后续可以把 graph mode 接到 agent profile/config，而无需重写工具实现。

### 决策 3：工具从 opencode session 推导 project/session，不让模型传 projectID

工具执行时通过 `ctx.sessionID` 调 `Session.Service.get(ctx.sessionID)`，得到 `projectID` 与工作目录。模型只传业务参数，例如节点、边、target node、artifact。

这样避免模型伪造 projectID/sessionID，也符合 CurrentPlan = session-scoped graph rows。

### 决策 4：权限接 opencode 原生 prompt，不新增 permission 表

使用现有 `ctx.ask(...)`：
- Artifact 写入：permission `graph.artifact_write`，patterns 为 artifact 涉及的相对路径。
- 后续 diagnostics：permission `graph.diagnostics_run`，本子项目仅保留 gate 返回的 required permission，不实现诊断命令执行。

旧 graph-vibe 的 `permission_decisions` 表不搬；opencode 已有 session/agent permission rules 与 prompt/reply 机制。

### 决策 5：Artifact apply 是唯一写文件工具

`graph_artifact_apply` 是 graph mode 下唯一写文件工具：
1. 解析相对路径并确保不能逃出 worktree。
2. 调用 `GraphBuild.Service.evaluate(...)` 运行 Build gate。
3. gate 不允许时不请求写权限、不写文件。
4. gate 允许时用 `ctx.ask` 请求 `graph.artifact_write`。
5. 读取当前文件内容，调用 `planArtifactApplication(...)` 做 preimage/hash/old-text 校验。
6. 写入文件，发布 FileSystem/Watcher 事件。
7. 将目标节点标记为 `implemented`、`testStatus=pending`。

`graph_build_gate` 只评估并返回结果，不写文件。

## 3. 范围

**在本子项目内（完整实现）：**

- Runtime flag：`experimentalGraphMode`。
- Graph mode registry affordance：默认工具集切换 + graph 工具注入。
- Core graph services 的 LayerNode wiring，供 opencode runtime composition 使用。
- `graph_plan_admit`：CurrentPlan admission tool。
- `graph_build_gate`：Build gate evaluation tool。
- `graph_artifact_apply`：受控 Artifact 写入工具。
- Graph workflow prompt/manual text，注入系统 instructions。
- TDD 测试：graph tool 参数/执行、registry filtering、prompt injection、artifact apply permission/gate behavior。

**显式不在本子项目：**

- Autopilot Plan→Build→Check/Fix loop。
- Server/Protocol API 与 SDK generation。
- UI/TUI 图可视化。
- MCP tool gating。
- diagnostics 命令执行器。
- LLM code generation templates。

## 4. 模块设计

```
packages/core/src/graph/
  storage.ts                 — add LayerNode export
  domain.ts                  — add LayerNode export
  workflow/audit.ts          — add LayerNode export
  workflow/plan.ts           — add LayerNode export
  workflow/build.ts          — add LayerNode export

packages/opencode/src/tool/graph/
  prompt.txt                 — graph workflow system instructions
  util.ts                    — session/project resolution, path normalization, output helpers
  plan-admit.ts              — graph_plan_admit tool
  build-gate.ts              — graph_build_gate tool
  artifact-apply.ts          — graph_artifact_apply tool
  index.ts                   — tool exports + graph-safe registry helpers

packages/opencode/src/effect/runtime-flags.ts
packages/opencode/src/tool/registry.ts
packages/opencode/src/session/instruction.ts
```

### 4.1 Core LayerNode wiring

新增：
- `GraphStorage.node` depends on `Database.node`。
- `GraphDomain.node` depends on `GraphStorage.node`。
- `GraphAudit.node` depends on `Database.node`。
- `GraphPlan.node` depends on `GraphDomain.node`。
- `GraphBuild.node` depends on `GraphStorage.node` + `GraphAudit.node`。

不改变已有 `layer/defaultLayer`。

### 4.2 Graph tool parameters

`graph_plan_admit`:

```ts
{
  dryRun?: boolean
  nodes: Array<{
    id?: string
    type: "prd" | "composite" | "atomic"
    name: string
    level: "L1" | "L2"
    priority?: "P0" | "P1" | "P2" | "P3"
    category?: string
    status?: "pending" | "implemented" | "verified" | "deprecated"
    desc?: string
    content?: Record<string, unknown>
    codeHash?: string
    testStatus?: "none" | "pending" | "passed" | "failed"
    confidence?: number
  }>
  edges: Array<{
    id?: string
    sourceID: string
    targetID: string
    relation: "contains" | "blocks" | "addresses" | "uses" | "deprecated_by"
    confidence?: number
  }>
}
```

`graph_build_gate`:

```ts
{
  targetNodeID: string
  artifact?: Artifact
  diagnosticsRequested?: boolean
  dryRun?: boolean
}
```

`graph_artifact_apply`:

```ts
{
  targetNodeID: string
  artifact: Artifact
}
```

Artifact paths are **relative to the project worktree**. Absolute paths and `..` escapes are rejected before permission prompts.

### 4.3 Graph-safe registry helper

`tool/graph/index.ts` exports:
- `graphToolIDs`
- `graphWritableToolIDs`
- `graphSafeBuiltin(tool)` predicate
- `graphInstruction` text

Registry graph mode behavior:
- build the normal builtin tools as today;
- when flag off, return existing builtin list;
- when flag on, filter out `shell/edit/write/apply_patch`, then append graph tools.

This keeps existing plugin/custom tools unchanged for now. A later policy layer may disable custom write-like plugin tools in graph mode once plugin permissions are modeled.

### 4.4 Prompt/manual injection

`Instruction.system()` appends graph workflow instructions only when `experimentalGraphMode` is true. The text instructs the model to:
- plan into CurrentPlan with `graph_plan_admit` before implementation;
- call `graph_build_gate` before applying code changes;
- use `graph_artifact_apply` as the only write path;
- treat stale/drift/gate issues as blockers and report them instead of bypassing tools.

## 5. Error handling

- Invalid tool args fail through Tool.decode and produce normal `ToolInvalidArgumentsError`.
- Missing session/project fails the tool call with a clear message.
- Path escape rejects before permission prompt.
- Build gate block returns a successful tool result with `allowed=false`; this is model-readable, not a runtime defect.
- Permission rejection propagates via existing opencode permission errors.
- Artifact preimage/hash failure returns a blocked tool result and records audit; it does not write partial files.

## 6. Testing strategy

新增测试：
- `packages/opencode/test/tool/graph-mode.test.ts`：registry graph mode includes graph tools and excludes raw write/exec tools when flag enabled; default mode unchanged.
- `packages/opencode/test/tool/graph-tools.test.ts`：direct tool execution for plan admit and build gate using in-memory DB + seeded session.
- `packages/opencode/test/tool/graph-artifact-apply.test.ts`：gate block prevents permission/write; allowed artifact asks permission, writes files, updates node status.
- `packages/opencode/test/session/graph-instruction.test.ts`：graph prompt text appears only when flag enabled.

运行命令：
- Focused: `cd packages/opencode && bun test test/tool/graph-mode.test.ts test/tool/graph-tools.test.ts test/tool/graph-artifact-apply.test.ts test/session/graph-instruction.test.ts`
- Typecheck: `cd packages/opencode && bun typecheck`
- Core safety: `cd packages/core && bun typecheck && bun test test/graph-*.test.ts`

## 7. 成功标准

- 默认 opencode 工具集完全不变。
- graph mode opt-in 后，raw write/exec tools 不再暴露，graph tools 暴露。
- graph tools 从 session 推导 projectID，不接受模型传 projectID。
- Artifact apply 在 gate block 或 preimage mismatch 时不写文件。
- Artifact apply 成功时走 permission prompt、写文件、更新节点状态、保留审计。
- 系统提示在 graph mode 中明确说明 Plan/Build/Artifact 流程。
- 不改 SessionRunner/provider loop，不新增 Protocol/Server API。
