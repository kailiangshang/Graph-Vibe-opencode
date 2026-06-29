<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<h1 align="center">Graph Vibe OpenCode</h1>
<p align="center">图驱动开发 · forked from <a href="https://github.com/anomalyco/opencode">opencode</a></p>
<p align="center"><sub>Forked from <a href="https://github.com/anomalyco/opencode">anomalyco/opencode</a> — full credit to the upstream project. Powered by its runtime. Not affiliated with the OpenCode team.</sub></p>

---

## 核心思想

Graph Vibe OpenCode 把代码架构显式表达成一张**本地图**——节点是需求 / 设计 / 实现单元，边是它们的关系。这张图让 AI 辅助开发**可检查、可审计、受约束**：它既是规划画板，也是执行 gate，也是变更审计日志。

与传统「AI 直接改代码」不同：这里 AI 的每个开发动作都流经**图约束的工具运行时**，受 CurrentPlan、权限、审计、代码-图同步状态约束。而**代码是真相，图是可从代码重新派生 + 叠加意图标注的那一层**——所以图永远不会失控。

## 这是什么

`graph-vibe-opencode` 是 [opencode](https://github.com/anomalyco/opencode)（TypeScript/Bun 的开源 AI coding agent）的二次开发 fork，在其完整的 agent 能力（session / provider / model / connect / TUI / web / desktop）之上，**叠加 graph-vibe 的图驱动能力**：

- **Plan / Build / Autopilot** — 图驱动的三种开发模式（需求→CurrentPlan→受控构建→托管循环）。
- **Session 即分支** — 每个开发 session 是图上的一条分支，带自己的 CurrentPlan（待提交子图），合并后才入主图。
- **影响评估 / 冲突检测** — 改一个节点，立刻知道波及谁；合并前查语义冲突。
- **code↔graph 同步** — 结构子图从代码派生（tree-sitter），drift 软和解（自动重派生 + stale 标记，不锁死用户）。
- **Web 图可视化** — 实时看到整张图、影响链路、变更过程。

## 怎么做（架构与实现）

- **混合架构** — opencode 为主（session / provider / agent 循环不变），叠加图驱动 Plan/Build 模式。不替换 opencode，只在其上扩展。
- **分层子项目** — 存储 → 领域核心 → 结构派生 → Plan/Build → AI 智能层 → 可视化，每层独立 spec，自下而上构建。
- **6 条治理原则**（详见 [`docs/graph-port-principles.md`](./docs/graph-port-principles.md)）：① 混合 ② 代码即真相 ③ drift 软和解 ④ 约束不对称（用户软、agent 硬）⑤ agent 结构硬锁（工具 affordance + 运行时 gate）⑥ 无 MVP、完整生产级实现。
- **扩展不修改** — graph-vibe 全部以**新增模块**通过 opencode 的扩展点接入（新表 + migration、工具注册表、protocol 组、Location-scoped service、agents 配置），零侵入 opencode 核心，长期干净同步上游（详见 [`docs/UPSTREAM-DIVERGENCE.md`](./docs/UPSTREAM-DIVERGENCE.md)）。
- **落到 opencode 的映射** — 图表进 opencode 全局 SQLite（`project_id` 分区）；graph-vibe 分支 = opencode session（CurrentPlan = `session_id` 标记的子图）；gated 工具走工具注册表；Build gate 走 permissions；图工作流提示词进 agents 配置。

## 优势

- **AI 改动可检查、可审计** — 每次变更都记在图上，有据可查。
- **图不会失控** — 结构子图可重建、意图子图优雅降级（标 stale 而非锁死）；最坏情况是一批标注过时要复核，绝不锁死。
- **agent 受结构硬约束** — 工具 affordance + 运行时 gate 硬执行，不靠提示词自觉。
- **上游干净同步** — 扩展不修改，`merge upstream/dev` 零冲突（仅品牌层 5 个文件偶需重解）。
- **站在成熟底座** — 复用 opencode 的 provider / model / connect / TUI / web / desktop，不重复造轮子。

## 去哪深入

- [`docs/graph-port-principles.md`](./docs/graph-port-principles.md) — 图移植 6 条治理原则
- [`docs/graph-vibe/`](./docs/graph-vibe/README.md) — 图核心抽象参考（数据模型 / 领域 / 工作流）
- [`docs/specs/`](./docs/specs/) — 各子项目实现 spec
- [`docs/STATUS.md`](./docs/STATUS.md) — 现状、进度、环境搭建（新机器接续开发必读）
- [`docs/README.md`](./docs/README.md) — 文档总索引与规则

---

## 运行（基于 opencode 运行时）

> 本项目是 opencode 的 fork，**未独立发布**到 npm / 包管理器。从源码运行（需 Bun 1.3+，完整环境搭建见 [`docs/STATUS.md` §3](./docs/STATUS.md)）：

```bash
git clone https://github.com/kailiangshang/Graph-Vibe-opencode.git
cd Graph-Vibe-opencode
bun install
bun dev            # 启动 TUI（默认跑在 packages/opencode）
bun dev .          # 在仓库根跑 TUI
bun dev serve      # 无头 API server（默认 4096）
bun dev web        # server + web UI
bun run graph-vibe # = bun dev 的别名
```

如需上游 opencode 本体（已发布版本、桌面 App 等），见 [anomalyco/opencode](https://github.com/anomalyco/opencode)。

### Agents

继承自 opencode，两个内置 agent（`Tab` 切换）：

- **build** — 默认，全权限开发 agent。
- **plan** — 只读 agent（默认拒绝改文件、bash 前询问），适合探索陌生代码或规划变更。

另有 **general** 子 agent（`@general` 调用）处理复杂搜索与多步任务。

### 文档与贡献

- opencode 配置文档：<https://opencode.ai/docs>
- 贡献指南（来自上游）：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 本 fork 的开发进度与文档：[`docs/`](./docs/README.md)

> 说明：本项目是独立二次开发，使用 "opencode" 字样是对上游 fork 的致敬，不代表由 OpenCode 团队构建或与其有关联。

---

Forked from [anomalyco/opencode](https://github.com/anomalyco/opencode) · MIT License
