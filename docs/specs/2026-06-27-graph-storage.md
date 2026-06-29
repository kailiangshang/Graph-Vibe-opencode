# 图存储地基（子项目 1）— 设计 Spec

- **日期**：2026-06-27
- **状态**：已 brainstorm，待评审 → writing-plans
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；遵循 `docs/UPSTREAM-DIVERGENCE.md`「扩展不修改」；**原则 6：无 MVP、完整生产级实现**。
- **前置决策**：A=图表进 opencode 全局 `opencode.db`（`project_id` 分区）；B1=graph-vibe 分支 = opencode session。

## 1. 目标与背景

把 graph-vibe 的图持久化层完整地落到 opencode 上：在 opencode 单一全局 SQLite（`~/.local/share/opencode/opencode.db`，由 `@opencode-ai/core` 的 `Database.Service` 持有）里新增图的表与服务，零侵入 opencode 现有代码（纯新增文件）。这是图移植的最底层，后续领域/派生/Plan-Build 都建立在它上面。

opencode 底座要点（来自 explore）：单全局 DB；多项目靠 `project_id` 列分区；drizzle schema 在 `packages/core/src/**/*sql.ts`；migration 是 TS 文件（`packages/core/src/database/migration/*.ts`，自定义 journal，新 DB 跑 `schema.gen.ts` 的 `up`，旧 DB 跑增量 migration）；session 是事件溯源、带 `parent_id` 分支；`#db` 别名是死的遗留，**用 `@opencode-ai/core/database/database`**。

## 2. 范围

**在本子项目内（完整实现）：**
- 3 张新表：`graph_node`、`graph_edge`、`graph_version`（含字段、CHECK/FK/UNIQUE 约束、索引）。
- migration 集成（新表既能用于全新 DB，也能增量应用到现有 DB）。
- Effect 化的存储服务（CRUD + 按 `project_id`/`session_id` 过滤的查询）。
- CurrentPlan / 主图机制（基于 `session_id`）+ 「提升子图到主图」存储原语 + 版本快照。
- 完整测试（TDD，`bun test`）。

**显式不在本子项目（属其它层，按原则 6 到该层时完整设计，非 MVP 裁剪）：**
- 语义校验算法（contains 必须 L1→L2 等）、合并算法、冲突检测、影响评估、子图合并 → **子项目 2（领域核心）**。本层只做 DB 级 CHECK/FK/UNIQUE 约束。
- 结构派生（tree-sitter 建图、drift 软和解）→ **子项目 3**。
- Plan/Build、gated 工具运行时、审计表（`generation_runs`/`tool_runs`/`autopilot_*`）→ **子项目 4/5**。这些表设计依赖工作流层设计，现在猜=不完整。
- 可视化 → **子项目 6**。

**不建表的（复用 opencode 或不需要）：**
- `sessions`/消息/权限/工具调用审计 → 复用 opencode `session`/`message`/`permission`/message part。
- `wal_logs`/`checkpoints`/`locks` → **不需要**：opencode 已有 SQLite WAL(PRAGMA)、事件溯源、migration、`SessionRunCoordinator` 做持久化与并发；自定义 WAL/锁是重复。

## 3. 数据模型（完整 schema）

遵循 opencode 约定：snake_case 字段、`time_created`/`time_updated`（Timestamps）、`project_id` FK→`project`、外键 `ON DELETE CASCADE`。

### 3.1 `graph_node`
| 字段 | 类型 | 约束/语义 |
|---|---|---|
| `id` | TEXT | PK |
| `project_id` | TEXT | NOT NULL，FK→`project(id)` ON DELETE CASCADE |
| `session_id` | TEXT | FK→`session(id)` ON DELETE CASCADE，**NULL=主图；非空=该会话 CurrentPlan** |
| `type` | TEXT | NOT NULL，CHECK IN (`prd`,`composite`,`atomic`) |
| `name` | TEXT | NOT NULL |
| `level` | TEXT NOT NULL | CHECK IN (`L1`,`L2`)（**必填**：prd=L1, composite=L2, atomic=L2） |
| `priority` | TEXT | CHECK IN (`P0`,`P1`,`P2`,`P3`) |
| `category` | TEXT | 仅 atomic 用 |
| `status` | TEXT | NOT NULL DEFAULT `pending`，CHECK IN (`pending`,`implemented`,`verified`,`deprecated`) |
| `desc` | TEXT | 仅 prd，建议 ≤20 字（应用层校验） |
| `content` | TEXT | JSON：CodeRef/InputTypes/OutputType 等实现元数据 |
| `code_hash` | TEXT | 代码指纹（派生/同步用，子项目 3 填） |
| `test_status` | TEXT | NOT NULL DEFAULT `none`，CHECK IN (`none`,`pending`,`passed`,`failed`) |
| `confidence` | REAL | DEFAULT 1.0，CHECK `0.0 ≤ confidence ≤ 1.0` |
| `time_created` | INTEGER | NOT NULL |
| `time_updated` | INTEGER | NOT NULL |

索引：`(project_id)`、`(project_id, session_id)`、`(project_id, type)`、`(project_id, status)`、`(session_id)`。
触发器：UPDATE 后自动刷 `time_updated`（同 opencode 风格）。

### 3.2 `graph_edge`
| 字段 | 类型 | 约束/语义 |
|---|---|---|
| `id` | TEXT | PK |
| `project_id` | TEXT | NOT NULL，FK→`project(id)` ON DELETE CASCADE |
| `session_id` | TEXT | FK→`session(id)` ON DELETE CASCADE，NULL=主图边 |
| `source_id` | TEXT | NOT NULL，FK→`graph_node(id)` ON DELETE CASCADE |
| `target_id` | TEXT | NOT NULL，FK→`graph_node(id)` ON DELETE CASCADE |
| `relation` | TEXT | NOT NULL，CHECK IN (`contains`,`blocks`,`addresses`,`uses`,`deprecated_by`) |
| `confidence` | REAL | DEFAULT 1.0，CHECK `0.0..1.0` |
| `time_created` | INTEGER | NOT NULL |

约束：`UNIQUE(source_id, target_id, relation)`（同一三元组在表内唯一，跨 main/session 不重复）。
索引：`(project_id)`、`(project_id, session_id)`、`(source_id, relation)`、`(target_id)`、`(source_id, target_id, relation)`。

### 3.3 `graph_version`（merge 版本快照）
| 字段 | 类型 | 约束/语义 |
|---|---|---|
| `id` | TEXT | PK |
| `project_id` | TEXT | NOT NULL，FK→`project(id)` ON DELETE CASCADE |
| `session_id` | TEXT | FK→`session(id)`（发起合并的会话） |
| `version_number` | INTEGER | NOT NULL |
| `message` | TEXT | 合并说明 |
| `snapshot` | TEXT | NOT NULL，JSON：本次并入主图的 `{nodes, edges}` 快照 |
| `time_created` | INTEGER | NOT NULL |

约束：`UNIQUE(project_id, version_number)`（版本号按 project 单调）。
索引：`(project_id, version_number)`、`(project_id, time_created)`。

> merge **算法**（冲突检测/版本生成策略）在子项目 2；本表只提供持久化与自增 version_number。

## 4. 核心机制（B1 落地）

- **主图 vs CurrentPlan**：完全由 `session_id` 区分——`session_id IS NULL` = 主图（已提交）；`session_id = <opencode session>` = 该会话的 CurrentPlan 子图（未合并）。无需独立 plan 表。
- **隔离**：一个 opencode session（=一条 graph 分支）的 CurrentPlan 天然与主图、与其它 session 隔离；`parent_id`（opencode session 分支）可作为分支起点的语义。
- **promote 原语（存储层）**：`promote(sessionId)` → 把该 session 的 `graph_node`/`graph_edge` 的 `session_id` 置 NULL（并入主图），并在事务内写一条 `graph_version` 快照。返回并入的节点/边数 + 版本号。**只做存储动作，不做合并决策**（决策/冲突=子项目 2 在调用层做，确认后才调 promote）。
- **多项目分区**：所有查询都以 `project_id` 为前置条件，绝不跨项目泄漏。

## 5. 模块结构与 Service API

落位：`packages/core/src/graph/`（新目录，纯新增）。遵循 opencode 的 Effect Service/Layer 模式与命名（`export * as Graph from "."` 自重导出风格）。

**`graph/sql.ts`** — 3 张 drizzle 表定义（snake_case，不重定义列名字符串）。
**`graph/storage.ts`** — `GraphStorage.Service`（`@opencode/graph/Storage`），方法：
- 节点：`node.create / get / update / delete / list({projectId, sessionId?, type?, status?})`
- 边：`edge.create / get / delete / list({projectId, sessionId?, sourceId?, targetId?, relation?})`
- 图视图：`graph.main({projectId})`（session_id NULL 的节点+边）；`graph.currentPlan({sessionId})`（该 session 的节点+边）
- 提升：`graph.promote({sessionId})` → `{versionNumber, nodes, edges}`（事务内：置 NULL + 写 version 快照）
- 版本：`version.list({projectId}) / get({projectId, versionNumber})`
- 所有写操作在事务内、默认带 `project_id` 校验。

**`graph/index.ts`** — 自重导出 `export * as Graph from "."`。
Layer：`GraphStorage.layer`（依赖 `Database.Service`）。

## 6. 实现要求

- **Effect 化**：用 `Effect.gen` / `Effect.fn`；错误用 `Schema.TaggedErrorClass`；服务用 `Context.Service` 模式（参考 opencode `session`/`project`）。
- **事务**：`promote` 及多写操作用 drizzle 事务；`busy_timeout` 由 `Database.Service` 的 PRAGMA 已设。
- **DB 访问**：经 `@opencode-ai/core/database/database` 的 `Database.Service`（**不**用死的 `#db` 别名）。
- **最小接触 opencode 原文件**：业务逻辑全部为新增文件；仅对 `packages/core/src/database/schema.gen.ts` 与 `migration.gen.ts` 做**注册性追加**（见 §7），不改既有 migration 文件与数据库连接/PRAGMA 等逻辑。
- **命名**：snake_case 字段；Effect 服务命名与自重导出遵循 `packages/opencode/AGENTS.md`。
- **无 `any`**；content/snapshot JSON 用 Schema 定义结构（`GraphNodeContent` 等）。

## 7. migration 集成

opencode migration 系统：全新 DB 跑 `schema.gen.ts` 的 `up(tx)`；已有 DB 跑 `migration/*.ts` 增量。因此：
- 新建 `packages/core/src/graph/sql.ts` 定义 3 表（drizzle）。
- 在 `packages/core/src/database/schema.gen.ts` 的 `up(tx)` 里**新增** 3 表的建表语句（纯追加，不改既有）。
- 新建一个 migration 文件 `packages/core/src/database/migration/<时间戳>_graph.sql.ts`，`up(tx)` 创建同样 3 表（供已有 DB 增量），并登记进 `migration.gen.ts` 的静态列表。
- migration 在 `Semaphore.makeUnsafe(1)` 锁下运行（已有机制），无需额外处理并发。

> 注：动 `schema.gen.ts` 与 `migration.gen.ts` 属**注册性新增**（往列表/快照里加条目），不是修改 opencode 逻辑——记进 `docs/UPSTREAM-DIVERGENCE.md` §2（低风险）。

## 8. 测试计划（TDD，`bun test`）

测试位于 `packages/core/src/graph/storage.test.ts`（或 `test/`，遵循 opencode 测试惯例）。用例（先写测试再实现）：
1. **节点 CRUD**：create（默认 status=pending/test_status=none 生效）、get、update、delete；update 刷 `time_updated`。
2. **节点约束**：非法 type/level/status/priority 被 CHECK 拒绝；confidence 越界拒绝；`desc` 超长由应用层挡（DB 不限）。
3. **边 CRUD + 约束**：create/get/delete；source/target 不存在被 FK 拒；`UNIQUE(source,target,relation)` 重复拒绝；非法 relation 拒绝。
4. **project_id 分区**：project A 的节点对 project B 的查询不可见。
5. **CurrentPlan 隔离**：session S1 的节点（session_id=S1）不在 `graph.main`，反之主图节点不在 S1 的 `currentPlan`。
6. **promote 原语**：S1 的 plan 节点+边 → promote 后 session_id 置 NULL → 进入主图；生成 `graph_version` 快照（含正确 nodes/edges、version_number 自增）；promote 后 S1 的 currentPlan 为空。
7. **级联**：删 session → 其名下节点/边级联删；删 project → 其全部图表级联删。
8. **版本**：`version.list/get` 按 project 返回、`UNIQUE(project_id, version_number)`。

## 9. 验收标准

- 3 表通过 migration 在全新 DB 与现有 DB 上都能正确创建。
- `GraphStorage.Service` 全部方法工作，测试 1–8 全绿。
- 主图/CurrentPlan/promote/版本 机制按 §4 行为正确。
- `bun typecheck` 过；`bun test`（在 `packages/core`）过。
- **零分叉**：除 §7 的注册性新增外，不改动任何 opencode 原文件；`docs/UPSTREAM-DIVERGENCE.md` 登记 §7 两处。
- `git merge upstream/dev` 无冲突（新增文件）。

## 10. 与上游同步

本子项目全部为新增文件（`packages/core/src/graph/*` + migration 注册条目），符合「扩展不修改」。merge 上游时唯一可能需要核对的是 §7 那两处注册文件（`schema.gen.ts`/`migration.gen.ts`）——若上游重构了 migration 机制，按其新机制重新登记即可。
