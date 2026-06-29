# Graph Vibe — 数据模型参考

> 来源：graph-vibe-coding `internal/db/schema.sql` + `node.go`/`edge.go` + `internal/graph/validation.go`（**以代码为准**；多处与旧 PRD 不符，已按代码纠正）。
> 移植到 opencode：drizzle 在 opencode 全局 SQLite 新增图表，`project_id` 分区（见 `docs/specs/2026-06-27-graph-storage.md`）。

## 1. 节点 Node（三层模型）

**三种类型**（`type`）：
- `prd` — 需求层（"做什么"）。
- `composite` — 设计层（"怎么做"）。
- `atomic` — 实现层（具体代码单元）。

**层级**（`level`，**所有节点必填**）：`L1` / `L2`。约定 `prd=L1`、`composite=L2`、`atomic=L2`。
> ⚠️ 纠正：旧 doc 写"atomic 无 level"是**错的**——代码 `validation.go` 与 DB `CHECK(level IN ('L1','L2'))` 都要求 level 非空。

**生命周期**（`status`，默认 `pending`）：`pending → implemented → verified → deprecated`。

**字段**（`nodes`）：

| 字段 | 取值/语义 |
|---|---|
| `id` | TEXT PK |
| `type` | `prd`/`composite`/`atomic` |
| `name` | TEXT，**在同 (type, level) 内必须唯一**（`ValidateNodeCreation`，无 DB 索引） |
| `level` | `L1`/`L2`，**必填** |
| `priority` | `P0`/`P1`/`P2`/`P3` |
| `category` | atomic 受限枚举（见 §2）；composite 在 imported-code 模型里用 `package` |
| `status` | `pending`/`implemented`/`verified`/`deprecated` |
| `desc` | TEXT（prd 用）；**"≤20 字"是愿望，代码不强制** |
| `content` | JSON：`code_ref`、`project_type`/`module`、`generation_context` 等（开放 map） |
| `code_hash` | 代码指纹（同步用） |
| `test_status` | `none`/`pending`/`passed`/`failed`（仅 DB CHECK，不在 ValidateNode） |
| `confidence` | REAL `0.0–1.0`，默认 1.0 |
| `time_created`/`time_updated` | INTEGER（触发器刷 updated_at） |
| `session_id` | FK→session，nullable：**null=主图；非空=该 session 的 CurrentPlan** |
| `version_id` | 所属版本 |

> 核心不变量：`session_id` 区分主图与 CurrentPlan 子图；合并 = 把子图节点 `session_id` 置空并入主图。

### imported-code 平行模型（旧 doc 完全没提，移植要带）
逆向导入代码时会用一组特殊 `category` + `content` 键，走与普通图**不同的边规则**（见 §2）：
- 识别（`isImportedCodeNode`）：`category ∈ {package, file, func, method, type, const, var}` 或 `content` 同时含 `project_type`+`module`。
- 置信度分级（importer）：project/file = **1.0**，package/decl = **0.95**。
- 节点 ID 约定：`import:project:<module>` / `import:package:<pkg>` / `import:file:<relPath>` / `import:decl:<relPath>:<kind>:<name>`（方法名含 receiver：`A.Run`）。

## 2. 边 Edge（五种关系 + 真实规则）

有向 `source → target`。`UNIQUE(source_id, target_id, relation)`（同三元组唯一；但同对节点可有不同 relation 的多条边）。

| `relation` | 真实规则（`validation.go`） | 旧 doc 误述 |
|---|---|---|
| `contains` | **同类型 L1→L2**（prd→prd、composite→composite）**或** imported-code 链：`prd(L1)→composite(package)` / `composite(package)→atomic(file)` / `atomic(file)→atomic(decl)` | 旧写"PRD 含 Composite"——**错**，跨类型 `prd→composite` 被拒 |
| `blocks` | **同类型 + 同 level** | — |
| `addresses` | `composite→prd` 且**双边都 L2** | 旧漏了"双边 L2" |
| `uses` | `composite→atomic` 双边 L2，**或** imported-code 对（package↔package / file↔file / decl↔decl，双边 L2） | — |
| `deprecated_by` | **同类型 + 同 level** | 旧只写"旧→新" |

- **自环禁止**（`ValidateEdge`）。
- imported-code 边置信度分级：`contains`=1.0、package_uses=0.9、test_uses=0.85、推断 uses=0.75。
- 边 ID（importer）：`import:<kind>:` + sha256(source+"->"+target)。

## 3. Session（= Branch + CurrentPlan）

最多 **3 个活跃**；`active`/`archived`（只读）/`deleted`。Session = 一条分支 + 其 CurrentPlan。
- CurrentPlan 不是独立表 = 该 session 名下所有 `session_id=本session` 的 nodes/edges。
- 字段：`id/name/status/created_at/last_active/current_plan_id/merged_plans(JSON)/base_version/project_root/lock_holder/lock_time`。
- **subgraph 注册表是内存的、易失的**（进程重启即丢；session 层从 DB 的 session-scoped 行重建）。移植时按 B1：CurrentPlan 直接由 `session_id` 派生，无需内存注册表。

## 4. 版本 / 检查点 / WAL / 锁

- **`versions`**：`id`(`version_%04d`)、`version_number`(= `MAX+1`)、`message`、`checkpoint_id`、`session_id`。**每次合并写一个版本；但合并不自动建 checkpoint**（`checkpoint_id=""`）。
- **`checkpoints`**：保留最近 5 个；`session_states`/`graph_state`(JSON)、`wal_offset`、`checksum`、`is_valid`。`--hard` 回滚需要预先存在的 checkpoint。
- **`wal_logs`**：`operation_type ∈ CREATE/UPDATE/DELETE/MERGE/ROLLBACK`（实际只发 BEGIN/CREATE/UPDATE/DELETE/COMMIT，`MERGE`/`ROLLBACK` 未用）；三重 checksum（header/state/footer）；Magic `0x47564357`。
- **`locks`**：`resource_type ∈ session/node/graph`，`UNIQUE(resource_type,resource_id)`，超时清理。
> ⚠️ **WAL replay 是 stub**（`recovery.go` 空实现）。移植到 opencode 时**不照搬这套自研 WAL/锁**——opencode 已有 SQLite WAL(PRAGMA) + 事件溯源 + migration + SessionRunCoordinator 提供持久化与并发，重复造无意义。

## 5. 执行与审计表（agent workflow 产物，详见 `workflow.md`）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `generation_runs` | 单次图门控的代码生成 | `node_id, executor, backend, model, context_snapshot_hash, status(succeeded/failed/dry_run)` |
| `generation_jobs` | **durable** Web 生成作业（队列/可取消/可续） | `status(queued/running/succeeded/failed/cancelled), cancel_requested_at` |
| `tool_runs` | **每次**工具/动作审计（graph/mcp/local/permission/artifact/diagnostics） | `tool_name, tool_type, input_summary, output_summary, status` |
| `permission_decisions` | 图级 allow/deny（可复用） | `decision, scope(node/session), resource_type, resource_id` |
| `session_messages` | 图关联对话/命令历史 | `role(user/assistant/system/error/tool), content, command` |
| `autopilot_runs` | Autopilot 编排 + **staged_plan** | `status, current_phase, staged_plan_goal/nodes/edges(JSON)` |
| `autopilot_attempts` | Autopilot 每次尝试（重复失败跟踪） | `phase, attempt_index, diagnostics_signature` |
| `graph_summaries` | 图原生紧凑摘要 | `scope(session/node), source_hash, message/tool/generation 计数` |
| `context_snapshots`(+`_files`) | 项目上下文快照（Build 漂移门控用） | `hash, root` + 文件 `rel_path/hash/content` |

## 6. 索引与约束（移植要点）
- 节点：`type`/`level`/`status`/`session_id`/`version_id`；边：`source_id`/`target_id`/`relation`/`(source,relation)`/`(source,target,relation)`。
- 外键 `ON DELETE CASCADE`（删 session 级联清图表；删节点级联清边）。
- DB CHECK 约束强制上述枚举；**语义级规则**（边的类型/方向、名称唯一、自环、环检测）在应用层 `ValidationService`（见 `domain.md`）。

## 7. 移植到 opencode 的注意
- 图表加进 opencode 全局 SQLite，`project_id` FK→`project`、`session_id` FK→opencode `session`（B1：graph 分支 = opencode session）。
- `content`/`merged_plans`/`staged_plan_*`/`graph_state` 等 JSON 用 Schema 定义结构。
- `level` 必填、边的类型规则、imported-code 模型、名称唯一——这些**代码级真相直接采用**。
- 自研 WAL/锁/checkpoint **不搬**（opencode 已有）；durable `generation_jobs` 的"per-node 单跑 + 超时 + 重启恢复"模式值得借鉴。
- ⚠️ 我们的存储 spec §3.1 写"atomic 的 level 可空"——按本纠正应改为 **level 必填**，spec 需对齐（待办）。
