# Graph Vibe — 工作流与 AI 智能层

> 来源：graph-vibe-coding `internal/ai/`、`internal/cli/{generate,act,tool,permission}.go`、`internal/workflow/`、`internal/executor/`、`internal/importer/`（**以代码为准**）。
> 这是「图驱动 agent」的核心：普通输入进图约束的工作流，而非裸聊天。原则见 `docs/graph-port-principles.md`。

## 1. Plan / Build / Autopilot（意图 + 现状）

| 能力 | 意图闭环 | 代码现状 |
|---|---|---|
| **Plan** | 查图/上下文 → 影响分析 → 提节点/边 → 用户确认 → 持久化为 CurrentPlan | `PlanWorkflow` 状态机 `pending_confirmation→succeeded/blocked/cancelled` 已实现；`Propose` 跑 IntentParser+PlanningEngine，`Confirm` 把节点/边 AddToPlan（设 session_id） |
| **Build** | 图 gate → executor → 校验 artifact → 应用 → diagnostics → 记录 | `runGenerate` 完整实现（见 §3）；`BuildWorkflow` 状态 `dry_run/succeeded/partial/blocked` |
| **Autopilot** | Plan→Build→Check/Fix loop→Summary | ⚠️ **只有状态机模型，循环本身没实现**（见 §4） |

**完整性原则**：所有开发动作经工具运行时，受 CurrentPlan/权限/审计/同步约束；外部 coder 只当受控后端。
> 本 fork：opencode agent 循环为主，Plan/Build 是叠加图模式（原则 5：gated 工具 + Build gate + 提示词手册）。

## 2. AI 智能层组件（真实情况，⚠️ 多处与旧 doc 不符）

| 组件 | 真实情况 | 旧 doc 误述 |
|---|---|---|
| **IntentParser** | 5 意图 `create/modify/delete/query/refactor`；关键词打分（精确词+1.0、包含+0.5）；`confidence=bestScore/词数`（1 词命中=1.0）；`%命令`派发（`%new`→create 等）。**没有置信度阈值 gate**——confidence 仅展示 | 旧写"目标置信度>0.8"是**虚构**的 |
| **PlanningEngine** | `planCreation` **静态脚手架**：固定产 2 节点（composite + atomic）+1 `uses` 边；`planModification` 按名搜索加点；`planDeletion` 搜到设 deprecated（仅内存，不落库）；`planRefactor` 是 stub。影响分析用 `BFS(relation,"blocks"/"uses",depth=3)`——**没用**更丰富的 `AssessImpact` | 旧暗示 AI 驱动规划，实际是静态模板 |
| **CodeGenerator** | Go `text/template`；**6 个模板全是 Go**（data_model/api/utils/config/service/default）；`selectTemplate` 按 type+category；`code_ref={path,type:"file"}`；**无增量**（每次全量覆写） | 旧写"多语言/增量"是**错的** |
| **TestGenerator** | Go 表驱动模板（2 个 Test 函数：scaffold + scenarios）；路径 `src/x/y.go→tests/src/x/y_test.go`；`ValidateTestCoverage` 是**死代码**（从不调用） | — |
| **ReviewAgent** | 5 项检查：`code_not_empty`(error)、`has_package_declaration`(error)、`no_todo_markers`(warning)、`proper_naming`(warning)、`has_error_handling`(info)；有 error 即不通过 | — |
| **ParallelEngine** | Worker Pool 默认 **3**；信号量节流并发（非 goroutine 创建）；**无依赖检测**；结果按**完成序**返回（非输入序） | 旧写"依赖检测"是**虚构**的 |
| **Prompts L1–L5** | `{{var}}` 字符串替换（非 text/template）；**5 个互不相连的模板**，非 pipeline。L1 项目分析 / L2 节点规划 / L3 代码生成 / L4 代码评审 / L5 图同步 | 旧暗示是串联流水线，实际不串联 |
| **ProjectDetector** | 按文件 first-match：`go.mod`/`requirements.txt|setup.py|pyproject.toml`/`package.json`/`Cargo.toml`；仅提取 go module 名 + node package 名 | — |

### Importer（已有代码接入的真正引擎，⚠️ Go-only）
`internal/importer/importer.go`（~3500 行）是项目里最复杂的组件：`go/parser`+`go/ast` 扫描 → project→package→file→decl 节点链 + `contains`/`uses` 边推断（含 test→source、跨包 selector、receiver 方法含嵌入类型提升、HTTP 路由→handler、CLI 命令元数据）。**幂等**（sha256 CodeHash upsert）；置信度/ID 约定见 `data-model.md` §1。
> ⚠️ 旧 doc 把 onboarding 归给 lifecycle，**实际 lifecycle 不调 importer**——importer 由 `%import` 命令直接调。移植：换 **tree-sitter** 重写派生逻辑（这是子项目 3 的核心）。

## 3. Build = 真实生成流水线（`internal/cli/generate.go`）

**生成 gate（Build 时硬门控，⚠️ 旧 doc 说是 sync 一致性，实际不是）**：
1. `node.status` ∉ {verified, deprecated}。
2. **`blocks` 边阻塞**：每条入 `blocks` 边的 source 必须 implemented/verified。
3. **上下文快照漂移门控** `requireSyncedProjectContext`（最新 snapshot hash 须匹配实时）——这是旧 doc 没提的硬 gate。

**executor**：`template`（确定性脚手架）/`agent`（LLM 返回 JSON Artifact）。
**Artifact 校验**（`ValidateArtifact`）：`mode ∈ full/patch`；`full` 需 code/test；`patch` 每条含 `path/preimage_hash/old/new`（严格字符串替换 + preimage 校验）——这是"受控变更"的真正机制（**取代裸 edit/write**）。
**权限 gate**：`artifact_write`（写文件）、`diagnostics_run`（跑诊断命令）；被拒→`blocked` + 审计。
**应用**：full 写文件 / patch 应用；置 `code_hash`、`status=implemented`、`test_status=pending`。
**Diagnostics**：跑配置命令；失败→`test_status=failed`、生成 `failed`。
**审计**：每步写 `generation_runs` + `tool_runs`（executor/backend/model/输入输出摘要/状态）。

> ⚠️ `SyncEnforcer.BlockIfInconsistent`（sync 一致性硬挡）**只在 `/merge` 调，不在 Build**。我们的原则 3 要把硬挡**正确定位到 Build gate**。

## 4. Autopilot 状态机 + 重复失败（⚠️ 循环未实现）

状态：`running/completed/needs_plan_confirmation/needs_permission/failed/cancelled`；阶段 `build/fix/check/permission/plan/summary`。
- **staged_plan**：从 goal 起步时，先把 plan 暂存进 `autopilot_runs.staged_plan_*`(JSON)，返回 `--confirm-plan <runID>` 下一步；跨该边界持久化。
- **暂停条件**：`needs_permission`（artifact_write/diagnostics_run/**预算耗尽** MaxFixAttempts 默认 1，`--extend-budget` +1）/ `needs_plan_confirmation`（从 goal 起步）。
- **重复失败 = 硬 `failed`，不是暂停**：`diagnostics_signature`（= 截断 500 字符的 `input|error|output`）两次相同 → 立即 failed。
- ⚠️ **Plan→Build→Check→Fix 循环本身没实现**——`workflow/autopilot.go` 只是状态/事件模型，驱动循环要 TS 重写；`diagnostics_signature` 的算法可借鉴。

## 5. 工具运行时（原则 5 的落点）

> 旧 `internal/tools/tools.go` 是**薄壳/部分 stub**（无 SwitchSession/MergePlan/GetStatus、无 ShowMascot/UpdateGraph、CodeGen 是硬编码模板）。真正的外部工具面是 `%tool` 命令。

**`%tool` 实际面**（均要求节点在 CurrentPlan）：
- `local read/glob/ls/grep`（只读、不权限门控、cwd 沙箱）。
- `local shell`（`/bin/sh -c`，`shell_run` 权限，30s/64KB 上限）。
- `local webfetch`（HTTP GET，`webfetch` 权限 + 主机策略）。
- MCP `list/call`（`mcp_tool:<server>.<tool>` 权限；输出**压成文本**；GVC 只是 MCP **client**）。
- ⚠️ **没有 bash/edit/write/question**；文件变更**只**走 §3 的 `applyArtifact`。

**硬约束如何落地（本 fork，原则 5）**：
1. 工具 affordance（最硬）：图模式下 agent 只拿到 graph-aware 工具，不提供裸 `write_file`。
2. 运行时 gate：受控工具服务端先查 CurrentPlan/sync/权限才落地。
3. 提示词（软手册）：系统提示讲图工作流。
> 映射 opencode：工具注册表换 gated 集；permissions 做 Build gate；agents 配置放图工作流。**采纳**旧代码"节点须在 CurrentPlan + 权限 + 审计"的运行时模式，但工具名要重新设计（旧"gvc.*"是展示标签非注册工具）。

## 6. 权限与审计
- **权限决策**（`permission_decisions`）：`allow/deny`，`scope ∈ node/session`。**优先级**（`LatestPermissionDecision`）：node 级 > session 级 > node_id NULL，再按 created_at 最新——是"最具体而后最新"，非简单"最新"。
- ⚠️ 旧代码**无交互式权限提示**：决策由 `%permission grant/deny` 预先落库，调用时只查；TUI 的"提示"只是建议授权命令。移植→接 opencode 原生权限提示。
- 资源：`gvc.{artifact_write,diagnostics_run,shell_run,webfetch}` + `mcp_tool:<s>.<t>`。
- **审计**：`tool_runs`（每次工具/动作）、`generation_runs`/`generation_jobs`（durable：per-node 单跑、30min 超时、重启恢复、可取消）、`session_messages`、`graph_summaries`（每次审计动作后增量刷新）。

## 7. 用户生命周期（⚠️ 旧 doc 大幅夸大）

| 场景 | 真实流程 | 旧 doc 误述 |
|---|---|---|
| **空项目初始化** | `InitializeEmptyProject` = **单次**建根 PRD 节点（无 3 轮、无逐轮确认、无测试门） | 旧写"3 轮规划+测试通过"是**虚构** |
| **已有代码接入** | `OnboardExistingProject` 只检测类型+建 session，**不调 importer**；真正扫描在 `%import`（见 §2 Importer） | 旧把扫描归给 lifecycle |
| **日常演进** | `HandleEvolution` = 检测+`CreatePlan`（委托 PlanningEngine） | — |
| **重构迁移** | `HandleRefactor` = **stub**（返回空 plan） | 旧写"分阶段/保历史/测试保障"是**虚构** |

## 8. 移植到 opencode 的注意（采用判断）
- **采用**：意图解析思路（关键词+命令）、Review 5 检查、ParallelEngine 模式（去依赖检测）、durable generation_jobs 模式、`%tool` 的"CurrentPlan+权限+审计"运行时、importer 的派生思路（换 tree-sitter）、autopilot 状态机 + staged_plan + diagnostics_signature 思路。
- **从头实现**（旧代码 stub/缺失）：Autopilot 主循环、真实 Plan/Build orchestrator、软和解（见 `domain.md` §9）、图模式 gated 工具集（重新设计工具名）。
- **修正**：把硬挡正确定位到 Build gate；权限接 opencode 原生提示；意图 confidence 不做阈值 gate。
- **不照搬**：旧 `internal/tools/tools.go` 的 stub 工具名、Go-only 模板（用 opencode 的 edit/write + 多语言）、静态 2 节点 PlanningEngine（按原则做成真图驱动）。
