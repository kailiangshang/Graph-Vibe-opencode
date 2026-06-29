# Upstream Divergence — opencode 同步追踪

> 目的：本 fork（`graph-vibe-opencode`）要**长期同步**上游 `anomalyco/opencode`。本文登记我们对 opencode 原代码的每一处分叉，并固化同步纪律，让 `git merge upstream/dev` 始终干净可预测。
> 活文档，每次动 opencode 原文件、每次 merge 上游后都更新。
> 最后更新：2026-06-27

## 1. 总则：「扩展，不修改」

1. **增量落位**：graph-vibe 代码放**新文件/新包**（如 `packages/graph/`，或现有包内只加新文件）。新文件永不与上游冲突。
2. **用组合，不改内核**：改 opencode 行为走它的扩展点（Effect Layer / 工具注册表 / protocol `HttpApiGroup` / Location-scoped service / drizzle 新表 + migration / agents 配置），**不去 fork SessionRunner、server、session 核心逻辑**。
3. **opencode 的 bug 不在树内补**：遇到 bug → 给上游提 issue/PR（让上游修，sync 自动收）；实在阻塞就在**我们自己的代码里**用组合绕过；绝不在 opencode 源文件打补丁。
4. **只依赖稳定公开面**：import 各 workspace 包的公开 API（`@opencode-ai/core`/`schema`/`protocol`/`plugin` 等），遵循仓库既定分层（Schema→Core/Protocol→Server；Client 不依赖 Core/Server），不掏深 internals。
5. **rebase 禁用**：长期同步只用 `git merge upstream/dev`，不用 rebase（rebase 重写历史、长期不 scale）。

## 2. 分叉登记表（动过 opencode 原文件的地方）

> 只列**修改了 opencode 原文件**的处。新增文件不算分叉（见 §3）。
> 每次 `git merge upstream/dev` 后，对着这张表逐条检查是否仍 apply / 是否冲突。

| 文件 | 改动 | 为什么 | 冲突风险 | 处置 |
|---|---|---|---|---|
| `package.json`（根） | `name` → `graph-vibe-opencode`；加 `graph-vibe` dev 脚本 | fork 身份 + 双名 | 低（小、局部） | 长期保留；上游大改 scripts 段时重解 |
| `packages/opencode/package.json` | `bin` 加 `"graph-vibe"` 别名 | 双名 | 低 | 长期保留 |
| `README.md` | 重写为 graph-vibe-opencode 俯瞰（核心思想/做什么/架构/优势/指路）+ 保留 opencode 运行说明 | 品牌与项目门面 | 中（与上游 README 差异大） | 长期保留；merge 时不追求与上游 README 同步 |
| `packages/opencode/src/cli/ui.ts` | `logo()` 加副标题字符串 | 品牌（CLI 输出路径） | 低 | 长期保留 |
| `packages/tui/src/component/logo.tsx` | `Logo()` 组件加副标题 `<text>` | 品牌（TUI 首屏） | 中（组件结构） | 长期保留；上游重构该组件时重解 |

**当前分叉小结**：5 处，全部是**品牌层**，非逻辑改动，冲突风险低～中。这是 fork 的固有成本，可接受。

## 3. 增量内容（新文件，永不上游冲突）

这些是纯新增，merge 时安全：
- `docs/STATUS.md`、`docs/UPSTREAM-DIVERGENCE.md`（本文）
- `docs/graph-vibe/`（README / data-model / domain / workflow）
- `docs/specs/`、`docs/plans/`、`docs/graph-vibe/`
- 未来的图子系统：新包（如 `packages/graph/`）、新表 + migration、新工具/protocol 组/handler、agents 配置

> 原则上 graph-vibe 的**所有逻辑实现**都应落在这里，而不是改 §2 之外的 opencode 原文件。

## 4. 上游同步工作流

```bash
git fetch upstream                                  # upstream 是 fetch-only
git merge upstream/dev                              # merge，不要 rebase
bun typecheck                                       # 钩子也会跑；抓类型破裂
# 逐条核对 §2 分叉登记表；冲突优先在「品牌层」小范围解决
# 跑一遍 bun dev 确认 TUI 正常
git push origin dev
```
- 频率：建议每周或每次上游有重要修复时。
- 冲突只在 §2 的 5 个品牌文件可能出现，且都易解。
- 若 merge 后某分叉不再需要（上游加了同类能力），及时从 §2 移除并回退改动。

## 5. 遇到 opencode bug 的处理路径

1. **先评估**：是否真的阻塞我们？不阻塞就记一笔，继续。
2. **上报上游**：给 `anomalyco/opencode` 提 issue（必要时 PR）——让上游修，sync 自动收。
3. **绕过**：阻塞的话，在**我们自己的代码**（§3 增量区）用组合/包装绕过，不动 opencode 源文件。
4. **最后手段**：确需在 opencode 原文件打补丁时——加进 §2 登记表，注明「why + 预期丢弃条件」（上游修了就丢），并优先推回上游。

## 6. 与图移植的关系

图移植的每个子项目（存储/领域/派生/Plan-Build/AI/可视化）都应**默认走 §3 增量区**：
- 图表 = 新 `*.sql.ts` + migration（加进 opencode 的全局 DB，`project_id` 分区）。
- 图工具 = 注册表新增（图模式换 gated 工具集）。
- 图 API = 新 `server.graph` protocol 组 + handler。
- graph session = 复用 opencode session（B1 方案，组合接入），不 fork session 核心。
- Build gate = 走 opencode permissions 扩展点。

这样图移植天然与上游同步兼容。
