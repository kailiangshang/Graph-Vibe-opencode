# Graph Vibe — 工作流与 AI 智能层

> 来源：graph-vibe-coding `internal/ai/`、`internal/tools/`、PRD §3.4.1、ARCHITECTURE §3.7.1。
> 这是「图驱动 agent」的核心：普通输入不是裸聊天，而是进图约束的工作流。

## 1. 三种开发能力：Plan / Build / Autopilot

| 能力 | 入口 | 闭环 |
|---|---|---|
| **Plan** | 自然语言需求 | 查图/上下文 → 影响分析 → 提出节点/边 → 用户确认/修改/取消 → 持久化为 CurrentPlan |
| **Build** | 已确认 CurrentPlan | 图 gate → 调 provider/CLI coder → 校验 artifact/patch → 应用 → sync/test/check → 记录 |
| **Autopilot** | 目标 | Plan → Build → Check/Fix loop → Summary；遇权限/产品决策/预算/重复失败时**暂停** |

**完整性原则**（旧 PRD §3.4.1）：
- 每个能力都可观察、可审计、可恢复。
- 模型可回复/请求动作，但**所有开发动作必须经工具运行时**，受 CurrentPlan、权限、审计、同步状态约束。
- 外部 CLI coder（含 opencode 自己的 agent）只能当**受控执行后端**，不能绕过 CurrentPlan 或当主状态。

> 在本 fork：opencode 的 agent 循环是主（日常 chat/tool 走原生），Plan/Build 是叠加的「图模式」；进入图模式时换上 gated 工具集 + Build gate（见 foundation 原则 5）。

## 2. AI 智能层组件

| 组件 | 职责 | 要点 |
|---|---|---|
| **意图解析 IntentParser** | 自然语言 → 操作意图 | 5 种意图：`create`/`modify`/`delete`/`query`/`refactor`；+%命令解析 + 关键词匹配；目标置信度 > 0.8 |
| **规划引擎 PlanningEngine** | 意图 → CurrentPlan | 检索 → 评估 → 子图构建；产出 Create/Modify/Delete/Refactor 四类计划；含影响节点分析 |
| **代码生成器 CodeGenerator** | Node → 代码 | 模板系统（多语言）；更新 CodeRef；落盘；增量生成 |
| **测试生成器 TestGenerator** | 逆向验证 + 测试 | 表驱动测试模板；测试文件生成；覆盖率检查 |
| **审核 Agent ReviewAgent** | 变更审核 | 自动检查清单（多项）；error/warn/info 分级；可扩展检查 |
| **并行引擎 ParallelEngine** | 多节点并行 | Worker Pool（可配置）+ 信号量；结果收集；依赖检测 |
| **提示词管理 Prompts** | L1–L5 模板 | 分级提示词加载 + 变量替换 + 内置模板 |
| **项目检测 ProjectDetector** | 自动识别项目类型 | 多语言检测 + 项目信息提取（模块名等） |

### 代码生成主流程
```
用户输入 → IntentParser(意图) → PlanningEngine(查图/影响/子图)
        → CodeGenerator(模板/CodeRef/落盘) → sync/test/check → 记录(tool_runs/generation_runs)
```

## 3. 工具运行时（Tool Runtime）—— agent 硬锁的落点

> 对应 foundation 原则 5：**结构约束用工具 affordance + 运行时 gate 硬执行**；行为约束用提示词软引导。

**工具分类**（旧项目 `internal/tools/`）：
- **复用类**（OpenCode 兼容）：`bash`/`read`/`edit`/`write`/`glob`/`grep`/`ls`/`webfetch`/`question`。
- **Graph 类**：`CreateNode`/`UpdateNode`/`DeleteNode`/`FindNode`/`Traverse` —— AI 操作图谱。
- **Session 类**：`CreateSession`/`SwitchSession`/`MergePlan`/`GetStatus` —— AI 管理 Session。
- **CodeGen 类**：`GenerateCode`/`GenerateTests`/`ApplyTemplate` —— AI 生成代码。
- **Visualize 类**：`HighlightPath`/`ShowMascot`/`UpdateGraph` —— AI 控制可视化。

**硬约束如何落地（本 fork）**：
1. **工具 affordance（最硬）**：图/Plan-Build 模式下，agent 只拿到 graph-aware 工具（没有裸 `write_file`，只有 `graph.proposeChange`/`build.applyNode` 之类）。工具不提供 → 模型调不了。
2. **运行时 gate（硬）**：受控工具在服务端先查 CurrentPlan/sync 才落地；违规 tool call 直接拒。
3. **提示词（软手册）**：系统提示讲图工作流、节点模型、plan-then-build，让模型少撞 gate。

> 映射 opencode：工具注册表（`@opencode-ai/plugin` tool registry）图模式换一套 gated 工具；permissions 做 Build gate；system-prompt/agents 配置放图工作流说明。

## 4. 权限与审计

- **权限决策**（`permission_decisions`）：`allow`/`deny`，`scope` ∈ `node`/`session`，按 `resource_type`+`resource_id`。
- **工具审计**（`tool_runs`）：每次工具调用留 executor/backend/model/输入摘要/输出摘要/状态。
- **消息历史**（`session_messages`）：与图关联，`role` ∈ user/assistant/system/error/tool，可挂 node_id，记 command。
- **生成记录**（`generation_runs`/`generation_jobs`）：单次生成 + durable Web 作业（可取消、可断点）。
- **Autopilot 编排**（`autopilot_runs`/`autopilot_attempts`）：含 `needs_plan_confirmation`/`needs_permission` 暂停态 + `diagnostics_signature` 重复失败检测。

## 5. 用户生命周期（4 种入口场景）

| 场景 | 流程 |
|---|---|
| **空项目初始化** | 分 3 轮规划，每轮用户确认 → 生成代码 → 测试通过（自动建根 PRD 节点） |
| **已有代码接入** | 逆向扫描（AST/tree-sitter）生成图谱 + 置信度标注 + 用户审核（补全边关系） |
| **日常演进** | 意图理解 → 影响评估 → 代码生成 → 测试通过 |
| **重构迁移** | 现状分析 → 分阶段迁移 → 保留历史 → 测试保障 |

## 6. 移植到 opencode 的注意

- **Plan/Build/Autopilot 是新增 orchestrator**，跑在 opencode agent 循环之上（不替换它）。
- gated 工具集 = 在 opencode tool registry 注册一组图感知工具；图模式开启时切换可见工具集。
- Build gate = 在 opencode permissions 层判 CurrentPlan/sync。
- IntentParser/PlanningEngine 在 TS 里重写（纯逻辑）；CodeGenerator 用 opencode 已有的 edit/write 能力 + 模板。
- `generation_jobs` 的 durable 模型可借鉴 opencode 的 session 持久化风格。
- 提示词 L1–L5 → 放 opencode 的 agents/system-prompt 配置（`@opencode-ai/core` 的 agent 定义）。
