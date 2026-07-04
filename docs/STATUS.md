# Graph Vibe OpenCode — 现状与开发进度

> 这是一份**活文档**，每次有进展就更新。目的是让任何人（包括在另一台机器上的我）能快速接续开发。
> 最后更新：2026-07-04

## 1. 这是什么

`graph-vibe-opencode` 是基于 [`anomalyco/opencode`](https://github.com/anomalyco/opencode)（TypeScript / Bun 单体仓库）的二次开发 fork。
产品名 **Graph Vibe OpenCode**——保留 "opencode" 字样是对上游 fork 的致敬。

目标：在上游完整的 AI coding agent（session / provider / model / connect / TUI / web / desktop）之上，增量移植「图驱动开发」能力（源自旧 Go 项目 `graph-vibe-coding` 的概念，不沿用其代码）。

## 2. 仓库与分支

| remote | URL | 权限 |
|---|---|---|
| `origin` | `git@github.com:kailiangshang/Graph-Vibe-opencode.git` (SSH) | 推/拉都走这里 |
| `upstream` | `https://github.com/anomalyco/opencode.git` | **只 fetch**（push 已禁，防误推上游） |

- 默认分支：`dev`
- 同步上游：`git fetch upstream && git merge upstream/dev`（最近同步 2026-07-04）

## 3. 环境搭建（新机器必读）

> 这台机器（WSL2 / Ubuntu）的实测可行配置。换机器照做即可。

### 3.1 Bun（版本锁死，跟 `package.json` 的 `packageManager` 一致）
```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
# 确保 ~/.bun/bin 在 PATH（installer 会写进 ~/.zshrc）
bun --version   # 应为 1.3.14
```

### 3.2 npm 镜像（国内网络必装，否则 bun install 会因包损坏反复失败）
写**用户级** `~/.bunfig.toml`（不动仓库，可回滚）：
```toml
[install]
registry = "https://registry.npmmirror.com"
```

### 3.3 node-gyp 修复（系统自带 v9.3.0 与 Python 3.12 不兼容，原生编译会挂）
装一个新版到 nvm 全局，让它排在 `/usr/bin/node-gyp` 前面：
```bash
npm install -g node-gyp@latest --registry=https://registry.npmmirror.com
node-gyp --version   # 应为 v13+，路径在 ~/.nvm/.../bin
```

### 3.4 安装与运行
```bash
bun install                                   # 仓库根目录；postinstall 会跑 fix-node-pty + husky
bun dev                                       # 启动 TUI（默认跑在 packages/opencode 目录）
bun dev .                                     # TUI 跑在仓库根目录
bun dev serve                                 # 无头 API server（默认 4096 端口）
bun dev web                                   # server + 开 web UI
bun run graph-vibe                            # = bun dev 的别名（rename 后可用）
```
> 交互式 TUI 不要在前台阻塞跑，用 tmux（见 `packages/opencode/AGENTS.md`）：
> `tmux new-session -d -s oc 'bun dev'` → `tmux capture-pane -pt oc` → `tmux kill-session -t oc`

### 3.5 类型检查 / lint
```bash
bun typecheck    # 仓库根，turbo 跑全量（packageManager 锁的 bun）
bun run lint     # oxlint
# 单包类型检查：在包目录跑 bun typecheck（用 tsgo，别直接 tsc）
```

## 4. 已知陷阱

- **浅克隆会推不上空 origin**：若 `git rev-parse --is-shallow-repository` 为 `true`，先 `git fetch --unshallow upstream` 补全历史，否则 push 报 `index-pack failed: did not receive expected object`。
- **pre-push 钩子跑 `bun typecheck`**：需要 `bun` 在 PATH 上；非交互 shell（如脚本）若没继承 `~/.bun/bin`，钩子会报 `bun: not found`。推之前 `export PATH="$HOME/.bun/bin:$PATH"`。
- **`upstream` 不可 push**：pushurl 已设为 `DISABLE_PUSH_TO_UPSTREAM`，防误推上游。所有推送只走 `origin`。
- **不要在仓库根跑测试**：根 `test` 脚本是 guard（`do-not-run-tests-from-root`）；测试在包目录跑。
- **改了 Protocol/Server 的 HttpApi 或 SDK**：在 `packages/client` 跑 `bun run generate`，别手改 `src/generated*`。

## 5. 开发进度

| # | 内容 | 状态 |
|---|---|---|
| 0 | 环境搭建 / git 归位 / 架构地基 / rename / 概念提炼 / 上游策略 | ✅ |
| 1 | 图存储地基（graph_node/edge/version + CurrentPlan + TDD） | ✅ |
| 2 | 图领域核心（校验/冲突/影响/路径分析） | ✅ |
| 3 | 结构派生（tree-sitter 扫描/一致性/和解） | ✅ |
| 4 | Plan/Build Gate（GraphPlan.admit / GraphBuild.evaluate / GateResult / 审计） | ✅ |
| 5 | Graph mode 工具集成（plan_admit / build_gate / artifact_apply / registry / prompt） | ✅ |
| 6A | Graph Read API + CurrentPlan 面板（6 个 HTTP 端点 + Hey-API SDK + Web 页面） | ✅ |
| 6B | Canvas 力导向图可视化（力导向布局/Canvas 渲染/拖拽缩放/视图切换） | ✅ |
| 7 | Autopilot 工作流（graph_diagnostics_run + Plan→Build→Check→Fix→Summary 提示词） | ✅ |
| — | 上游同步（2026-07-04，code-mode 等上游变更已合并） | ✅ |

## 6. 架构决策摘要（图移植地基，治理所有后续图功能）

1. **方向：混合**——opencode 为主（session/provider/agent 循环不变），叠加图驱动 Plan/Build 模式。
2. **图模型：代码才是真相**，图 = 可从代码重新派生的结构子图 + 叠加的意图子图（PRD/Plan/决策/审计）。
3. **drift：软和解为主**（结构自动重派生、意图标 stale），硬阻断只在 CurrentPlan 的 Build gate。
4. **约束不对称：用户软、agent 硬。**
5. **agent 硬锁 = 工具 affordance + 运行时 gate（结构约束硬执行）+ 提示词手册（行为约束软引导）。**

→ 详见 `docs/graph-port-principles.md`
→ rename（已完成）见 `docs/archive/2026-06-26-minimal-rename-design.md`

## 7. 重要路径速查

- CLI/TUI+server 入口：`packages/opencode/src/index.ts`（yargs，`.scriptName("opencode")`）
- bin shim：`packages/opencode/bin/opencode`（npm 安装版找平台二进制；dev 不走它）
- TUI logo：CLI 文本路径 `packages/opencode/src/cli/ui.ts` 的 `logo()`；TUI 首屏 `packages/tui/src/component/logo.tsx` 的 `Logo()`
- **文档总索引 + 规则**：`docs/README.md`（写新文档先看这，防堆积）
- 设计 spec：`docs/specs/`；实施计划：`docs/plans/`；归档：`docs/archive/`
- 图移植概念参考：`docs/graph-vibe/`（README + data-model + domain + workflow；从旧 Go 项目提炼，移植不再依赖旧项目）
- 上游同步追踪：`docs/UPSTREAM-DIVERGENCE.md`（分叉登记表 +「扩展不修改」总则 + merge 流程）
- 本文档：`docs/STATUS.md`（持续更新）

## 8. rename 执行清单（子项目 0，✅ 已完成）

改 5 个文件，commit `chore: rebrand to Graph Vibe OpenCode (dual-name)`：
1. `package.json`（根）：`name` → `graph-vibe-opencode`；加 `graph-vibe` dev 脚本。
2. `packages/opencode/package.json`：`bin` 加 `"graph-vibe": "./bin/opencode"`。
3. `README.md`：标题 → Graph Vibe OpenCode + fork 致敬。
4. `packages/opencode/src/cli/ui.ts`：`logo()` 加副标题（CLI `--help`/命令输出路径）。
5. `packages/tui/src/component/logo.tsx`：TUI 首屏 `Logo()` 加副标题（TUI splash 实际渲染处）。
不动：`@opencode-ai/*` scope、`OPENCODE_*` env、配置目录、`scriptName`。
验收：`bun dev` 仍跑通、`bun run graph-vibe` 等价 `bun dev`、`--version` 正常。
