# 结构派生（子项目 3）— 设计 Spec

- **日期**：2026-07-01
- **状态**：已设计，待实现
- **治理**：受 `docs/graph-port-principles.md` 6 条原则约束；**原则 2（代码即真理，图是派生的）**、**原则 3（软和解，不阻断用户）** 为本层核心。
- **前置**：子项目 1（存储）+ 子项目 2（领域核心）已完成并合入 `dev`。
- **代码级真相参考**：`docs/graph-vibe/domain.md` §9、`docs/graph-vibe/data-model.md` §1.1（imported-code 模型）、Go 参考实现 `graph-vibe-coding/internal/importer/importer.go` + `internal/sync/checker.go`。

## 1. 目标与背景

让"代码即真理"落地：用 tree-sitter 从源代码**派生结构子图**（imported-code 节点/边），检测代码与图的**漂移**（drift），并按原则 3 进行**软和解**——结构自动重派生，意图标记 stale。

这是图驱动开发的数据基础：Plan/Build 模式（子项目 4）需要准确的结构子图来做影响评估、冲突检测和门控。

## 2. 架构决策

### 决策 1：TypeScript/JavaScript 优先，架构支持扩展

Go 参考只支持 Go（用 `go/ast`）。我们的 TS 移植优先支持 TypeScript/JavaScript（项目自身语言）。解析器有**语言适配器接口**，添加新语言只需新增适配器（`LanguageAdapter`），不改核心流程。

### 决策 2：确定性 ID（imported-code 节点/边）

imported-code 节点/边使用**确定性 ID**（基于路径+符号名），而非随机生成。这是 consistency check 的前提——扫描时期望节点与存储节点按 ID 匹配。

格式：
- 文件节点：`gnd_import:file:<projectID>:<relpath>`
- 声明节点：`gnd_import:decl:<projectID>:<relpath>:<kind>:<name>`
- 包含 projectID 保证跨项目全局唯一。

### 决策 3：纯内核 + Effect 封装（延续子项目 2 模式）

符号提取、图构建、一致性检查、和解计划全部是纯函数（无需 DB 即可 TDD）。`GraphDerivation.Service`（Effect）负责编排扫描/检查/和解 + 文件监听。

### 决策 4：Location-scoped 派生服务

派生服务是 Location-scoped（每个项目目录独立），依赖 Location-scoped 的 `FileSystem.Service` 和 `Watcher.Service`，同时依赖全局的 `GraphStorage.Service`（project-keyed DB）。

### 决策 5：软和解策略（原则 3）

- **结构节点（imported-code）**：自动重派生——删除 stale、新增 missing、更新 hash_mismatch。
- **意图节点（有 code_ref 的非 imported 节点）**：检测 drift，**标记 stale**（status 不变，content 中加 `stale: true`）。不删除、不阻断。
- **硬阻断**：不在本层——留给子项目 4 Build gate。

## 3. 范围

**在本子项目内（完整实现）：**

- tree-sitter 语法加载（TS/JS WASM）。
- 符号提取：解析源文件 → 提取声明（function/method/type/class/interface/enum/const/var）+ 导入关系。
- 图构建：符号 → imported-code 节点（import:file/import:decl）+ 边（contains file→decl、uses decl→decl）。
- 一致性检查：期望图（新鲜扫描）vs 存储图 → ConsistencyIssue[]（10 种 issue 类型）。
- 和解引擎：issues → reconciliation plan（结构自动修复 + 意图标记 stale）。
- 派生服务：全量扫描 + 增量更新（文件监听）+ 和解执行。
- 完整测试（TDD）。

**显式不在本子项目：**

- Plan/Build 工作流、Build gate 硬阻断 → **子项目 4**。
- AI 层（用结构子图做上下文增强）→ **子项目 5**。
- 可视化（结构子图渲染）→ **子项目 6**。
- 意图节点 stale 后的**策略决策**（阻断/警告/忽略）→ 子项目 4 Build gate。
- 多语言支持（Python/Rust/Go 等）→ 架构支持，实现延后。
- 自研 WAL/checkpoint/锁 → 不搬（opencode 已有）。

**不新增表/migration**：复用子项目 1 的 3 张表。imported-code 节点用 `category` + `content`（code_ref）+ `code_hash` 字段区分。

## 4. 模块设计

```
packages/core/src/graph/
  derivation/
    grammar.ts     — tree-sitter WASM 语法加载（lazy, 语言适配器注册）
    symbols.ts     — 纯: tree-sitter AST → Symbol[]（声明 + 导入）
    builder.ts     — 纯: Symbol[] → NodeCreate[] + EdgeCreate[]（确定性 ID）
    checker.ts     — 纯: expected view vs stored view → ConsistencyIssue[]
    reconcile.ts   — 纯: ConsistencyIssue[] → ReconciliationPlan
    derive.ts      — Effect Service: GraphDerivation.Service
```

### 4.1 语法加载 `grammar.ts`

lazy 初始化 web-tree-sitter，加载 TS/JS WASM 语法。模式参考 `packages/opencode/src/tool/shell.ts` 的 parser lazy 模式。

```ts
export interface LanguageAdapter {
  readonly name: string
  readonly extensions: string[]
  loadLanguage(): Promise<Language>
  extractSymbols(tree: Tree, source: string): Symbol[]
}

export const typescriptAdapter: LanguageAdapter  // .ts/.tsx
export const javascriptAdapter: LanguageAdapter  // .js/.jsx/.mjs/.cjs
```

WASM 来源：优先从 npm 包加载（同 shell.ts 模式）；若 npm 包不含 WASM，从 `@opentui/core/assets/` 复制到 `packages/core/assets/`（构建步骤）。实现时第一步解决。

### 4.2 符号提取 `symbols.ts`（纯函数）

从 tree-sitter AST 提取声明和导入关系。

```ts
export interface Symbol {
  readonly name: string
  readonly kind: "func" | "method" | "type" | "const" | "var"
  readonly startOffset: number
  readonly endOffset: number
  readonly startRow: number
  readonly startCol: number
}

export interface Import {
  readonly source: string          // 模块路径
  readonly importedNames: string[] // 导入的符号名
}

export interface FileSymbols {
  readonly symbols: Symbol[]
  readonly imports: Import[]
}
```

**TS/JS 提取规则**（tree-sitter 节点类型 → Symbol kind）：

| tree-sitter 节点 | kind |
|---|---|
| `function_declaration` / `generator_function_declaration` | `func` |
| `method_definition` | `method` |
| `class_declaration` | `type` |
| `interface_declaration` / `type_alias_declaration` / `enum_declaration` | `type` |
| `variable_declarator`（在 `const` 声明中） | `const` |
| `variable_declarator`（在 `let`/`var` 声明中） | `var` |

**导入提取**：`import_statement` → `Import { source, importedNames[] }`。`import_specifier` 或 `import_clause` 提取导入名。

### 4.3 图构建 `builder.ts`（纯函数）

将 `FileSymbols` + 文件路径 → graph 节点和边（确定性 ID）。

```ts
export interface BuildInput {
  readonly projectID: ProjectV2.ID
  readonly relPath: string           // 相对项目根的路径
  readonly source: string            // 源代码文本
  readonly fileSymbols: FileSymbols
}

export interface BuildResult {
  readonly nodes: NodeCreate[]
  readonly edges: EdgeCreate[]
  readonly codeHash: string          // sha256(source)
}

export function buildFileGraph(input: BuildInput): BuildResult
```

**节点创建规则**：

| 节点 | type | level | category | content | code_hash |
|---|---|---|---|---|---|
| `gnd_import:file:<projID>:<relPath>` | atomic | L2 | file | `{ code_ref: { path: relPath, type: "file" } }` | sha256(文件全文) |
| `gnd_import:decl:<projID>:<relPath>:<kind>:<name>` | atomic | L2 | <kind> | `{ code_ref: { path: relPath, type: "declaration", start_offset, end_offset } }` | sha256(声明文本片段) |

**边创建规则**：

| 边 | relation | 说明 |
|---|---|---|
| file → decl | `contains` | 每个声明一条 |
| decl → decl | `uses` | 同文件内导入引用（best-effort 名称匹配） |

**确定性边 ID**：`ged_import:<relation>:<sourceID>:<targetID>`。

> 跨文件 uses 边需要全项目符号表（文件 A 导入文件 B 的符号）。`buildFileGraph` 只处理单文件内边；跨文件边在 `derive.ts` 的扫描流程中用全项目符号表构建。

### 4.4 一致性检查 `checker.ts`（纯函数）

比较期望图（新鲜扫描）与存储图，产出 issue 列表。

```ts
export interface ConsistencyIssue {
  readonly type:
    | "hash_mismatch"        // 结构节点 code_hash 不符
    | "missing_node"         // 期望有但存储没有（新代码）
    | "stale_node"           // 存储有但期望没有（代码已删）
    | "missing_edge"
    | "stale_edge"
    | "missing_code"         // 意图节点引用的文件不存在
    | "missing_code_ref"     // 意图节点缺 code_ref
    | "invalid_code_ref"     // code_ref 格式非法
    | "intent_stale"         // 意图节点的 code_hash 不符
  readonly nodeId?: string
  readonly edgeId?: string
  readonly detail: string
  readonly expected?: unknown
  readonly stored?: unknown
}

export function checkConsistency(
  expected: { nodes: ExpectedNode[]; edges: ExpectedEdge[] },
  stored: GraphView,
  intentNodes: NodeRow[],   // 有 code_ref 的非 imported 节点
): ConsistencyIssue[]
```

**检查流程**（domain.md §9 + checker.go 移植）：

1. **结构节点比较**（expected imported nodes vs stored imported nodes）：
   - 同 ID → 比 code_hash → 不等 → `hash_mismatch`
   - 期望有、存储无 → `missing_node`
   - 存储有、期望无 → `stale_node`
2. **边比较**：同上，产出 `missing_edge` / `stale_edge`。
3. **意图节点检查**（有 code_ref 的节点）：
   - code_ref.path 文件不存在 → `missing_code`
   - 无 code_ref → `missing_code_ref`（仅 status=implemented/verified 的节点检查）
   - code_ref 格式非法 → `invalid_code_ref`
   - 文件存在但 hash 不符 → `intent_stale`

### 4.5 和解引擎 `reconcile.ts`（纯函数）

将 issues 转为可执行的和解计划。

```ts
export interface ReconciliationPlan {
  readonly structuralUpdates: {
    readonly nodesToAdd: NodeCreate[]
    readonly nodesToUpdate: { id: NodeID; codeHash: string; content: NodeContent }[]
    readonly nodesToRemove: NodeID[]
    readonly edgesToAdd: EdgeCreate[]
    readonly edgesToRemove: EdgeID[]
  }
  readonly intentStaleMarkings: NodeID[]   // 标记 stale 的意图节点 ID
}

export function buildReconciliationPlan(
  issues: ConsistencyIssue[],
  expected: { nodes: ExpectedNode[]; edges: ExpectedEdge[] },
): ReconciliationPlan
```

**和解策略（原则 3）**：

| Issue 类型 | 和解动作 |
|---|---|
| `missing_node` | 自动添加（structuralUpdates.nodesToAdd） |
| `stale_node` | 自动删除（structuralUpdates.nodesToRemove） |
| `hash_mismatch` | 自动更新 code_hash（structuralUpdates.nodesToUpdate） |
| `missing_edge` | 自动添加 |
| `stale_edge` | 自动删除 |
| `intent_stale` | 标记 stale（intentStaleMarkings）—不删除、不阻断 |
| `missing_code` | 标记 stale |
| `missing_code_ref` / `invalid_code_ref` | 报告，不自动修复 |

### 4.6 派生服务 `derive.ts`（Effect 封装）

```ts
class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphDerivation") {}
```

**方法**：

```ts
scan(input: { projectID, directory }): Effect<ScanResult>
// 全量扫描：遍历目录 → 解析每个源文件 → 构建期望图

checkConsistency(input: { projectID }): Effect<ConsistencyIssue[]>
// 加载存储的 imported-code 主图节点 → 调 checker.checkConsistency

reconcile(input: { projectID }): Effect<ReconciliationResult>
// checkConsistency → buildReconciliationPlan → 执行（storage 批量写）

sync(input: { projectID, directory }): Effect<ReconciliationResult>
// scan → checkConsistency → reconcile（一键完整流程）
```

**Location-scoped，依赖**：`FileSystem.Service`（读文件）、`GraphStorage.Service`（写图）、`Watcher.Service`（文件监听，可选）。

**文件监听**（增量更新）：

```ts
startWatching(input: { projectID, directory }): Effect<void>
// 订阅 FileSystemWatcher.Event → onFileChange → 解析受影响文件 → 增量和解
```

监听到文件变更时：
- `add`/`change`：重新解析该文件 → 构建期望节点/边 → 与存储比较 → 自动和解
- `unlink`：删除该文件关联的所有 imported-code 节点/边

> 文件监听是可选的（受 Flag 控制，同 Watcher.Service 的 gating flags）。首次使用需手动调 `sync`。

## 5. 实现要求

- **tree-sitter**：用 `web-tree-sitter`（WASM），模式参考 `shell.ts`。lazy 初始化。
- **文件遍历**：用 `FileSystemSearch.glob` 或 `FSUtil.glob` 遍历 `.ts/.tsx/.js/.jsx` 文件，尊重 `.gitignore`（`Ignore.PATTERNS`）。
- **并发**：`Effect.forEach(files, parse, { concurrency: 16 })`（参考 `read-filesystem.ts`）。
- **批量写入**：通过 `GraphDomain.Service.storage`（绕过校验）批量插入 imported-code 节点/边。
- **code_hash**：`Bun.crypto.hash("sha256")` 或 `node:crypto.createHash("sha256")`。
- **确定性 ID**：`gnd_import:` / `ged_import:` 前缀 + 路径/符号名。
- **Effect 化**：纯函数不返回 Effect；`GraphDerivation.Service` 用 `Effect.fn`。
- **零 `any`**：Symbol/Import/ConsistencyIssue/ReconciliationPlan 用 interface 定义。
- **零手改 opencode 原文件**：全部新增文件。
- **无新表/migration**。

## 6. 测试计划（TDD）

### 纯函数测试（无 DB，无 tree-sitter WASM）

| 文件 | 关键用例 |
|---|---|
| `graph-symbols.test.ts` | 给定 mock AST 节点 → 提取正确 Symbol[]（func/method/type/const/var）；导入语句解析；嵌套声明 |
| `graph-builder.test.ts` | 单文件 → 正确节点数（1 file + N decls）+ 边（contains + uses）；确定性 ID 一致性；code_hash 计算正确 |
| `graph-checker.test.ts` | hash_mismatch / missing_node / stale_node / missing_edge / stale_edge / intent_stale / missing_code 各一；空期望 vs 有存储 = 全 stale |
| `graph-reconcile.test.ts` | missing→add / stale→remove / mismatch→update / intent_stale→mark；plan 完整性 |

> symbols.ts 测试需要 tree-sitter 解析真实代码。测试中使用最小 TS 代码片段，通过 grammar.ts 加载 WASM 后解析。如果 WASM 在测试环境不可用，用 mock AST 节点测试提取逻辑。

### Effect Service 测试（带 DB）

| 文件 | 关键用例 |
|---|---|
| `graph-derive.test.ts` | scan 解析临时目录 → 返回 ScanResult；sync 执行后存储有 imported-code 节点；reconcile 清理 stale 节点；增量更新（模拟文件变更） |

## 7. 验收标准

- 语法加载：TS/JS WASM 成功加载，能解析 `.ts` 文件。
- 符号提取：正确提取 function/method/type/const/var 声明 + import 关系。
- 图构建：确定性 ID + 正确的节点/边 + code_hash。
- 一致性检查：10 种 issue 类型正确检测。
- 和解：结构自动修复 + 意图标记 stale。
- 派生服务：scan/check/reconcile/sync 全流程工作。
- `bun typecheck` 过；`bun test` 全绿。
- migration 漂移检查：无变化。
- **零分叉**：不手改任何 opencode 原文件。

## 8. 与上游同步

全部为新增文件（`packages/core/src/graph/derivation/*` + 测试）。可能需要：
- 添加 `tree-sitter-typescript` / `tree-sitter-javascript` 到 `packages/core/package.json`（如果 npm 包提供 WASM）。
- 或从 `@opentui/core/assets/` 复制 WASM 到 `packages/core/assets/`（构建步骤）。

package.json 的依赖添加是必要的**功能依赖**，登记在 `docs/UPSTREAM-DIVERGENCE.md`。
