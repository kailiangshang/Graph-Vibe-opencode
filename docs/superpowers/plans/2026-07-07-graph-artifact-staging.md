# Graph Artifact Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable chunked graph artifact staging, complete missing graph write APIs, and wire graph-specific realtime invalidation.

**Architecture:** A new core `GraphArtifactDraft` workflow service stores chunked artifact drafts. `graph_artifact_apply` remains the only final worktree write path and can apply either a small direct artifact or a sealed draft. Graph HTTP write endpoints and realtime events close the remaining integration gaps.

**Tech Stack:** TypeScript, Bun, Effect v4/effect-smol, Drizzle SQLite, opencode Tool API, Effect HttpApi, SolidJS app event listener.

---

## File Structure

- Create `packages/core/src/graph/workflow/artifact-draft.sql.ts`: Drizzle table for durable staged artifacts.
- Create `packages/core/src/graph/workflow/artifact-draft.ts`: Effect service for draft lifecycle and assembly.
- Modify `packages/core/src/graph/workflow/artifact.ts`: add `FilesArtifact` support and planning.
- Modify generated core migration files by running the migration script.
- Create `packages/core/test/graph-artifact-draft.test.ts`: core service tests.
- Modify `packages/opencode/src/tool/graph/build-gate.ts`: add schema for `files` artifact.
- Modify `packages/opencode/src/tool/graph/artifact-apply.ts`: accept either direct artifact or `draftID`, enforce direct size threshold, apply sealed drafts.
- Create `packages/opencode/src/tool/graph/artifact-begin.ts`: create an open artifact draft.
- Create `packages/opencode/src/tool/graph/artifact-chunk.ts`: add/replace a chunk.
- Create `packages/opencode/src/tool/graph/artifact-seal.ts`: seal and validate a draft.
- Modify `packages/opencode/src/tool/registry.ts`: register staged artifact tools in graph mode.
- Modify `packages/opencode/src/tool/graph/prompt.txt`: instruct staged flow for large/multi-file artifacts.
- Create/modify opencode graph tool tests for begin/chunk/seal/apply/registry/prompt.
- Modify schema event files and graph HTTP handlers/groups for write API and events.
- Modify `packages/app/src/pages/graph.tsx`: invalidate on graph events.

## Task 1: Core Multi-File Artifact Planning

**Files:**
- Modify: `packages/core/src/graph/workflow/artifact.ts`
- Test: `packages/core/test/graph-artifact.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving `files` artifacts validate non-empty test text, reject empty files, and plan multiple full file contents.

- [ ] **Step 2: Verify RED**

Run from `packages/core`: `bun test test/graph-artifact.test.ts`

Expected: fails because `files` mode is not supported.

- [ ] **Step 3: Implement minimal `files` artifact support**

Extend `Artifact` with `FilesArtifact`, add validation for non-empty test/path/code, and update `planArtifactApplication` to return all full file contents.

- [ ] **Step 4: Verify GREEN**

Run from `packages/core`: `bun test test/graph-artifact.test.ts`

Expected: all tests pass.

## Task 2: Durable Artifact Draft Service

**Files:**
- Create: `packages/core/src/graph/workflow/artifact-draft.sql.ts`
- Create: `packages/core/src/graph/workflow/artifact-draft.ts`
- Test: `packages/core/test/graph-artifact-draft.test.ts`
- Generated: core migration/schema files via migration script

- [ ] **Step 1: Write failing service tests**

Cover create/get/list, chunk replacement, seal success, missing chunk failure, SHA-256 mismatch failure, mark applied, cancel, and assembled `files` artifact output.

- [ ] **Step 2: Verify RED**

Run from `packages/core`: `bun test test/graph-artifact-draft.test.ts`

Expected: fails because service/table do not exist.

- [ ] **Step 3: Add table, service, and migration**

Use snake_case table columns and Effect service patterns. Keep synchronous validation inside helpers and effectful DB work in service methods.

- [ ] **Step 4: Verify GREEN**

Run from `packages/core`: `bun test test/graph-artifact.test.ts test/graph-artifact-draft.test.ts && bun typecheck`

Expected: tests and typecheck pass.

## Task 3: Staged Artifact Tools

**Files:**
- Create: `packages/opencode/src/tool/graph/artifact-begin.ts`
- Create: `packages/opencode/src/tool/graph/artifact-chunk.ts`
- Create: `packages/opencode/src/tool/graph/artifact-seal.ts`
- Modify: `packages/opencode/src/tool/graph/build-gate.ts`
- Modify: `packages/opencode/src/tool/graph/artifact-apply.ts`
- Modify: `packages/opencode/src/tool/registry.ts`
- Modify: `packages/opencode/src/tool/graph/prompt.txt`
- Test: `packages/opencode/test/tool/graph-artifact-stage.test.ts`
- Test: `packages/opencode/test/tool/graph-artifact-apply.test.ts`
- Test: `packages/opencode/test/tool/graph-mode.test.ts`
- Test: `packages/opencode/test/session/graph-instruction.test.ts`

- [ ] **Step 1: Write failing opencode tool tests**

Cover begin/chunk/seal/apply staged success, staged apply with Build gate block no permission/no write, direct oversize block, exact-one-of artifact/draftID validation, and graph mode registry/prompt exposure.

- [ ] **Step 2: Verify RED**

Run from `packages/opencode`: `bun test test/tool/graph-artifact-stage.test.ts test/tool/graph-artifact-apply.test.ts test/tool/graph-mode.test.ts test/session/graph-instruction.test.ts`

Expected: staged tool tests fail because tools are missing and apply has no `draftID` support.

- [ ] **Step 3: Implement staged tools and apply integration**

Resolve graph session, normalize/validate paths before storing drafts, emit metadata progress for staging operations, keep permission and writes only in `graph_artifact_apply`, and mark drafts applied only after successful writes.

- [ ] **Step 4: Verify GREEN**

Run from `packages/opencode`: `bun test test/tool/graph-artifact-stage.test.ts test/tool/graph-artifact-apply.test.ts test/tool/graph-mode.test.ts test/session/graph-instruction.test.ts && bun typecheck`

Expected: tests and typecheck pass.

## Task 4: Graph Write API And SDK Generation

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`
- Test: existing graph HttpApi tests or new focused graph HttpApi test
- Generated: legacy JS SDK files via `./packages/sdk/js/script/build.ts`

- [ ] **Step 1: Write failing HttpApi tests**

Cover `POST /graph/plan/admit`, `PATCH /graph/node/:nodeID/status`, and `POST /graph/current-plan/promote`, including validation/not-found translation.

- [ ] **Step 2: Verify RED**

Run the focused graph HttpApi tests from `packages/opencode`.

Expected: fails because endpoints are missing.

- [ ] **Step 3: Implement handlers and regenerate SDK**

Handlers must derive project/session context, call `GraphPlan`/`GraphDomain`, map expected errors, and not trust payload project IDs. Run `./packages/sdk/js/script/build.ts` after HttpApi changes.

- [ ] **Step 4: Verify GREEN**

Run focused graph HttpApi tests and `bun typecheck` from affected packages.

Expected: tests and typecheck pass.

## Task 5: Graph Realtime Events

**Files:**
- Modify/Create: schema event definitions and event manifest files under `packages/schema/src`
- Modify: graph tool and HttpApi mutation sites to publish graph events
- Modify: `packages/app/src/pages/graph.tsx`
- Tests: schema/event manifest tests, graph page or server-session focused tests where available

- [ ] **Step 1: Write failing tests**

Cover event manifest includes `graph.plan.updated` and `graph.main.updated`, and graph page invalidates graph queries for these event types.

- [ ] **Step 2: Verify RED**

Run focused schema/app tests.

Expected: fails because event types and listener handling are missing.

- [ ] **Step 3: Implement graph event definitions, publish sites, and app listener**

Publish one event after each high-level mutation. Avoid per-row publish storms. Keep existing invalidation events as fallback.

- [ ] **Step 4: Verify GREEN**

Run focused schema/app tests plus affected package typechecks.

Expected: tests and typecheck pass.

## Task 6: Dogfood Harness And Final Verification

**Files:**
- Add or update dogfood tests under `packages/opencode/test/dogfood/`
- Use ignored path under `examples/grid-arena/` for real session dogfood output

- [ ] **Step 1: Add failing dogfood test**

Create a graph workflow test that stages a multi-file artifact with multiple chunks, seals it, applies it, runs diagnostics, and verifies final graph state.

- [ ] **Step 2: Verify RED**

Run from `packages/opencode`: focused dogfood test.

Expected: fails before staged flow is wired.

- [ ] **Step 3: Make dogfood pass and run real session dogfood**

Use graph mode tools only. Do not use raw write tools for the dogfood artifact.

- [ ] **Step 4: Final verification**

Run package-focused tests, `bun typecheck` from affected packages, SDK generation checks, and `git status --short --branch`.

Expected: all verification passes and only intended files are modified.
