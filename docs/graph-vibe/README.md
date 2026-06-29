# Graph Vibe — 核心抽象参考（从 graph-vibe-coding 提炼）

> 本目录是 graph-vibe-coding（旧 Go 项目）**核心抽象的独立参考**，目的是让后续在 opencode(TS/Bun) 上的移植**不再依赖旧项目代码或子目录**。
> 只记录概念、数据模型、语义和工作流（与语言无关）；Go 实现细节不搬。
> **⚠️ 以代码为准**：2026-06-27 做了代码级深挖，多处纠正了基于旧 PRD 的误述（各文内标 ⚠️）。判断规则——事实性模型采用代码真相；代码 stub/半成品（autopilot 循环、软和解、WAL recovery 等）**不照搬**，保留我们的原则作设计意图并注明缺口。
> 最后更新：2026-06-27

## 这是什么

「Graph Vibe」的灵魂：把代码架构**显式表达成一张本地图**（节点 = 需求/设计/实现单元，边 = 它们的关系），让 AI 辅助开发**可检查、可审计、受约束**。图既是规划画板，也是执行 gate，还是审计日志。

旧项目 graph-vibe-coding 是 Go 单体实现；本 fork 改为在 opencode(TS/Bun) 之上增量移植这些概念。

## 文件索引

| 文档 | 内容 |
|---|---|
| `data-model.md` | 图谱数据模型：节点（三层 + imported-code 平行模型）、边（五种 + 真实规则）、生命周期、全部表与字段语义。**移植数据层的唯一参考。** |
| `domain.md` | 领域模型：Session/Branch、CurrentPlan、合并（双路径）、冲突（5 类）、影响评估（走全关系 + 风险阈值）、校验、遍历、同步与恢复（注明哪些不搬）。 |
| `workflow.md` | 工作流：Plan/Build/Autopilot（状态机 + staged_plan + 重复失败）、AI 层真实情况、生成流水线、工具运行时、权限与审计、生命周期。 |
| `web-viz.md` | Web 可视化：HTTP API、WebSocket 协议（哪些真实 / 仅客户端）、力导向布局/相机/裁剪/配色、**吉祥物动画系统**、durable 作业。 |

## 分层架构（与语言无关）

```
用户界面层   CLI REPL · TUI · Web(Canvas+吉祥物)
交互层       命令注册 · 对话框 · 补全
AI 智能层    意图解析 · 规划引擎 · 代码/测试生成 · 审核 · 并行
Session 层   Session(=Branch) · CurrentPlan
图谱核心层   遍历 · 合并 · 冲突检测 · 影响评估 · 子图 · 约束校验
存储层       SQLite 图库（移植时不搬自研 WAL/检查点/锁，靠 opencode 持久化）· 快照
```

## 数据流（三条主线）

1. **代码生成**：用户输入 → 意图解析 → 规划引擎(查图/影响评估/构建子图) → 代码生成(模板/CodeRef/落盘) → 同步/测试/检查 → 记录。
2. **同步**：代码变更 → 一致性检测(hash/CodeRef) →（软和解，见下）→ 差异报告/自动重派生。
3. **可视化**：图变更 → WebSocket 广播 → 浏览器 Canvas（力导向布局 + 视口裁剪 + 链路高亮 + 吉祥物）。

## 映射到 opencode（本 fork 的移植地基）

> 治理原则见 `docs/graph-port-principles.md`。摘要：

- **混合**：opencode 为主（session/provider/agent 循环不变），叠加图驱动 Plan/Build 模式。
- **代码才是真相**：图 = 可从代码重新派生的「结构子图」+ 叠加的「意图子图」（PRD/Plan/决策/审计）。
- **drift 软和解**：结构自动重派生、意图标 stale；硬阻断只在 Build gate。
- **agent 硬锁**：工具 affordance + 运行时 gate（结构约束）+ 提示词手册（行为约束）。

opencode 已有的可直接复用：SQLite(经 drizzle) 做存储、tree-sitter 做结构派生、工具注册表 + permissions 做 gate、system-prompt/agents 做提示词手册、session 体系。图谱核心层 + AI 智能层 + 同步层是**新增移植内容**。

## 与旧 PRD 的有意偏离

- 旧 PRD F37「不一致即硬阻断」→ 本 fork 降级为**软和解**（drift 不锁死用户；只 Build gate 挡）。
- 旧 PRD「图即真相」→ 本 fork 改为「**代码即真相，图可重建**」，根治"图逐步不可维护"。
- 旧 PRD「外部 CLI coder 不能当主状态」→ 保留精神：opencode 的 agent 循环是主，但 Build 模式下受图约束。
