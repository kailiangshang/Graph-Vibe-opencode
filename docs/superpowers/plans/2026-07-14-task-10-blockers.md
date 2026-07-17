# Task 10 Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Task 10 durability, gating, validation, source-boundary, and generated-client blockers while preserving opt-in, initially unselected sessions.

**Architecture:** Keep migration admission and mutation invariants in Core transactions, place product gates before every write-producing boundary, persist an explicit imported-session closure inventory for validation, and make source discovery bounded before materialization. Fix legacy OpenAPI at its transform boundary so generated high-level and low-level SDK contracts naturally agree.

**Tech Stack:** TypeScript, Effect v4, Drizzle SQLite, Bun SQLite/filesystem APIs, Effect HttpApi/OpenAPI, Hey API SDK generation, Bun test.

---

### Task 1: Rediscovery And Fresh-Start Immutability

**Files:**
- Modify: `packages/core/src/product-migration/service.ts`
- Modify: `packages/core/src/product-migration/state.ts`
- Test: `packages/core/test/product-migration-service.test.ts`
- Test: `packages/core/test/product-migration-state.test.ts`

- [ ] Add failing tests that start execution, leave completed/failed items and entity mappings, then assert rediscovery cannot replace the plan/items and fresh-start cannot erase partial work.
- [ ] Run `bun test test/product-migration-service.test.ts test/product-migration-state.test.ts` from `packages/core` and confirm the new tests fail.
- [ ] Make discovery transactionally accept only no journal or a draft whose existing items are all pending and whose entity mapping count is zero; return bounded `Conflict` or `InvalidTransition` otherwise.
- [ ] Make fresh-start apply the same pristine predicate, delete pending items and mappings, clear source/plan/validation, and complete atomically.
- [ ] Rerun the focused tests and confirm they pass without changing planner defaults (`sessionsEnabled: false`, every session `selected: false`).

### Task 2: Complete Session Write Gate

**Files:**
- Modify: `packages/core/src/session.ts`
- Modify: `packages/protocol/src/groups/session.ts`
- Modify: `packages/server/src/handlers/session.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Modify: `packages/opencode/src/cli/cmd/import.ts`
- Test: `packages/core/test/product-migration-gate.test.ts`
- Test: `packages/opencode/test/session/prompt.test.ts`
- Test: `packages/opencode/test/server/product-migration-api.test.ts`
- Test: focused CLI import test under `packages/opencode/test/cli/`

- [ ] Add failing tests proving V2 switch-agent, switch-model, revert stage/clear/commit, legacy init/summarize/promptAsync, and CLI import produce no session/message/event/compaction writes before completion.
- [ ] Run focused gate tests and confirm each new entry point fails or incorrectly returns 204 before implementation.
- [ ] Call `ProductMigrationState.requireCompleted()` before every mutation or fork; preserve `ProductMigration.Required` through HTTP/CLI boundaries instead of mapping it to `BadRequest` or background logging.
- [ ] Update method and HttpApi error contracts for all gated endpoints.
- [ ] Search session creation/mutation/execution call sites and close equivalent direct-write bypasses found by the search.
- [ ] Rerun V2, legacy, API, and CLI focused tests.

### Task 3: Required Artifact And Closure Validation

**Files:**
- Modify: `packages/core/src/product-migration/config.ts`
- Modify: `packages/core/src/product-migration/session.ts`
- Modify: `packages/core/src/product-migration/service.ts`
- Test: `packages/core/test/product-migration-config.test.ts`
- Test: `packages/core/test/product-migration-session.test.ts`
- Test: `packages/core/test/product-migration-service.test.ts`
- Test: `packages/opencode/test/server/product-migration-api.test.ts`

- [ ] Add failing deletion regressions for selected config, auth, MCP auth, imported credential DB rows, every imported session row family, and copied content-addressed files.
- [ ] Persist source closure counts and copied-file count/hash inventory in the session migration metadata written during import.
- [ ] Require a nonempty expected target config tree for config selection, `mcp-auth.json` for MCP, and either `auth.json` or imported target credential rows for credentials; enforce private modes.
- [ ] Compare target legacy messages, parts, current messages, inputs, todos, and copied-file inventory against imported metadata while retaining FK, pending-input, marker, and Graph-version checks.
- [ ] Rerun all product migration config/session/service/API validation tests.

### Task 4: Crash-Safe Config Retry

**Files:**
- Modify: `packages/core/src/product-migration/config.ts`
- Test: `packages/core/test/product-migration-config.test.ts`
- Test: `packages/core/test/product-migration-service.test.ts`

- [ ] Add a failing interrupted-copy fixture where package installation created `package.json`, lockfiles, `node_modules`, and known disposable install artifacts before journal item completion.
- [ ] Filter the same migration-generated/disposable names on both sides of `sameTree`, while comparing all user-owned config files byte-for-byte and rejecting symlinks/conflicts.
- [ ] Rerun config and service recovery tests.

### Task 5: Descriptor-Safe Bounded Manifest Traversal

**Files:**
- Modify: `packages/core/src/product-migration/source.ts`
- Test: `packages/core/test/product-migration-source.test.ts`

- [ ] Add failing directory-count overflow and lstat/open identity-swap regressions.
- [ ] Count accepted directories and files against one entry budget; reject any directory listing that would exceed the remaining budget before recursively processing it.
- [ ] Read each file with `O_RDONLY | O_NOFOLLOW`, verify descriptor `dev`, `ino`, regular-file type, and size against `lstat`, enforce byte limits before read, and hash descriptor bytes exactly.
- [ ] Rerun source tests.

### Task 6: Bounded Linear DB Inventory

**Files:**
- Modify: `packages/core/src/product-migration/source.ts`
- Test: `packages/core/test/product-migration-source.test.ts`

- [ ] Add failing fixtures whose project/session counts exceed explicit caps and whose inventory rows are corrupt.
- [ ] Query counts first, reject oversized sources with `SourceReadError`, fetch only after bounds pass, and group sessions in a single map pass before mapping projects.
- [ ] Rerun source and planner tests and assert sessions remain unselected.

### Task 7: Natural Required SDK Bodies

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/public.ts`
- Modify: `packages/sdk/js/script/build.ts`
- Modify: `packages/sdk/js/test/product-migration.test.ts`
- Modify: `packages/sdk/js/test/fixtures/product-migration.ts`
- Regenerate: `packages/client/src/generated/`, `packages/client/src/generated-effect/`, `packages/sdk/js/src/v2/gen/`

- [ ] Add compile assertions that every migration SDK method parameter and every low-level `ProductMigration*Data.body` is required.
- [ ] Change the legacy OpenAPI transform to preserve `requestBody.required = true` only under `/global/product-migration/**`, while continuing to strip it for other legacy routes.
- [ ] Remove the migration-specific SDK text-rewrite workaround.
- [ ] Regenerate both client families and run SDK compile/runtime serialization tests.
- [ ] Regenerate a second time and compare generated diff hashes for determinism.

### Task 8: Corruption Mapping And Full Verification

**Files:**
- Modify only remaining raw journal decode sites discovered by search.
- Preserve: `docs/superpowers/reports/2026-07-10-graph-collaboration-ux.md`

- [ ] Search raw plan, validation, and journal decoding paths; map bounded corrupt data to `ProductMigration.SourceError` or `ProductMigration.Conflict`, leaving genuine DB infrastructure defects as generic 500s.
- [ ] Run all Core Task 7-10 tests, focused V2/legacy/CLI gate tests, migration API tests, and SDK tests.
- [ ] Run `bun typecheck` from every affected package: Schema, Core, Protocol, Server, OpenCode, Client, and SDK.
- [ ] Run `git diff --check`, verify sessions remain opt-in/unselected, inspect the final worktree, and do not commit.
