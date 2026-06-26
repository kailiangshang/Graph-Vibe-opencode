# Graph Vibe — 领域模型与同步恢复

> 来源：graph-vibe-coding `internal/session/`、`internal/graph/`、`internal/sync/`。概念提炼。
> 数据结构见 `data-model.md`；这里讲行为与语义。

## 1. Session = Branch + CurrentPlan

- **最多 3 个活跃 Session**（`active`）；归档（`archived`）只读；删除（`deleted`）。
- Session 是「图上的一条分支」：在其上做的节点/边改动，都带 `session_id = 本session`，**不污染主图**，直到合并。
- **CurrentPlan**：当前 Session 里「计划要做但还没合并进主图」的子图（即所有 `session_id = 本session` 的 nodes/edges）。
  - `add` / `remove` / `clear` / 统计。
  - 合并（`/merge`）后 CurrentPlan 清空，节点并入主图（`session_id` 置空）。
- **Branch 操作**：`create` / `switch`（支持 序号/ID/Name/last）/ 归档保护（只读）。
- 命令体系（旧项目用 `%`/`/`）：`new` `list` `switch` `merge` `sync` `drop` `archive` `rollback` `resolve` `mode`。

## 2. 子图管理（Subgraph）

- 子图通过 `session_id` **隔离**于主图。
- 支持 session 级与节点级子图操作（创建/更新/删除）。
- 子图是 Plan 的载体，也是合并/冲突检测的输入单位。

## 3. 合并算法（Merge）

子图 → 主图：
1. 检查 CurrentPlan 非空。
2. **冲突检测**（见 §4）。
3. 支持 `--dry-run` 预览。
4. 节点/边并入主图（`session_id` 置空），**版本自动保存**。
5. 清空 CurrentPlan，记录合并历史（`merged_plans`）。

## 4. 冲突检测（Conflict）

语义级冲突三类：
- **节点属性冲突**：同一节点在主图与子图间属性不一致。
- **边关系冲突**：关系定义矛盾（如循环依赖、重复唯一边）。
- **blocks 依赖冲突**：依赖链断裂或环。
- 产出**冲突报告**；`/resolve` 提供策略（+ `--auto` 标志）解决。

## 5. 影响评估（Impact）

给定一个变更，评估波及范围（用于 Plan/Build 前的风险判断）：
- **直接影响**：被变更节点直接相连的节点。
- **间接影响**：沿 `blocks` 链路传播。
- **层级影响**：跨 L1/L2 层级传播。
- 实现 = 图遍历（BFS/DFS + 关系过滤），产出影响报告。

## 6. 约束校验（Validation）

写入图前校验，拒绝违规：
- **层级约束**：PRD(L1)/Composite(L2)/Atomic 层级规则（如 `contains` 必须 L1→L2）。
- **边类型约束**：5 种关系的方向/端点类型规则（见 `data-model.md` §2）。
- **同级连接规则**：哪些同级节点可互连。
- **唯一性**：`(source, target, relation)` 不重复。

## 7. 图遍历（Traversal）

- BFS / DFS，带**关系过滤**（只沿指定 relation 走）。
- 用于影响评估、依赖分析、可视化链路高亮。
- 性能目标（旧）：10000 节点遍历 < 100ms。

## 8. 版本管理（Version）

- 每次合并 = 一个 `version` 快照（关联 checkpoint）。
- 历史查询、回滚（`/rollback --hard` 回到检查点）。
- 版本 diff（旧项目标记"待实现"——移植时可补）。

## 9. 同步保障（Sync）—— 本 fork 有意改写

> ⚠️ 与旧 PRD F37「不一致即硬阻断」不同，本 fork 采用**软和解**（见 foundation spec 原则 3）。

**一致性检测（ConsistencyChecker）**：
- `code_hash` 比对：节点记录的代码指纹 vs 实际代码指纹。
- CodeRef 验证：节点引用的代码位置是否还存在/匹配。
- 差异报告：`missing_code`（代码没了）、`hash_mismatch`（代码改了）。

**和解策略（本 fork）**：
- 结构子图（能从代码派生的）：**自动重新派生**（用 tree-sitter 重 parse 受影响节点）。
- 意图子图（PRD/Plan/决策）：drift 时**标 `stale`/`needs-review`，不阻断**。
- 硬阻断**仅**在 CurrentPlan 的 Build gate（提交受控变更时）；日常 chat/外部编辑永不阻断。

**代码快照（Snapshot）**：tar.gz 备份/恢复（Build 前可自动快照）。

**故障恢复（Recovery）**：
- 启动检测是否需要恢复 → 清理残留锁 → WAL 回放 → `PRAGMA integrity_check` → 干净关闭标记。
- WAL 提供 BEGIN/COMMIT/ROLLBACK 事务边界 + 三重 checksum，损坏记录可检测。

## 10. 移植到 opencode 的注意

- Session/CurrentPlan 的 `session_id` 隔离机制直接照搬（这是图分支的精髓）。
- 合并/冲突/影响/校验是**纯图算法**，TS 重写即可，无外部依赖。
- 同步层是本 fork 的**改写重点**：把"硬阻断"换成"软和解 + Build gate"。一致性检测逻辑可复用，决策逻辑要按 foundation 改。
- opencode 已有 tree-sitter，结构派生用它；opencode 已有文件监听（`@parcel/watcher`），drift 检测可挂上去。
