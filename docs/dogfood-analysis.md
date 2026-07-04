# Dogfooding 分析：用 Graph Mode 开发 Tic-Tac-Toe

> 日期：2026-07-04
> 方法：直接使用 core graph services（GraphPlan / GraphBuild / GraphStorage / GraphAudit）模拟 agent 在 graph mode 下的完整工作流，针对 `examples/tic-tac-toe/` 项目执行 Plan→Build→Check→Promote 全流程。

## 1. 测试覆盖

| 阶段 | 测试 | 结果 |
|---|---|---|
| Plan | 创建 6 节点 + 5 边的 tic-tac-toe 开发计划 | ✅ pass |
| Build gate (blocked) | 依赖未完成时 gate 阻止构建 | ✅ pass |
| Build gate (allowed) | 依赖已 verified 时 gate 放行 | ✅ pass |
| Check | 节点状态生命周期 pending → implemented → verified | ✅ pass |
| Audit | 全流程工具运行审计记录 | ✅ pass |
| Promote | CurrentPlan 提升为主图 | ✅ pass |

全部 6 个测试通过（`test/dogfood/tic-tac-toe-graph.test.ts`）。

## 2. 发现的问题

### 严重（影响核心可用性）

**P1: 边类型矩阵对意图节点过于严格**

`contains` 关系要求 `source.type === target.type && source.level === "L1" && target.level === "L2"`。这意味着：
- prd(L1) → composite(L2)：❌ 类型不同
- composite(L1) → atomic(L2)：❌ 类型不同
- 只有 composite(L1) → composite(L2) 或 atomic(L1) → atomic(L2) 才合法

自然的 PRD→composite→atomic 层级结构无法用 `contains` 表达。`addresses` 要求 composite(L2)→prd(L2)，方向反直觉。

**影响**：agent 创建计划时需要仔细研究边类型矩阵，否则会反复收到 `ValidationError`。实际开发中，我用 `uses`（composite(L2)→atomic(L2)）和 `blocks`（atomic(L2)→atomic(L2)）绕过了这个问题，但失去了层次结构表达能力。

**建议**：放宽 `contains` 规则，允许 prd→composite 和 composite→atomic（对齐 imported-code 节点已有的规则）。

**P2: 边引用需要显式节点 ID**

`GraphPlan.admit` 的 edges 必须用 `sourceID`/`targetID` 引用节点的 ID。如果节点没有显式 `id`（由系统自动生成 `gnd_xxx`），调用者无法预知 ID，也就无法创建边。

**影响**：agent 必须在创建节点时就发明 ID（如 `"ttt_board"`），增加了心智负担。

**建议**：支持索引引用（`sourceIndex` / `targetIndex`），或在 admit 返回时先创建节点再接受边。

### 中等（影响体验和集成）

**P3: 无 HTTP 写 API**

Graph 数据只能通过 agent 工具（`graph_plan_admit` 等）创建，没有 HTTP POST 端点。外部工具、CI 脚本、Web UI 都无法直接创建计划或更新节点状态。

**建议**：新增 POST `/graph/plan/admit`、PATCH `/graph/node/:id/status`、POST `/graph/promote`。

**P4: 无节点/边删除能力**

计划创建后，如果节点或边有误，没有删除或修改的方式（除非删掉整个 session）。

**建议**：在 graph tools 或 API 中增加节点/边删除（仅限 CurrentPlan，主图不可删）。

**P5: Canvas 只显示 CurrentPlan**

Web 可视化只能看 session 级 CurrentPlan，看不到已提交的主图。用户无法浏览项目的完整图结构。

**建议**：Web 面板增加 `/graph/main` 视图，或支持 CurrentPlan/Main 切换。

**P6: 无实时更新**

Web 面板用 TanStack Query 轮询，没有 SSE 推送。agent 更新节点时，用户不会自动看到变化。

**建议**：在 graph 服务变更时发布事件（`graph.node_updated`、`graph.plan_admitted`），通过既有 SSE 流推送。

### 轻微（优化项）

**P7: 预算限制仅靠提示词**

Autopilot 提示词写了"最多 2 次修复尝试"，但代码层面没有强制。agent 可能忽略。

**建议**：在 `graph_diagnostics_run` 或 `graph_artifact_apply` 中检查 audit 历史，拒绝超过预算的重复尝试。

**P8: 诊断超时硬编码**

`graph_diagnostics_run` 超时固定 120s。大型项目的集成测试可能不够。

**建议**：接受 `timeout` 参数或从 config 读取。

**P9: 无选择性诊断**

`graph_diagnostics_run` 一次运行所有配置的命令（test + typecheck + lint）。无法只跑测试或只跑类型检查。

**建议**：接受 `filter` 参数选择运行哪些命令。

## 3. 优化建议优先级

| 优先级 | 建议 | 理由 |
|---|---|---|
| P0 | 放宽边类型矩阵（P1） | 不修复则 agent 创建计划时反复失败 |
| P0 | 支持索引边引用（P2） | 不修复则 agent 必须发明 ID |
| P1 | HTTP 写 API（P3） | 解锁外部集成 |
| P1 | 节点/边删除（P4） | 计划可修正 |
| P2 | 主图视图（P5） | 提升可视化完整性 |
| P2 | 实时更新（P6） | 提升 UX |
| P3 | 预算强制（P7） | 健壮性 |
| P3 | 诊断配置（P8/P9） | 灵活性 |
