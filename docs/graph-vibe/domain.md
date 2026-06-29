# Graph Vibe — 领域模型与同步恢复

> 来源：graph-vibe-coding `internal/session/`、`internal/graph/`、`internal/sync/`（**以代码为准**）。
> 数据结构见 `data-model.md`；这里讲行为/语义。原则性偏离见 `docs/graph-port-principles.md`。

## 1. Session = Branch + CurrentPlan

- 最多 3 个活跃 Session；Session 是图上的一条分支：其上的节点/边改动都带 `session_id=本session`，**不污染主图**，直到合并。
- **CurrentPlan** = 该 session 名下所有 `session_id=本session` 的 nodes/edges（无独立表）。合并后清空（并入主图）。
- Branch：`create` / `switch`（序号/ID/Name/last）/ `archive`（只读保护）/ `drop`。
- **移植（B1）**：graph 分支 = opencode session；CurrentPlan 直接由 `session_id` 派生。**不照搬**旧的内存 subgraph 注册表（易失、多余）。

## 2. 子图（Subgraph）
- 通过 `session_id` 隔离于主图。`AddEdge` 要求两端点同在子图内（比冲突检测更严）；`RemoveNode` 子图内级联删相关边。
- 旧代码的 subgraph 注册表是**内存的**（重启丢）——移植时按 §1 用 `session_id` 派生，不保留内存表。

## 3. 合并算法（Merge）—— 注意双路径

子图 → 主图（事务内）：
1. `ValidateSubgraph`（不过则不开事务）。
2. **diff 双路径**（关键，旧 doc 没写）：
   - **注册子图**（ID 在内存注册表里）→ `DiffSubgraph`，**会算删除**（主图中不在子图里的行被删；session-scoped 行忽略）。
   - **直接/ad-hoc 子图** → `diffProvidedSubgraph`，**不算删除**（只 walk 提供的节点/边）。
   - 两种路径都把"主图对应行 `session_id!=""`"的子图行视为**新增（提升）**。
3. **冲突检测**：⚠️ 合并路径里是**空 stub**——真正的冲突检测**只在 `/resolve` 命令里跑**（见 §4）。合并只做 `ValidateSubgraph`。
4. 应用变更（事务）：边**先删后加**（绕过 UNIQUE）；新增节点 **强制 `status="implemented"`**（旧 doc 没写）；修改节点 status 按传入值。
5. **跨 session 提升被拒**（节点属于别的 session → `ErrSyncConflict`）；主图 ID 冲突 → `ErrAlreadyExists`。
6. 写版本（`version_%04d`，`MAX+1`），**合并不建 checkpoint**。`--dry-run` = 跑 diff+计数但不应用。

> 移植判断：双路径的删除语义差异是个坑；B1 下 CurrentPlan 提升到主图（`session_id` 置空）用统一的"提升"语义即可，不必照搬双路径。"强制 status=implemented"是否保留，按我们的 Build 流程决定。

## 4. 冲突检测（Conflict）—— 5 类，且独立于合并

**5 种类型**（`conflict.go`，⚠️ 旧 doc 写"3 类"是错的）：
`node_modified` / `node_deleted`（实际触发条件是主图节点 `status=deprecated`）/ `edge_modified` / `cycle` / `constraint`（约束违规）。**没有**"blocks 依赖冲突"这一类（由 cycle/constraint 覆盖）。

- `DetectConflicts(subgraph)` 四趟：逐节点、逐边、约束违规（合并后跑 `ValidateSubgraph`）、合并后环检测（DFS，**最多报 1 个环**）。
- `DetectNodeConflict`：主图无该节点→无冲突（视为新）；主图节点 deprecated→`node_deleted`；否则字段不等→`node_modified`。**注意 `nodesEqual` 把 `SessionID`/`VersionID` 也纳入比较**（子图节点几乎总因 session_id 不同而"不等"——是个 quirk，移植时可规范化）。
- `DetectEdgeConflict`：ID 在主图则**只比 `Confidence`**（不重检 source/target/relation）；ID 不在则查 `(source,target,relation)` 是否已存在。
- `CanAutoResolve`：**只有空冲突列表返回 true**——"自动解决"实际是空操作；`AutoResolve` 只能处理可自动解决的（基本无）。
- 触发：**仅 `/resolve`**（手动 pre-merge 步骤），合并本身不调。

> 移植判断：把冲突检测**做成合并的真实前置门控**（旧代码割裂了，是缺陷），或按原则 3 只在 Build gate 硬挡、合并时软提示。`nodesEqual` 的 session_id quirk 要修。

## 5. 影响评估（Impact）—— 走全关系，无层级

`AssessImpact(nodeID)`（⚠️ 旧 doc 写"沿 blocks/层级"是**错的**）：
- **Direct** = 该节点**出边**（任意 relation）的 target。
- **Indirect** = 从各 direct 出发递归走**所有出边**（不限 relation）新到的节点。
- **Upstream** = 该节点**入边**的 source（**仅深度 1，不传递**）。
- **Downstream** = Direct ∪ Indirect。
- **没有"层级影响"**（代码里 0 处 hierarchical）。
- **风险阈值**（`CalculateRisk`）：`Direct+Indirect > 10` 或任一受影响节点 `priority=P0` → **high**；`3..10` → **medium**；`0..2` → **low**。Upstream 不计入。
- 自环怪癖：`A→A` 会把 A 自己算进 Direct（校验禁自环，但 impact 不防）。

> 移植判断：采用代码的"走全关系 + 风险阈值"（合理）；`AssessChangeImpact` 旧实现每节点跑两趟，移植合并成单趟。

## 6. 约束校验（Validation）

DB CHECK 强制枚举；语义规则在 `ValidationService`：
- **节点**：type/level(必填)/priority/status/category(atomic 枚举)/confidence(0–1) 合法性。
- **边类型矩阵**：见 `data-model.md` §2（contains 同类型 L1→L2 或 imported-code；blocks/uses/deprecated_by 同类型同 level；addresses 双边 L2；uses 可 imported-code 对）。
- **自环禁止**；**环检测**：DFS+递归栈，**relation 无关**，**主要是防御性**——因为边类型规则让合法环几乎不可能（很多"环测试"实际卡在边类型校验）。
- **名称唯一**：同 (type, level) 内 name 唯一（仅应用层，无 DB 索引）。
- `ValidateSubgraph`：先校验节点→边→**边端点必须在子图节点集内**→边类型规则→环检测。

> 移植判断：边类型矩阵 + 名称唯一 + 自环禁止**直接采用**（代码级真相，合理）。环检测保留但知晓它是防御性的。

## 7. 图遍历（Traversal）
- BFS / DFS，`relation` 过滤；**`maxDepth==0` 表示无限**（不是"深度 0"），负数也无限。
- **仅前向**（source→target），**无反向原语**；upstream 靠单独的深度-1 入边扫描。
- `FindPath` = BFS 最短路（返回 ID 路径）；`ExtractSubgraph` = 诱导子图（两端点都在集合内的边）。
- 环安全（visited 守卫）。

## 8. 版本管理（Version）
- 每次合并 = 一个 version（`version_%04d`，`MAX+1`）。
- 历史/diff/回滚（`--hard` 回到**预先存在**的 checkpoint；合并不建 checkpoint，所以纯合并后回滚受限）。
- 版本 diff 旧代码标记"待实现"——移植可补。

## 9. 同步保障（Sync）—— 本 fork 的改写重点

> ⚠️ **旧代码只做了一半**：`ApplySync` **只自动修 `hash_mismatch`**（重算写回 `code_hash`），**没有 tree-sitter 重派生、没有 stale/needs-review 标记**。我们的原则 3（软和解）是**设计意图，要从头实现**，不是照搬旧代码。

**一致性检测**（`ConsistencyChecker`，可复用）：
- 只查**主图**（`session_id=""`）、`status ∈ {implemented,verified}` 的节点。
- `code_ref.path` 不存在 → `missing_code`；`code_hash` 不符 → `hash_mismatch`；缺/坏 code_ref → `missing_code_ref`/`invalid_code_ref`。
- imported 图 diff：重扫代码（旧用 `go/ast`，移植换 **tree-sitter**）对比 `import:*` 行，产出 `missing_node/stale_node/missing_edge/stale_edge`。
- issue 类型共 10 种（远多于旧 doc 的 2 种）。

**和解策略（我们的设计，原则 3）**：
- 结构子图：**tree-sitter 自动重派生**受影响节点（旧代码没做，我们做）。
- 意图子图：drift → **标 `stale`**（旧代码没做，我们做）。
- 硬阻断**仅** Build gate；日常不阻断（旧 `BlockIfInconsistent` 实际只在 `/merge` 调，不在 Build——我们要把它正确定位到 Build gate）。

**快照（Snapshot）**：tar.gz，跳过点目录；旧代码**没有"Build 前自动快照"的接线**（独立工具）——移植按需决定。

**故障恢复**：旧 `replayWAL` 是**空 stub**。移植**不照搬自研 WAL/恢复**——靠 opencode 的 SQLite WAL + 事件溯源 + migration。仅需：启动清残留锁 + `PRAGMA integrity_check`。

**R-tree（空间索引）**：⚠️ **是死代码**（无任何接线）。纯几何，预留给可视化视口/命中测试。移植时**先不搬**；若将来 canvas 视口需要再说（前端裁剪可能就够）。

## 10. 移植到 opencode 的注意
- `session_id` 隔离机制直接用（B1）。
- 合并/冲突/影响/校验是**纯图算法**，TS 重写；**采用代码级真相**（边矩阵、冲突 5 类、影响走全关系、风险阈值），**修正割裂**（冲突真正进合并前置 or Build gate）、**修 quirk**（`nodesEqual` 的 session_id）。
- 同步层：一致性检测复用，**软和解从头实现**（旧代码半成品），tree-sitter 派生挂 opencode 的 `@parcel/watcher`。
- **不搬**：自研 WAL/checkpoint/锁/R-tree/内存 subgraph 注册表。
