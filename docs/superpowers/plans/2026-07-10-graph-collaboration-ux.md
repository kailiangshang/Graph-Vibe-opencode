# Graph Collaboration UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable collaborative Graph workflow and a restrained liquid-glass workflow cockpit that always shows the plan, current task, checkpoint, and task-specific verification evidence.

**Architecture:** Add one session-scoped workflow-state row and one shared Core projection. Enforce execution mode, current task, verified-only dependencies, and revisioned checkpoints inside `GraphBuild`; expose the projection through the existing compatibility Graph HTTP API and generated legacy SDK. Web and TUI consume that projection, while conversation renderers translate internal tool IDs into user-facing workflow activities.

**Tech Stack:** TypeScript, Effect v4, Drizzle SQLite, Effect HttpApi, SolidJS, OpenTUI, Canvas 2D, Bun test, Playwright, generated legacy JavaScript SDK.

---

## File Structure

### Shared contracts and persistence

- Modify `packages/schema/src/graph.ts`: execution-mode, checkpoint, verification, evidence, and workflow event schemas.
- Modify `packages/core/src/graph/sql.ts`: persist atomic verification specifications.
- Create `packages/core/src/graph/workflow/state.sql.ts`: one durable workflow authority row per session.
- Create `packages/core/src/graph/workflow/state.ts`: state reads, revisioned mutations, approval, pause, and advancement.
- Create `packages/core/src/graph/workflow/projection.ts`: ordered atomic tasks, module grouping, current task, parent rollups, progress, and evidence projection.
- Modify `packages/core/src/graph/workflow/audit.sql.ts` and `audit.ts`: bounded structured evidence.
- Generate Core migration/schema registry files with the migration script.

### Enforcement and tools

- Modify `packages/core/src/graph/workflow/gate.ts`: durable workflow authority, atomic-only targets, and verified-only dependencies.
- Modify `packages/core/src/graph/workflow/build.ts`: load workflow state before shared gate evaluation.
- Modify `packages/core/src/graph/workflow/plan.ts`: initialize/reset workflow state transactionally.
- Modify `packages/core/src/tool/graph.ts`: task-specific diagnostics evidence and workflow advancement.
- Modify legacy adapters under `packages/opencode/src/tool/graph/`: keep behavior aligned through shared Core services.

### HTTP and clients

- Modify `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`: workflow projection/mode/checkpoint contracts and evidence response.
- Modify `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`: handlers and narrowed status mutation.
- Modify `packages/opencode/test/server/graph-api.test.ts`: API behavior and stale-revision coverage.
- Regenerate `packages/sdk/js/src/v2/gen/*` through `./packages/sdk/js/script/build.ts`.

### Conversation and TUI

- Modify `packages/core/src/graph/workflow/prompt.ts`: collaborative vocabulary and execution-mode rules.
- Modify `packages/session-ui/src/components/message-part.tsx`: user-facing Graph activity cards.
- Modify `packages/tui/src/routes/session/index.tsx`: user-facing Graph activity labels.
- Modify `packages/tui/src/graph/workflow.ts`, `packages/tui/src/app.tsx`, and Graph dialogs: mode, task list, checkpoint, continue, and pause.

### Graph Web

- Rewrite `packages/app/src/pages/graph-helpers.ts`: normalized workflow view models and pure selection/order helpers.
- Create `packages/app/src/pages/graph-canvas.tsx`: reactive deterministic Canvas boundary.
- Create `packages/app/src/pages/graph-cockpit.tsx`: desktop task/canvas/inspector and mobile tabs.
- Simplify `packages/app/src/pages/graph.tsx`: query/mutation orchestration only.
- Add focused helper/component/Playwright tests.

---

### Task 1: Add Workflow Contracts And Durable Schema

**Files:**
- Modify: `packages/schema/src/graph.ts`
- Modify: `packages/core/src/graph/sql.ts`
- Create: `packages/core/src/graph/workflow/state.sql.ts`
- Modify: `packages/core/src/graph/workflow/audit.sql.ts`
- Test: `packages/core/test/graph-workflow-state.test.ts`
- Generated: `packages/core/schema.json`
- Generated: `packages/core/src/database/schema.gen.ts`
- Generated: `packages/core/src/database/migration.gen.ts`
- Generated: `packages/core/src/database/migration/<timestamp>_graph_collaboration.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that construct valid modes/checkpoints and reject malformed verification paths:

```ts
import { describe, expect, test } from "bun:test"
import { Graph } from "@opencode-ai/schema"
import { Schema } from "effect"

describe("Graph collaboration schemas", () => {
  test("accepts the three execution modes", () => {
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("atomic")).toBe("atomic")
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("module")).toBe("module")
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("autopilot")).toBe("autopilot")
  })

  test("requires task verification criteria and safe relative paths", () => {
    expect(() => Schema.decodeUnknownSync(Graph.VerificationSpec)({ criteria: [], diagnostics: [] })).toThrow()
    expect(() => Schema.decodeUnknownSync(Graph.VerificationSpec)({
      criteria: ["theme can be changed"],
      diagnostics: [{ name: "test", paths: ["../outside.test.ts"] }],
    })).toThrow()
  })
})
```

- [ ] **Step 2: Run the schema tests and confirm RED**

Run from `packages/core`:

```bash
bun test test/graph-workflow-state.test.ts
```

Expected: FAIL because `ExecutionMode`, `VerificationSpec`, and the workflow table do not exist.

- [ ] **Step 3: Add shared schemas**

Define these exact exported contracts in `packages/schema/src/graph.ts`:

```ts
export const ExecutionMode = Schema.Literals(["atomic", "module", "autopilot"])
export type ExecutionMode = typeof ExecutionMode.Type

export const CheckpointKind = Schema.Literals(["atomic", "module", "decision", "failure", "pause"])
export type CheckpointKind = typeof CheckpointKind.Type

export const CheckpointStatus = Schema.Literals(["none", "pending", "approved"])
export type CheckpointStatus = typeof CheckpointStatus.Type

export const DiagnosticName = Schema.Literals(["test", "typecheck", "lint"])
export const VerificationSpec = Schema.Struct({
  criteria: Schema.NonEmptyArray(Schema.String.pipe(Schema.minLength(1))),
  diagnostics: Schema.NonEmptyArray(Schema.Struct({
    name: DiagnosticName,
    paths: Schema.optional(Schema.Array(RelativePath)),
  })),
})
export type VerificationSpec = typeof VerificationSpec.Type
```

Implement `RelativePath` as a schema refinement that rejects absolute paths, empty segments, and `..` segments.

- [ ] **Step 4: Add Drizzle columns and the workflow table**

Add `verification` JSON to `GraphNodeTable`, `evidence` JSON to `GraphToolRunTable`, and create `GraphWorkflowStateTable` with snake_case fields from the approved design. Use foreign-key cascades for session/project and `set null` for current/scope node deletion.

- [ ] **Step 5: Generate and inspect the migration**

Run from `packages/core`:

```bash
bun run migration --name graph_collaboration
bun run migration --check
```

Expected: one incremental migration adds the workflow table and JSON columns; migration check exits 0.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
bun test test/graph-workflow-state.test.ts test/database-migration.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/graph.ts packages/core/src/graph packages/core/schema.json packages/core/src/database
git commit -m "feat(core): persist graph workflow state"
```

### Task 2: Implement Workflow State, Projection, And Rollups

**Files:**
- Create: `packages/core/src/graph/workflow/state.ts`
- Create: `packages/core/src/graph/workflow/projection.ts`
- Modify: `packages/core/src/graph/workflow/plan.ts`
- Modify: Core Graph layer dependency wiring
- Test: `packages/core/test/graph-workflow-state.test.ts`
- Test: `packages/core/test/graph-workflow-projection.test.ts`

- [ ] **Step 1: Write failing state-transition tests**

Cover mode persistence, plan reset, revision conflicts, idempotent approval, pause, and runtime reconstruction. Use real SQLite test layers rather than global mocks.

```ts
const selected = yield* workflow.mode.set({ sessionID, mode: "module", expectedRevision: 0 })
expect(selected.mode).toBe("module")

const planned = yield* workflow.plan.reset({ projectID, sessionID, graph })
expect(planned.currentNodeID).toBe("atomic-a")
expect(planned.checkpointStatus).toBe("approved")

const paused = yield* workflow.pause({ sessionID, expectedRevision: planned.revision })
expect(paused.checkpointKind).toBe("pause")
expect(paused.checkpointStatus).toBe("pending")
```

- [ ] **Step 2: Write failing projection tests**

Construct a PRD with two composites and blocked atomics. Assert deterministic order, one module per atomic, current task, progress math, mixed parent rollup, and ambiguous module rejection.

- [ ] **Step 3: Run tests and confirm RED**

```bash
bun test test/graph-workflow-state.test.ts test/graph-workflow-projection.test.ts
```

Expected: FAIL because the services are missing.

- [ ] **Step 4: Implement the state service**

Expose one Effect service:

```ts
export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<State | undefined>
  readonly setMode: (input: { sessionID: string; projectID: ProjectV2.ID; mode: ExecutionMode; expectedRevision: number }) => Effect.Effect<State, RevisionConflict | ActiveWorkflowError>
  readonly resetPlan: (input: { sessionID: string; projectID: ProjectV2.ID; graph: GraphView }) => Effect.Effect<State, ModuleScopeError>
  readonly approve: (input: { sessionID: string; expectedRevision: number }) => Effect.Effect<State, RevisionConflict>
  readonly pause: (input: { sessionID: string; expectedRevision: number; reason?: string }) => Effect.Effect<State, RevisionConflict>
  readonly advanceVerified: (input: { sessionID: string; nodeID: NodeID; graph: GraphView }) => Effect.Effect<State>
}
```

Keep revision checks and writes in transactions. Bind database/audit services to names before invoking methods.

- [ ] **Step 5: Implement the projection**

Export pure `projectWorkflow(graph, state, evidence)` plus an Effect-backed `GraphWorkflow.Service.get(...)`. Atomic tasks only appear in the task list. Parent rollups are derived and do not mutate raw node rows.

- [ ] **Step 6: Reset workflow state from plan admission**

After a successful non-dry-run admission, call `resetPlan` in the same admission transaction boundary. Preserve the selected mode; invalidate prior scope and revision.

- [ ] **Step 7: Run tests and typecheck**

```bash
bun test test/graph-workflow-state.test.ts test/graph-workflow-projection.test.ts test/graph-layer-node.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/graph/workflow packages/core/test/graph-workflow-*.test.ts packages/core/test/graph-layer-node.test.ts
git commit -m "feat(core): project graph workflow progress"
```

### Task 3: Enforce Current Task, Checkpoints, And Verified Dependencies

**Files:**
- Modify: `packages/core/src/graph/workflow/gate.ts`
- Modify: `packages/core/src/graph/workflow/build.ts`
- Modify: `packages/core/src/graph/build-order.ts`
- Modify: `packages/core/src/tool/graph.ts`
- Test: `packages/core/test/graph-gate.test.ts`
- Test: `packages/core/test/graph-build.test.ts`
- Test: `packages/core/test/location-layer.test.ts`

- [ ] **Step 1: Replace the implemented-dependency expectation with RED tests**

Change the existing test so `implemented` blocks and only `verified` permits the target. Add issues for missing mode, pending checkpoint, wrong current task, non-atomic target, and ambiguous module scope.

```ts
expect(evaluateBuildGate({ ...input, workflow: pendingCheckpoint }).issues).toContainEqual(
  expect.objectContaining({ code: "checkpoint_pending", severity: "block" }),
)
```

- [ ] **Step 2: Add a hard-gate integration test**

In `location-layer.test.ts`, prove blocked artifact apply requests no write permission and leaves the worktree unchanged when the checkpoint is pending.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
bun test test/graph-gate.test.ts test/graph-build.test.ts test/location-layer.test.ts
```

Expected: existing implemented dependency test fails and new workflow issues are absent.

- [ ] **Step 4: Extend the pure gate input**

Add a required normalized workflow authority object to `BuildGateInput`. Return stable issue codes from the design. `targetIssues` rejects non-atomic nodes and mismatched current task. `dependencyIssues` accepts only `verified`.

- [ ] **Step 5: Load workflow state in `GraphBuild.evaluate`**

Bind `GraphWorkflow.Service`, fetch state/projection, and pass authority into `evaluateBuildGate`. Add the workflow node to `GraphBuild.node` dependencies so current and legacy tool adapters share enforcement.

- [ ] **Step 6: Advance only after complete successful diagnostics**

In the shared Core graph tool, call `advanceVerified` only after every detected and focused diagnostic passes. Failed or filtered diagnostics leave current task and scope unchanged.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
bun test test/graph-gate.test.ts test/graph-build.test.ts test/location-layer.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/graph packages/core/src/tool/graph.ts packages/core/test
git commit -m "feat(core): enforce graph workflow checkpoints"
```

### Task 4: Require Task-Specific Verification Evidence

**Files:**
- Modify: `packages/core/src/graph/workflow/artifact.ts`
- Modify: `packages/core/src/graph/workflow/audit.ts`
- Modify: `packages/core/src/tool/graph.ts`
- Modify: `packages/opencode/src/tool/graph/diagnostics-run.ts`
- Modify: plan-admission adapters in Core and OpenCode
- Test: `packages/core/test/location-layer.test.ts`
- Test: `packages/opencode/test/tool/graph-diagnostics-run.test.ts`

- [ ] **Step 1: Write RED tests for unrelated diagnostics**

Admit an atomic node with `testPaths: ["src/theme.test.ts"]`, leave that path missing, and assert diagnostics cannot verify the node even when the existing project test command exits 0.

Add a passing case where the focused file exists and both focused/full checks pass. Assert bounded structured evidence is persisted.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
bun test test/location-layer.test.ts
```

Run from `packages/opencode`:

```bash
bun test test/tool/graph-diagnostics-run.test.ts
```

Expected: the current implementation incorrectly verifies from project-generic diagnostics.

- [ ] **Step 3: Carry verification specs through plan admission**

Extend both plan-admission schemas to accept the shared `VerificationSpec`, sanitize it, and persist it only on atomic nodes. Reject executable atomic nodes without criteria/diagnostics in new plans.

- [ ] **Step 4: Resolve focused checks safely**

For each diagnostic path:

- Resolve relative to the project root.
- Reject symlink/path escapes.
- Require existence.
- Build Bun argv arrays without shell interpolation.
- Run focused tests before complete package scripts.

- [ ] **Step 5: Persist bounded evidence**

Record criteria, artifact paths, command name/argv, exit code, timeout, pass state, and a size-limited excerpt in `GraphToolRunTable.evidence`. Keep full output only in Session tool results.

- [ ] **Step 6: Run focused tests and typechecks**

```bash
bun test test/location-layer.test.ts
bun typecheck
```

```bash
bun test test/tool/graph-diagnostics-run.test.ts test/tool/graph-tools.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test packages/opencode/src/tool/graph packages/opencode/test/tool
git commit -m "feat(core): verify graph tasks with focused evidence"
```

### Task 5: Expose Workflow State Through Graph HTTP And SDK

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`
- Test: `packages/opencode/test/server/graph-api.test.ts`
- Generated: `packages/sdk/js/src/v2/gen/*`

- [ ] **Step 1: Write failing API tests**

Cover empty/default projection, mode selection, current task, pause, exact-revision approval, stale conflict, runtime reconstruction, evidence audit, and forbidden direct `implemented`/`verified` mutation.

```ts
const mode = await client.graph.workflowMode({
  session,
  mode: "module",
  expectedRevision: 0,
})
expect(mode.data?.mode).toBe("module")

const stale = await client.graph.workflowApprove({ session, expectedRevision: 0 })
expect(stale.error?.code).toBe("workflow_revision_conflict")
```

- [ ] **Step 2: Run API tests and confirm RED**

```bash
bun test test/server/graph-api.test.ts
```

Expected: workflow methods are missing.

- [ ] **Step 3: Add API schemas and typed conflict**

Add workflow response schemas matching the shared projection, `ModePayload`, `RevisionPayload`, and a message-bearing `GraphWorkflowConflict` error. Add GET/PATCH/POST endpoints from the design.

- [ ] **Step 4: Implement handlers**

Bind Graph workflow/storage/audit services once while building the handler group. Derive project/session context from middleware; never trust project IDs in payloads.

- [ ] **Step 5: Narrow status mutation and promotion**

Reject direct `implemented`/`verified` updates. Promotion checks workflow completion and no pending checkpoint.

- [ ] **Step 6: Regenerate the legacy SDK**

Run from repository root:

```bash
./packages/sdk/js/script/build.ts
```

Do not edit generated files manually.

- [ ] **Step 7: Run API tests and typecheck**

```bash
bun test test/server/graph-api.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi packages/opencode/test/server/graph-api.test.ts packages/sdk/js/src/v2/gen
git commit -m "feat(opencode): expose graph workflow controls"
```

### Task 6: Make Conversation Activity User-Facing

**Files:**
- Modify: `packages/core/src/graph/workflow/prompt.ts`
- Modify: `packages/opencode/test/session/graph-instruction.test.ts`
- Modify: `packages/session-ui/src/components/message-part.tsx`
- Test: `packages/session-ui/src/components/message-part.test.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx`
- Test: `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`

- [ ] **Step 1: Write failing prompt assertions**

Keep internal tool IDs in the system instruction, but add assertions for:

```ts
expect(system).toContain("present the complete task list before implementation")
expect(system).toContain("never show registered graph tool identifiers to the user")
expect(system).toContain("Atomic mode")
expect(system).toContain("Module mode")
expect(system).toContain("Autopilot mode")
expect(system).not.toContain("Move to the next pending node")
```

- [ ] **Step 2: Write failing Web/TUI rendering tests**

Render each Graph tool and assert user-facing titles such as “Preparing work plan,” “Applying task changes,” and “Verifying task.” Assert normal rendered output contains no `graph_` identifier.

- [ ] **Step 3: Run tests and confirm RED**

```bash
bun test test/session/graph-instruction.test.ts
```

```bash
bun test src/components/message-part.test.tsx
```

```bash
bun test test/cli/tui/inline-tool-wrap-snapshot.test.tsx
```

- [ ] **Step 4: Rewrite the canonical collaboration prompt**

Replace continuous Autopilot wording with the plan/current-task/checkpoint contract. Require focused clarification for broad goals, a complete task list before mutation, meaningful boundary updates, and truthful final counts.

- [ ] **Step 5: Add shared presentation mapping**

Keep registered IDs unchanged. Map Graph tools to stable user activities in Web and TUI; staged artifact begin/chunk/seal collapse visually into “Preparing task changes.”

- [ ] **Step 6: Run tests and typechecks**

Run package-local focused tests followed by `bun typecheck` in `packages/opencode`, `packages/session-ui`, and `packages/tui`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/graph/workflow/prompt.ts packages/opencode/test/session packages/session-ui packages/tui
git commit -m "feat: make graph activity collaborative"
```

### Task 7: Build Pure Cockpit Models And A Reactive Canvas

**Files:**
- Modify: `packages/app/src/pages/graph-helpers.ts`
- Modify: `packages/app/src/pages/graph-helpers.test.ts`
- Create: `packages/app/src/pages/graph-canvas.tsx`
- Create: `packages/app/src/pages/graph-canvas.test.tsx`

- [ ] **Step 1: Write failing helper tests**

Cover real `node.level` filtering, module grouping, stable task order, progress, parent rollups, current-vs-selected fallback, removed-selection reconciliation, and status labels.

- [ ] **Step 2: Write failing canvas lifecycle tests**

Use the existing Happy DOM Canvas stub. Rerender with changed nodes and assert simulation data changes. Assert deterministic initial positions, reduced-motion settling, local wheel coordinates, single-click selection, and double-click centering.

- [ ] **Step 3: Run tests and confirm RED**

```bash
bun test src/pages/graph-helpers.test.ts src/pages/graph-canvas.test.tsx
```

- [ ] **Step 4: Implement normalized view models**

Use generated workflow response types only after normalizing nullable fields. Replace multiple broad string enums with narrow local unions. Use functional array methods and type guards.

- [ ] **Step 5: Extract the canvas boundary**

Move simulation/render/input logic out of `graph.tsx`. Accept data, selected/current IDs, semantic CSS colors, reduced-motion state, and selection/center callbacks. Reconcile retained node data on every graph update and stop animation after settling.

- [ ] **Step 6: Run tests and App typecheck**

```bash
bun test src/pages/graph-helpers.test.ts src/pages/graph-canvas.test.tsx
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/pages/graph-helpers* packages/app/src/pages/graph-canvas*
git commit -m "refactor(app): stabilize graph workflow canvas"
```

### Task 8: Implement The Liquid-Glass Workflow Cockpit

**Files:**
- Create: `packages/app/src/pages/graph-cockpit.tsx`
- Modify: `packages/app/src/pages/graph.tsx`
- Create: `packages/app/src/pages/graph-cockpit.test.tsx`
- Create: `packages/app/e2e/regression/graph-workflow-cockpit.spec.ts`
- Modify: `packages/app/e2e/utils/mock-server.ts`

- [ ] **Step 1: Write failing component tests**

Assert desktop Task/Graph/Details panes, durable current-task fallback, task-to-canvas selection, inspector evidence, mode control, Continue/Pause actions, loading/empty/error/complete states, and live-region text.

- [ ] **Step 2: Write failing responsive E2E coverage**

At desktop width assert three panes and no horizontal overflow. At 390px assert accessible Tasks/Graph/Details tabs and 44px action targets. Add light/dark and reduced-motion checks.

- [ ] **Step 3: Run tests and confirm RED**

```bash
bun test src/pages/graph-cockpit.test.tsx
bun run test:e2e -- graph-workflow-cockpit.spec.ts
```

- [ ] **Step 4: Implement query and mutation orchestration**

Use one `createStore` for page selection/source/filter/mobile-tab state. Query CurrentPlan/Main and workflow projection. Mutations carry exact revisions and refresh on conflict.

- [ ] **Step 5: Implement desktop and mobile layouts**

Use existing Tabs, SegmentedControl, Button, IconButton, Progress, Badge, and ScrollView primitives. Desktop columns are 288px / flexible / 344px. Mobile renders one tab panel at a time.

- [ ] **Step 6: Apply restrained liquid-glass styling**

Use local semantic CSS variables and `color-mix` with opaque fallbacks. Use cold gray-blue surfaces, muted cyan-teal current state, restrained green verified state, amber checkpoint, semantic red failure, and neutral pending. Keep primary actions solid. Add reduced-motion and reduced-transparency fallbacks.

- [ ] **Step 7: Implement node/task interaction**

Single click selects, double click centers, task click synchronizes/centers, blank canvas returns inspector to durable current task, and action controls stay in the inspector footer.

- [ ] **Step 8: Run tests, E2E, typecheck, and production build**

```bash
bun test src/pages/graph-helpers.test.ts src/pages/graph-canvas.test.tsx src/pages/graph-cockpit.test.tsx
bun run test:e2e -- graph-workflow-cockpit.spec.ts
bun typecheck
bun run build
```

Expected: PASS; only documented existing chunk-size warnings are acceptable.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/pages/graph* packages/app/e2e
git commit -m "feat(app): add graph workflow cockpit"
```

### Task 9: Add TUI Mode, Task, Pause, And Continue Controls

**Files:**
- Modify: `packages/tui/src/graph/workflow.ts`
- Modify: `packages/tui/src/component/dialog-graph-status.tsx`
- Modify: `packages/tui/src/component/dialog-graph-guide.tsx`
- Modify: `packages/tui/src/app.tsx`
- Test: `packages/tui/test/graph-workflow.test.ts`
- Test: `packages/tui/test/app-graph-workflow.test.tsx`

- [ ] **Step 1: Write failing pure helper tests**

Assert ordered task lines, mode/phase/current task, checkpoint call-to-action, and no raw Graph IDs.

- [ ] **Step 2: Write failing OpenTUI integration tests**

Assert `/graph-start` presents mode selection with Module default, `/graph-status` shows task names/current task, `/graph-continue` approves the fetched revision, and stale conflicts refresh rather than falsely reporting success.

- [ ] **Step 3: Run tests and confirm RED**

```bash
bun test test/graph-workflow.test.ts test/app-graph-workflow.test.tsx
```

- [ ] **Step 4: Implement TUI workflow projection and commands**

Fetch the new workflow endpoint. Add `graph.mode`, `graph.continue`, and `graph.pause` command actions while preserving `/graph-open` and `/graph` behavior. Bind SDK service values before calls.

- [ ] **Step 5: Implement status dialog**

Show execution mode, phase, progress, current task, grouped task names, verification/checkpoint summaries, and context-sensitive Continue/Pause controls.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
bun test test/graph-workflow.test.ts test/app-graph-workflow.test.tsx test/app-lifecycle.test.tsx
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src packages/tui/test
git commit -m "feat(tui): add graph collaboration controls"
```

### Task 10: Documentation, Dogfood, Reviews, And Final Verification

**Files:**
- Modify: `docs/graph-mode.md`
- Modify: `docs/superpowers/reports/2026-07-10-graph-collaboration-ux.md`
- Dogfood only: `examples/game-2048/` remains ignored

- [ ] **Step 1: Update user documentation**

Document execution modes, `/graph-start`, `/graph-status`, `/graph-continue`, `/graph-pause`, Web workflow controls, checkpoint semantics, verification evidence, and password guidance for remote Web access.

- [ ] **Step 2: Run the complete focused matrix**

Run package-local tests and typechecks for Schema/Core, OpenCode, Session UI, App, TUI, and Server. Run Core migration check and legacy SDK generation check.

- [ ] **Step 3: Run builds**

```bash
# packages/app
bun run build

# packages/opencode
bun run script/build.ts --single --skip-install
```

- [ ] **Step 4: Run fresh live smokes**

Verify:

- Graph Vibe and OpenCode CLI identities
- Source Web backend/Vite readiness and direct Graph route
- Embedded Web direct Graph route and embedded assets
- Shutdown releases every child port
- TUI task list/current task/mode/checkpoint rendering

- [ ] **Step 5: Run a clean `game-2048` dogfood session**

Use Module mode. Confirm the plan card appears before changes, the first current task is visible, the workflow stops after one module, Continue advances the exact revision, new behavior has focused tests, and final parent/task counts match persisted state.

- [ ] **Step 6: Request specification and code-quality reviews**

Dispatch one read-only specification reviewer and one read-only code-quality reviewer within the harness budget. Fix all Critical/Important findings and rerun affected tests.

- [ ] **Step 7: Finalize report and ledger audit**

Record commits, tests, builds, smokes, dogfood evidence, risks, and reviewer outcomes. Run:

```bash
"/home/kailiangs/.config/opencode/skills/cached-subagent-harness/scripts/bin/harnessctl" ledger-audit \
  --db "/home/kailiangs/open-source-project/graph-vibe-opencode/.git/graph-collaboration-ledger.sqlite" \
  --mode final
```

- [ ] **Step 8: Commit**

```bash
git add docs/graph-mode.md docs/superpowers/reports/2026-07-10-graph-collaboration-ux.md
git commit -m "docs: finalize graph collaboration experience"
```
