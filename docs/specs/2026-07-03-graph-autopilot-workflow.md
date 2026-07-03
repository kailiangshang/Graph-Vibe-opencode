# Autopilot 工作流闭环（子项目 7）— 设计 Spec

- **日期**：2026-07-03
- **状态**：已设计，待实现
- **治理**：受 `docs/graph-port-principles.md` 约束；遵循「扩展不修改」。
- **前置**：子项目 1–6A 已完成。
- **参考**：`docs/graph-vibe/workflow.md` §3–4。

## 1. 目标

闭合 Plan→Build→Check→Fix 工作流，让 graph mode 下的 agent 能自主完成"计划→实现→验证→修复"全流程。

具体交付：
1. **`graph_diagnostics_run` 工具**：graph mode 下唯一的命令执行工具，运行配置的诊断命令（test/typecheck/lint），更新节点 testStatus，记录审计。
2. **增强的系统提示词**：完整的 autopilot 工作流手册，指导 agent 按 Plan→Build→Check→Fix→Summary 顺序自主工作。
3. **节点状态闭环**：`pending → implemented → verified`，由 artifact apply 和 diagnostics 驱动。

## 2. 架构决策

### 决策 1：Prompt-driven autopilot + Build gate 硬约束

不新增 autopilot 状态机表或循环编排器。autopilot 工作流由**系统提示词**驱动（agent 按 prompt 指示的步骤自主工作），**Build gate** 提供硬约束（阻止越序构建、未满足依赖的构建）。

理由：
- opencode 的 agent 循环本身就是迭代式的 LLM + tool loop。prompt-driven 方式让 agent 在已有循环内自然遵循工作流。
- Build gate（子项目 4）已经是硬约束：`blocks` 边阻止跳序、`target_not_in_current_plan` 阻止计划外构建。
- 不需要 fork SessionRunner 或新增编排服务。

### 决策 2：诊断命令从 package.json 自动探测，不改 config schema

`graph_diagnostics_run` 工具接受可选 `commands` 参数。未提供时从项目 `package.json` 的 `scripts` 中探测 `test`、`typecheck`、`lint`。探测不到则默认 `["bun test"]`。

不改 `ConfigV1.Info`（避免上游分叉）。

### 决策 3：诊断通过时自动提升节点为 verified

当 diagnostics 全部通过时，节点从 `implemented` → `verified` + `testStatus: "passed"`。失败时 `testStatus: "failed"`，状态保持 `implemented`。

### 决策 4：复用已有审计基础设施

诊断运行记录为 `toolType: "diagnostics"` 的 `GraphAudit.tool.record`。不新增表。

## 3. 范围

**完整实现：**
- `graph_diagnostics_run` 工具定义、参数、执行逻辑。
- 诊断命令执行（ChildProcessSpawner + 超时 + 输出截断）。
- package.json scripts 自动探测。
- 节点 testStatus/status 更新。
- 审计记录。
- 权限请求 `graph.diagnostics_run`。
- 增强系统提示词（autopilot 工作流手册）。
- registry 注册 + graph-safe builtin 更新。
- TDD 测试。

**显式不在本子项目：**
- Autopilot 状态机表 / durable run records。
- Autopilot HTTP API 端点。
- MCP 工具门控。
- Canvas 可视化。
- 多 session 并发 autopilot 编排。

## 4. 模块设计

```
packages/opencode/src/tool/graph/
  diagnostics-run.ts    — graph_diagnostics_run 工具
  prompt.txt            — modify: 增强 autopilot 工作流手册
  index.ts              — modify: 导出 GraphDiagnosticsRunTool + graphToolIDs 更新
  util.ts               — modify: add detectDiagnosticsCommands helper

packages/opencode/src/tool/registry.ts — modify: 注册 diagnostics tool
packages/opencode/test/tool/graph-diagnostics-run.test.ts — new test
packages/opencode/test/session/graph-instruction.test.ts — modify: 验证 autopilot prompt
```

### 4.1 `graph_diagnostics_run` 工具

**参数：**
```ts
{
  targetNodeID: string
  commands?: string[]  // optional; auto-detected if omitted
}
```

**执行流程：**
1. `resolveGraphSession(ctx, sessions)` → `{ projectID, sessionID, directory }`
2. `build.evaluate({ ..., targetNodeID, diagnosticsRequested: true })` → gate result
3. gate 不允许 → 记录审计 `blocked`，返回 blocked 结果
4. gate 允许 → `ctx.ask({ permission: "graph.diagnostics_run", patterns })` 请求权限
5. 解析命令：`commands ?? detectDiagnosticsCommands(directory)`
6. 逐条执行命令 via `ChildProcessSpawner.spawn(ChildProcess.make(cmd, [], { shell, cwd: directory, ... }))`
7. 每条命令 race `exitCode` vs timeout（默认 120s）vs `ctx.abort`
8. 捕获 stdout+stderr via `Stream.decodeText(handle.all)`，截断到 64KB
9. 汇总结果：allPass = 每条命令 exitCode === 0
10. 更新节点：`storage.node.update(targetNodeID, { testStatus: allPass ? "passed" : "failed", ...(allPass ? { status: "verified" } : {}) })`
11. 记录审计：`audit.tool.record({ toolType: "diagnostics", status: allPass ? "succeeded" : "failed", ... })`
12. 返回结构化结果

**命令探测逻辑** (`detectDiagnosticsCommands`):
```ts
async function detectDiagnosticsCommands(directory: string): Promise<string[]> {
  const pkg = await Bun.file(path.join(directory, "package.json")).json().catch(() => ({ scripts: {} }))
  const scripts = pkg.scripts ?? {}
  const commands: string[] = []
  if (scripts.test) commands.push("bun run test")
  if (scripts.typecheck) commands.push("bun run typecheck")
  if (scripts.lint) commands.push("bun run lint")
  return commands.length > 0 ? commands : ["bun test"]
}
```

### 4.2 增强系统提示词

```
Graph Workflow Mode — Autopilot

You are operating in graph-driven autopilot mode. The graph is the source of truth for implementation intent. Follow this workflow strictly:

## Plan Phase
1. Analyze the user's goal.
2. Decompose into graph nodes (PRD → composite → atomic) with edges (contains, blocks, addresses).
3. Admit the plan with graph_plan_admit. Wait for confirmation before proceeding.

## Build Phase
For each pending node, following dependency order (blocks edges first):
1. Call graph_build_gate to check readiness.
2. If blocked, report the blocker and skip to the next available node.
3. If allowed, generate the artifact (code + tests) and apply with graph_artifact_apply.

## Check Phase
After each artifact is applied:
1. Call graph_diagnostics_run to run project tests and type checks.
2. If all diagnostics pass, the node is verified. Move to the next pending node.
3. If diagnostics fail, enter Fix Phase.

## Fix Phase
1. Read the diagnostics output from graph_diagnostics_run.
2. Identify the failure cause.
3. Generate a corrected artifact and re-apply with graph_artifact_apply.
4. Re-run diagnostics.
5. Maximum 2 fix attempts per node. If still failing after 2 attempts, mark the node as failed and move on.

## Summary Phase
When all nodes are verified or failed:
1. Summarize: how many verified, how many failed, what remains.
2. Suggest next steps for failed nodes.

## Rules
- Never bypass tools. File changes only through graph_artifact_apply.
- Never run raw shell commands. Diagnostics only through graph_diagnostics_run.
- Treat gate blocks, stale intent, and structural drift as hard blockers.
- Keep artifacts relative to the project worktree and include tests.
- Process nodes in dependency order: a node's blocks-edge sources must be verified before building it.
```

## 5. 错误处理

- Gate block → 返回 blocked 结果，不执行命令。
- 权限拒绝 → 返回 blocked 结果。
- 命令超时 → 该命令标记为 failed，继续执行后续命令。
- 命令不存在 → 返回 error，不更新节点状态。
- 节点不存在 → NotFoundError → 工具失败。

## 6. 测试策略

`test/tool/graph-diagnostics-run.test.ts`:
- gate block 时不执行命令、不更新状态。
- 全部通过时：testStatus=passed, status=verified, audit succeeded。
- 部分失败时：testStatus=failed, status 保持 implemented, audit failed。
- 命令自动探测从 package.json scripts。
- 权限请求被调用。

`test/session/graph-instruction.test.ts`:
- 验证增强后的 prompt 包含 autopilot 工作流关键词。

## 7. 成功标准

- `graph_diagnostics_run` 在 graph mode 下可执行诊断命令。
- 命令执行、结果汇总、节点状态更新、审计记录全部正常。
- 系统提示词包含完整的 Plan→Build→Check→Fix→Summary 工作流。
- 默认 opencode 行为不变。
- 所有测试通过，typecheck 通过。
