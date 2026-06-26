# Graph Vibe — 数据模型参考

> 来源：graph-vibe-coding `internal/db/schema.sql` + `node.go` + `edge.go`。语言无关的抽象提炼。
> 移植到 opencode 时，可用 drizzle 在 opencode 现有 SQLite 上新增这些表（或独立 graph db）。

## 1. 节点 Node（三层模型）

**三种类型**（`type`）：
- `prd` — 需求层，描述「做什么」。`desc` 专用（≤20 字）。
- `composite` — 设计层，描述「怎么做」。
- `atomic` — 实现层，对应具体代码单元。带 `category`（分类）。

**层级**（`level`）：`L1`（PRD）/ `L2`（Composite）。Atomic 无 level（隐式实现层）。

**生命周期**（`status`）：`pending → implemented → verified → deprecated`。

**字段全表**（节点表 `nodes`）：

| 字段 | 类型/取值 | 语义 |
|---|---|---|
| `id` | TEXT PK | 节点 ID |
| `type` | `prd`/`composite`/`atomic` | 三层类型 |
| `name` | TEXT | 名称 |
| `level` | `L1`/`L2` | 层级 |
| `priority` | `P0`/`P1`/`P2`/`P3` | 优先级 |
| `category` | TEXT (仅 atomic) | 分类 |
| `status` | `pending`/`implemented`/`verified`/`deprecated` | 生命周期 |
| `desc` | TEXT (仅 prd) | 一句话需求，≤20 字 |
| `content` | JSON | CodeRef / InputTypes / OutputType 等实现元数据 |
| `code_hash` | TEXT | 对应代码指纹（同步检测用） |
| `test_status` | `none`/`pending`/`passed`/`failed` | 测试状态 |
| `confidence` | REAL 0.0–1.0 | 置信度（导入/推断标注） |
| `created_at`/`updated_at` | INTEGER (unix) | 时间戳（触发器自动更新 updated_at） |
| `session_id` | TEXT FK→sessions, nullable | **null = 主图（已提交）；非空 = 某 Session 的 CurrentPlan 临时节点** |
| `version_id` | TEXT | 所属版本 |

> 关键不变量：`session_id` 区分「主图」与「Session 工作区（CurrentPlan 子图）」。合并 = 把子图节点的 `session_id` 置空并入主图。

## 2. 边 Edge（五种关系）

边是**有向**的（`source_id → target_id`）。

| `relation` | 方向 | 语义 |
|---|---|---|
| `contains` | L1 → L2 | 父子包含（PRD 含 Composite） |
| `blocks` | 同级 | 依赖阻塞（A 阻塞 B） |
| `addresses` | Composite → PRD | 实现关系（该设计实现了某需求） |
| `uses` | Composite → Atomic | 使用关系（该设计用到某实现单元） |
| `deprecated_by` | 旧 → 新 | 替代关系 |

**字段**（边表 `edges`）：`id` PK · `source_id`/`target_id` FK→nodes(级联删除) · `relation` · `confidence` 0–1 · `created_at` · `session_id`（临时边）。
**唯一约束**：`UNIQUE(source_id, target_id, relation)`（同三元组不重复）。

## 3. Session（= Branch + CurrentPlan）

**模型**：最多 **3 个活跃 Session**；Session = 一条分支 + 其上的 CurrentPlan（待提交子图）。

**字段**（`sessions` 表）：

| 字段 | 语义 |
|---|---|
| `id` PK, `name` | 标识与名称 |
| `status` | `active`/`archived`/`deleted`（归档只读保护） |
| `created_at`, `last_active` | 时间 |
| `current_plan_id` | 当前 Plan（子图）标识 |
| `merged_plans` | JSON：历史已合并子图列表 |
| `base_version` | 基于哪个版本创建 |
| `project_root` | 项目根目录绝对路径 |
| `lock_holder`, `lock_time` | 并发锁持有者与时间（超时清理） |

> CurrentPlan 本身不是独立表——它 = 该 session 下所有 `session_id = 本session` 的 nodes/edges。`/merge` 把它们并入主图后清空。

## 4. 版本 / 检查点 / WAL（可恢复性）

- **`versions`**：`id`, `version_number`, `message`, `checkpoint_id`, `session_id`。每次合并存一个版本快照。
- **`checkpoints`**：保留**最近 5 个**；`session_states`(JSON)、`graph_state`(JSON `{"nodes":[],"edges":[]}`)、`wal_offset`、`checksum`、`is_valid`（损坏标 0）。支持 `--hard` 回滚。
- **`wal_logs`**：事务日志。`operation_type` ∈ `CREATE/UPDATE/DELETE/MERGE/ROLLBACK`；`transaction_boundary` ∈ `BEGIN/COMMIT/ROLLBACK`；带 `before_state`/`after_state` + header/state/footer **三重 checksum**。Magic `0x47564357`('GVCW')。
- **`locks`**：`resource_type` ∈ `session/node/graph`，`UNIQUE(resource_type, resource_id)`，`expires_at` 超时清理。启动时清理残留锁。

## 5. 执行与审计（agent workflow 产物）

> 这组表是 Plan/Build/Autopilot 运行的持久化记录，构成审计链。详见 `workflow.md`。

- **`generation_runs`**：单次代码生成。`node_id`, `executor`, `backend`, `model`, `context_snapshot_hash`, `related_edge_count`, `code_path`, `test_path`, `status` ∈ `succeeded/failed/dry_run`。
- **`generation_jobs`**：**durable** Web 生成作业。`status` ∈ `queued/running/succeeded/failed/cancelled`，带 `cancel_requested_at`，可断点。
- **`tool_runs`**：每次工具调用审计。`tool_name`, `tool_type`, `executor/backend/model`, `input_summary`, `output_summary`, `status`。
- **`permission_decisions`**：图级权限决策。`decision` ∈ `allow/deny`，`scope` ∈ `node/session`，`resource_type`+`resource_id`。
- **`session_messages`**：与图关联的消息历史。`role` ∈ `user/assistant/system/error/tool`，可挂 `node_id`，`command` 字段记命令。
- **`autopilot_runs`**：Autopilot 编排状态。`status` ∈ `running/completed/needs_plan_confirmation/needs_permission/failed/cancelled`，`current_phase`，`staged_plan_goal/nodes/edges`（暂存的待确认 plan）。
- **`autopilot_attempts`**：Autopilot 每次尝试。`phase`, `attempt_index`, `status` ∈ `succeeded/failed/dry_run/blocked`, `diagnostics_signature`（重复失败检测）。
- **`graph_summaries`**：图原生紧凑摘要。`scope` ∈ `session/node`，`source_hash`，含 message/tool_run/generation_run 计数。

## 6. 上下文快照

- **`context_snapshots`**：`hash`, `root`, `created_at`。
- **`context_snapshot_files`**：`snapshot_id`, `rel_path`, `path`, `hash`, `bytes`, `content`。`PK(snapshot_id, rel_path)`。
> 用于代码生成前固化上下文（文件内容快照），保证可复现/可比对。

## 7. 索引与约束（移植要点）

- 节点索引：`type`/`level`/`status`/`session_id`/`version_id`。
- 边索引：`source_id`、`target_id`、`relation`、`(source_id,relation)`、`(source_id,target_id,relation)`。
- 各审计表按 `session_id`/`node_id`/时间建索引。
- 外键均 `ON DELETE CASCADE`（删 session 级联清其节点/边/记录；删节点级联清其边）。
- 触发器：`nodes` UPDATE 后自动刷 `updated_at`。

## 8. 移植到 opencode 的注意

- opencode 已用 drizzle + SQLite（schema 在 `packages/core/src/**/*.sql.ts`）。图的表可作为**新模块**加进去，遵循 AGENTS 的 snake_case 字段约定。
- `content`(JSON)、`merged_plans`(JSON)、`graph_state`(JSON) 在 TS 里用 Schema 定义结构（CodeRef/InputTypes/OutputType 等）。
- `session_id` 区分主图/工作区子图的核心不变量必须保留——它是「Session = Branch + CurrentPlan」的实现基石。
