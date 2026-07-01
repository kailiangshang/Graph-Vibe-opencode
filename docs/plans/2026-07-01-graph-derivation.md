# 结构派生 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Build the structural derivation layer — tree-sitter code parsing, graph building, consistency checking, soft reconciliation, and a derive service.

**Architecture:** Pure functions for symbol extraction, graph building, consistency checking, and reconciliation planning (testable without DB). `GraphDerivation.Service` (Effect) orchestrates scanning, checking, reconciliation, and file watching.

**Spec:** `docs/specs/2026-07-01-graph-derivation.md`.

**Key patterns:**
- tree-sitter WASM loading: copy of `shell.ts` parser lazy pattern
- Deterministic IDs: `gnd_import:file:<projID>:<relPath>`, `gnd_import:decl:<projID>:<relPath>:<kind>:<name>`
- Pure functions take typed input, return typed output (no Effect, no DB)
- Tests use real TS code snippets with tree-sitter WASM

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/graph/derivation/grammar.ts` | tree-sitter WASM init + TS/JS language loading |
| `packages/core/src/graph/derivation/symbols.ts` | Pure: AST → Symbol[] + Import[] |
| `packages/core/src/graph/derivation/builder.ts` | Pure: FileSymbols → NodeCreate[] + EdgeCreate[] |
| `packages/core/src/graph/derivation/checker.ts` | Pure: expected vs stored → ConsistencyIssue[] |
| `packages/core/src/graph/derivation/reconcile.ts` | Pure: issues → ReconciliationPlan |
| `packages/core/src/graph/derivation/derive.ts` | Effect: GraphDerivation.Service |

Dependency order: grammar → symbols (needs parser) → builder (needs symbols) → checker (needs expected types from builder) → reconcile (needs checker) → derive (needs all).

---

### Task 1: Grammar loading + symbol extraction

**Files:** `grammar.ts`, `symbols.ts`, `test/graph-symbols.test.ts`

**grammar.ts** — lazy tree-sitter init:
- `Parser.init()` with engine WASM from `web-tree-sitter/tree-sitter.wasm`
- Load TS grammar from `packages/core/assets/tree-sitter-typescript.wasm` via `Bun.file()`
- Load JS grammar from `packages/core/assets/tree-sitter-javascript.wasm`
- Export `parseFile(filename, source): Promise<{ tree: Tree, language: Language }>`
- Language detection by extension: `.ts`/`.tsx` → typescript, `.js`/`.jsx`/`.mjs`/`.cjs` → javascript

**symbols.ts** — extract from AST:
- `extractSymbols(tree, source): FileSymbols`
- Walk AST for node types: `function_declaration`, `method_definition`, `class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `variable_declarator`
- Map to Symbol `{ name, kind, startOffset, endOffset, startRow, startCol }`
- Extract imports from `import_statement` nodes

**Tests:** parse minimal TS snippets, verify symbol extraction.

- [ ] Write failing tests (parse `const x = 1`, `function foo() {}`, `class Bar {}`, import statement)
- [ ] Implement grammar.ts + symbols.ts
- [ ] Verify pass
- [ ] Commit: `feat(core/graph): tree-sitter grammar loading + symbol extraction`

### Task 2: Graph builder

**Files:** `builder.ts`, `test/graph-builder.test.ts`

- `buildFileGraph(input: BuildInput): BuildResult`
- Create file node: `gnd_import:file:<projID>:<relPath>`, type=atomic, level=L2, category=file
- Create declaration nodes: `gnd_import:decl:<projID>:<relPath>:<kind>:<name>`, type=atomic, level=L2, category=kind
- Create contains edges: file → each declaration
- Create uses edges: declaration → imported declaration (same-file name matching)
- code_hash = sha256(source) for file, sha256(decl text) for declarations
- Also export `ExpectedNode` / `ExpectedEdge` types for checker

- [ ] Write failing tests (symbols → nodes/edges, deterministic IDs, code_hash)
- [ ] Implement builder.ts
- [ ] Verify pass
- [ ] Commit: `feat(core/graph): structural graph builder — deterministic IDs + code_hash`

### Task 3: Consistency checker

**Files:** `checker.ts`, `test/graph-checker.test.ts`

- `checkConsistency(expected, stored, intentNodes): ConsistencyIssue[]`
- Compare expected imported nodes vs stored imported nodes by ID
- Issue types: hash_mismatch, missing_node, stale_node, missing_edge, stale_edge, missing_code, missing_code_ref, invalid_code_ref, intent_stale

- [ ] Write failing tests (each issue type scenario)
- [ ] Implement checker.ts
- [ ] Verify pass
- [ ] Commit: `feat(core/graph): consistency checker — 10 drift issue types`

### Task 4: Reconciliation engine

**Files:** `reconcile.ts`, `test/graph-reconcile.test.ts`

- `buildReconciliationPlan(issues, expected): ReconciliationPlan`
- Structural: auto-add missing, auto-remove stale, auto-update mismatched
- Intent: mark stale (collect IDs)

- [ ] Write failing tests (issue → correct action)
- [ ] Implement reconcile.ts
- [ ] Verify pass
- [ ] Commit: `feat(core/graph): reconciliation engine — soft reconciliation per principle 3`

### Task 5: Derive service

**Files:** `derive.ts`, `test/graph-derive.test.ts`

- `GraphDerivation.Service` (`@opencode/v2/GraphDerivation`)
- Methods: `scan`, `checkConsistency`, `reconcile`, `sync`
- Depends on: `GraphStorage.Service`, `FileSystem.Service`
- scan: glob source files → parse each → build expected graph
- sync: scan → check → reconcile → execute (bulk write via storage)

- [ ] Write failing tests (scan temp dir, sync writes nodes to DB, reconcile removes stale)
- [ ] Implement derive.ts
- [ ] Verify pass
- [ ] Commit: `feat(core/graph): derive service — scan/check/reconcile/sync`

### Task 6: Finalize

- [ ] `bun typecheck` — clean
- [ ] `bun test` — all green
- [ ] `migration --check` — no drift
- [ ] divergence check — only new files
- [ ] Update UPSTREAM-DIVERGENCE.md if package.json deps added
