# Graph Main Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users explicitly publish a completed Current Plan to Main while preserving a read-only, version-backed Plan in the originating session.

**Architecture:** Core owns a shared session Plan resolver that prefers live Current Plan rows and falls back to the latest graph version for the same project and session. Server exposes that read model through `/graph/plan-view`; App uses it for Plan rendering, adds guarded publication confirmation, and renders an explicit empty Main state. Strict `/graph/current-plan` and the existing promotion transaction remain unchanged.

**Tech Stack:** Effect v4, Drizzle SQLite, Effect HttpApi, generated TypeScript SDK, SolidJS, TanStack Solid Query, Bun test, Playwright.

---

### Task 1: Add The Version-Backed Plan Read Model

**Files:**
- Modify: `packages/core/src/graph/storage.ts`
- Modify: `packages/core/src/graph/domain.ts`
- Modify: `packages/core/src/graph/workflow/projection.ts`
- Test: `packages/core/test/graph.test.ts`
- Test: `packages/core/test/graph-domain.test.ts`
- Test: `packages/core/test/graph-workflow-projection.test.ts`

- [ ] **Step 1: Write failing storage tests**

Add tests that create two sessions and versions, then assert the exact read-model contract:

```ts
const before = yield* storage.planView({ projectID: PID, sessionID: SID })
expect(before).toMatchObject({ source: "currentPlan", versionNumber: null, publishedAt: null })
expect(before.nodes.map((node) => node.id)).toEqual([atomicA.id])

const promoted = yield* storage.promote({ projectID: PID, sessionID: SID, message: "published" })
const after = yield* storage.planView({ projectID: PID, sessionID: SID })
expect(after).toMatchObject({ source: "version", versionNumber: promoted.versionNumber })
expect(after.nodes.map((node) => node.id)).toEqual([atomicA.id])
expect((yield* storage.currentPlan({ sessionID: SID })).nodes).toHaveLength(0)
```

Insert persisted snake-case and canonical snapshot fixtures directly into `GraphVersionTable`. Assert both decode to the same canonical `NodeRow`/`EdgeRow`, a newer version from another session is ignored, and malformed snapshots fail with `GraphV2.SnapshotDecodeError`.

- [ ] **Step 2: Run the storage tests and verify RED**

Run from `packages/core`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=1536M -p MemorySwapMax=256M bun test test/graph.test.ts
```

Expected: FAIL because `planView`, `latestForSession`, and snapshot decoding do not exist.

- [ ] **Step 3: Implement snapshot decoding and latest session lookup**

In `storage.ts`, add these exported contracts:

```ts
export class SnapshotDecodeError extends Schema.TaggedErrorClass<SnapshotDecodeError>()(
  "GraphV2.SnapshotDecodeError",
  { message: Schema.String },
) {}

export interface SessionPlanView extends GraphView {
  readonly source: "currentPlan" | "version"
  readonly versionNumber: number | null
  readonly publishedAt: number | null
}

export interface SessionVersion extends Omit<VersionRow, "snapshot"> {
  readonly snapshot: GraphView
}
```

Define Effect schemas for complete canonical node/edge rows and persisted snake-case node/edge rows. Decode a snapshot union into canonical `GraphView`; map schema failures to `SnapshotDecodeError`. Do not cast unknown snapshots and do not return an empty graph on decode failure.

Add the service operations:

```ts
readonly planView: (input: {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
}) => Effect.Effect<SessionPlanView, SnapshotDecodeError>

readonly version: {
  readonly list: (input: {
    readonly projectID: ProjectV2.ID
  }) => Effect.Effect<ReadonlyArray<VersionRow>>
  readonly get: (input: {
    readonly projectID: ProjectV2.ID
    readonly versionNumber: number
  }) => Effect.Effect<VersionRow, NotFoundError>
  readonly latestForSession: (input: {
    readonly projectID: ProjectV2.ID
    readonly sessionID: string
  }) => Effect.Effect<SessionVersion | undefined, SnapshotDecodeError>
}
```

Query the latest matching version with both IDs and descending `version_number`. `planView` returns live Current Plan whenever it contains nodes; otherwise it returns the decoded matching version or an empty `currentPlan` view.

Keep existing `version.list` and `version.get` metadata/snapshot behavior unchanged so an unrelated malformed historical version cannot break version listing. Decode only at the session Plan read boundary.

- [ ] **Step 4: Expose the resolver through GraphDomain**

Add `planView` to `GraphDomain.Interface` and delegate directly to `storage.planView`. Keep `currentPlan` unchanged.

- [ ] **Step 5: Make workflow projection use the shared resolver**

Replace the direct `storage.currentPlan` read in `GraphWorkflowProjection.Service.get` with:

```ts
const graph = yield* storage.planView(input)
```

Continue passing `graph`, state, and session-scoped audit evidence into `projectWorkflow`. Add a service-level projection test that verifies tasks, modules, progress, and latest evidence before and after promotion.

- [ ] **Step 6: Run focused Core tests and verify GREEN**

Run from `packages/core`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=2048M -p MemorySwapMax=256M bun test test/graph.test.ts test/graph-domain.test.ts test/graph-workflow-projection.test.ts
bun typecheck
```

Expected: all focused tests and Core typecheck pass.

- [ ] **Step 7: Commit Core read-model work**

```bash
git add packages/core/src/graph/storage.ts packages/core/src/graph/domain.ts packages/core/src/graph/workflow/projection.ts packages/core/test/graph.test.ts packages/core/test/graph-domain.test.ts packages/core/test/graph-workflow-projection.test.ts
git commit -m "feat(core): preserve published graph plans"
```

### Task 2: Expose Session Plan View Through HttpApi

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts`
- Modify: `packages/opencode/test/server/graph-api.test.ts`
- Regenerate: `packages/client/src/generated/**`
- Regenerate: `packages/client/src/generated-effect/**`
- Regenerate: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Regenerate: `packages/sdk/js/src/v2/gen/types.gen.ts`
- Test: `packages/sdk/js/test/graph-nullability.test.ts`

- [ ] **Step 1: Write the failing server contract test**

Extend the completed workflow promotion scenario to call `/graph/plan-view` before and after promotion:

```ts
const before = yield* sendJson<SessionPlanView>(
  "GET",
  `/graph/plan-view?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
)
expect(before.json).toMatchObject({ source: "currentPlan", versionNumber: null, publishedAt: null })

const after = yield* sendJson<SessionPlanView>(
  "GET",
  `/graph/plan-view?directory=${encodeURIComponent(test.directory)}&session=${session.id}`,
)
expect(after.json).toMatchObject({ source: "version", versionNumber: 1 })
expect(after.json.nodes).toHaveLength(1)
```

Also assert strict Current Plan is empty, Main contains the node, and a repeated promotion returns 400 without creating version 2.

- [ ] **Step 2: Run the server test and verify RED**

Run from `packages/opencode`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=2048M -p MemorySwapMax=256M bun test test/server/graph-api.test.ts
```

Expected: FAIL with 404 for `/graph/plan-view`.

- [ ] **Step 3: Add the HttpApi contract and handler**

In the Graph HttpApi group, add:

```ts
const SessionPlanViewResponse = Schema.Struct({
  source: Schema.Literals(["currentPlan", "version"]),
  versionNumber: Schema.NullOr(Schema.Number),
  publishedAt: Schema.NullOr(Schema.Number),
  nodes: Schema.Array(GraphNodeResponse),
  edges: Schema.Array(GraphEdgeResponse),
}).annotate({ identifier: "SessionPlanView" })
```

Add `GraphPaths.planView = "/graph/plan-view"` and endpoint identifier `graph.planView` with `SessionRequiredQuery`. In the handler, resolve the session and call:

```ts
const view = yield* domain.planView({ projectID: session.projectID, sessionID: session.id })
return {
  source: view.source,
  versionNumber: view.versionNumber,
  publishedAt: view.publishedAt,
  nodes: view.nodes,
  edges: view.edges,
}
```

Translate snapshot decode failures to the endpoint's declared internal-server error instead of returning malformed data.

- [ ] **Step 4: Regenerate both client surfaces**

Run from `packages/client`:

```bash
bun run generate
```

Run from the repository root:

```bash
./packages/sdk/js/script/build.ts
```

Do not edit generated files manually. Confirm the App-facing client exposes `sdk().client.graph.planView(...)` and nullable publication metadata remains nullable.

- [ ] **Step 5: Run server and SDK verification**

```bash
systemd-run --user --scope --quiet -p MemoryMax=3072M -p MemorySwapMax=256M bun test test/server/graph-api.test.ts
```

Run from `packages/sdk/js`:

```bash
bun test test/graph-nullability.test.ts
bun typecheck
```

Run `bun typecheck` from `packages/client` and `packages/opencode`. Expected: tests and typechecks pass.

- [ ] **Step 6: Commit the API and generated clients**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/graph.ts packages/opencode/src/server/routes/instance/httpapi/handlers/graph.ts packages/opencode/test/server/graph-api.test.ts packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/v2/gen packages/sdk/js/test/graph-nullability.test.ts
git commit -m "feat(graph): expose published plan views"
```

### Task 3: Add User-Confirmed Publication In The App

**Files:**
- Modify: `packages/app/src/pages/graph.tsx`
- Modify: `packages/app/src/pages/graph-cockpit.tsx`
- Modify: `packages/app/src/pages/graph-helpers.ts`
- Test: `packages/app/src/pages/graph-helpers.test.ts`
- Test: `packages/app/src/pages/graph-cockpit.test.ts`
- Test: `packages/app/test-browser/graph-workflow-cockpit.test.ts`
- Test: `packages/app/e2e/regression/graph-workflow-cockpit.spec.ts`

- [ ] **Step 1: Write failing helper and component tests**

Add a pure eligibility helper and tests:

```ts
expect(canPublishToMain({ phase: "complete", planSource: "currentPlan", nodeCount: 2 })).toBe(true)
expect(canPublishToMain({ phase: "building", planSource: "currentPlan", nodeCount: 2 })).toBe(false)
expect(canPublishToMain({ phase: "complete", planSource: "version", nodeCount: 2 })).toBe(false)
expect(canPublishToMain({ phase: "complete", planSource: "currentPlan", nodeCount: 0 })).toBe(false)
```

Add cockpit assertions that completed live Plans expose `Publish to Main`, version-backed Plans show their version and never expose publication, and Main never exposes mutation controls.

- [ ] **Step 2: Write failing focused E2E scenarios**

Extend the existing Graph cockpit fixture with mutable Plan/Main/publication state. Cover:

```ts
await page.getByRole("button", { name: "Main" }).click()
await expect(page.getByRole("status")).toContainText("No published topology")
await page.getByRole("button", { name: "Return to Plan" }).click()
await page.getByRole("button", { name: "Publish to Main" }).click()
await expect(page.getByRole("dialog")).toContainText("4 nodes")
await expect(page.getByRole("dialog")).toContainText("4 edges")
```

Assert Cancel sends no POST. On confirmation, assert one POST, Main becomes populated, Plan remains available as version-backed read-only content, and reload preserves both views.

- [ ] **Step 3: Run focused App tests and verify RED**

Run from `packages/app`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=2048M -p MemorySwapMax=256M bun test --preload ./happydom.ts src/pages/graph-helpers.test.ts src/pages/graph-cockpit.test.ts
systemd-run --user --scope --quiet -p MemoryMax=2048M -p MemorySwapMax=256M bun test --conditions=browser --preload ./happydom.ts test-browser/graph-workflow-cockpit.test.ts
```

Expected: FAIL because publication controls and empty Main state do not exist.

- [ ] **Step 4: Implement Plan-view loading and empty Main handling**

Change the Plan query from `graph.currentPlan` to `graph.planView`. Keep UI source (`currentPlan | main`) separate from Plan data source (`currentPlan | version`). Compute Main empty state from the selected graph's actual node count, move the Plan/Main switch outside the cockpit-ready branch, and do not mount `GraphCockpit` for empty Main.

Render `No published topology` with `Return to Plan`. Keep empty Current Plan behavior unchanged for genuinely planless sessions.

- [ ] **Step 5: Implement guarded confirmation and publication mutation**

Use the standard `useDialog()` and `Dialog` components in `graph.tsx`. The dialog shows exact node and edge counts, Cancel, and Confirm. Add a `createMutation` that calls:

```ts
sdk().client.graph.promote({
  session: params.id!,
  directory: directory(),
  graphPromotePayload: { message: `Published from ${sync().session.get(params.id!)?.title ?? params.id}` },
})
```

While pending, disable duplicate submission. On success, close the dialog, invalidate Graph queries, clear selection, switch to Main, and announce the returned version. On failure, keep Plan selected, refresh authoritative queries, and show a retryable publication error.

Pass `planSource`, `versionNumber`, `onPublish`, and pending state into `GraphCockpit`. Use a version-specific canvas identity for published Plan snapshots.

- [ ] **Step 6: Run focused App tests and E2E GREEN**

Run focused unit/browser commands from Step 3, then:

```bash
systemd-run --user --scope --quiet -p MemoryMax=4096M -p MemorySwapMax=256M bunx playwright test e2e/regression/graph-workflow-cockpit.spec.ts --project chromium --workers=1 --reporter=line
bun typecheck
bun run typecheck:e2e
```

Expected: all focused App tests, E2E, and typechecks pass.

- [ ] **Step 7: Commit App publication UX**

```bash
git add packages/app/src/pages/graph.tsx packages/app/src/pages/graph-cockpit.tsx packages/app/src/pages/graph-helpers.ts packages/app/src/pages/graph-helpers.test.ts packages/app/src/pages/graph-cockpit.test.ts packages/app/test-browser/graph-workflow-cockpit.test.ts packages/app/e2e/regression/graph-workflow-cockpit.spec.ts
git commit -m "feat(app): publish completed graph plans"
```

### Task 4: Verify The Completed Branch

**Files:**
- Verify only.

- [ ] **Step 1: Run affected package tests**

Run from `packages/core`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=3072M -p MemorySwapMax=256M bun test test/graph.test.ts test/graph-domain.test.ts test/graph-workflow-projection.test.ts
```

Run from `packages/opencode`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=4096M -p MemorySwapMax=256M bun test test/server/graph-api.test.ts test/tool/graph-tools.test.ts test/tool/graph-diagnostics-run.test.ts test/tool/graph-artifact-apply.test.ts
```

Run from `packages/app`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=3072M -p MemorySwapMax=256M bun run test
systemd-run --user --scope --quiet -p MemoryMax=4096M -p MemorySwapMax=256M bunx playwright test e2e/regression/product-migration.spec.ts e2e/regression/graph-vibe-product-shell.spec.ts e2e/regression/graph-workflow-cockpit.spec.ts --project chromium --workers=1 --reporter=line
```

Run from `packages/sdk/js`:

```bash
bun test test/graph-nullability.test.ts
```

- [ ] **Step 2: Run package typechecks and lint**

Run `bun typecheck` separately from `packages/core`, `packages/opencode`, `packages/app`, `packages/client`, `packages/sdk/js`, and `packages/sdk-next`. Run `bun run typecheck:e2e` from `packages/app`. Run `bun run lint` from the repository root under a 4 GB systemd scope.

- [ ] **Step 3: Review branch diff and worktree**

Run:

```bash
git diff --check
git status --short
git diff dev...HEAD --stat
```

Expected: no uncommitted files, no whitespace errors, and only intended publication-flow changes in addition to the already accepted branch commits.

### Task 5: Merge To Dev And Launch User Acceptance

**Files:**
- No source changes expected.

- [ ] **Step 1: Stop review services before removing their worktree**

Stop `graph-review-backend-4785.service` and `graph-review-ui-4786.service`. Confirm both are inactive and ports 4785/4786 are free.

- [ ] **Step 2: Merge locally into dev**

From the primary repository worktree, verify `dev` is checked out and clean enough to merge without touching unrelated user changes. Merge `graph-workflow-review` non-interactively, without rebasing or force operations.

- [ ] **Step 3: Verify the merged result**

Against merged `dev`, rerun these exact checks before deleting the branch or worktree:

```bash
# packages/core
bun test test/graph.test.ts test/graph-domain.test.ts test/graph-workflow-projection.test.ts

# packages/opencode
bun test test/server/graph-api.test.ts

# packages/app
bun test --conditions=browser --preload ./happydom.ts test-browser/graph-workflow-cockpit.test.ts
bunx playwright test e2e/regression/graph-workflow-cockpit.spec.ts --project chromium --workers=1 --reporter=line
```

Run each affected package's `bun typecheck` and repository lint under the same memory bounds used on the feature branch.

- [ ] **Step 4: Remove the merged branch worktree**

After verification, remove `.worktrees/graph-workflow-review` and delete local branch `graph-workflow-review`. Do not modify or delete `graph-workflow-wip`.

- [ ] **Step 5: Launch dev acceptance services**

Start backend and Vite from `dev` as bounded systemd user services on stable loopback ports, using the existing isolated Graph Vibe data root and authentication. Use `MemoryMax=8192M`, `MemorySwapMax=256M`, and `TURBO_CONCURRENCY=1` for backend; use `MemoryMax=1536M` and `MemorySwapMax=256M` for UI.

Confirm unauthenticated backend health is 401, authenticated health is 200, UI is 200, and both units remain active. Return a direct authenticated URL for the existing completed session if it resolves from the merged root; otherwise create a deterministic completed acceptance workflow under the dev root and return its direct URL.
