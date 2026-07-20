# Graph Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the valid Graph Main/Plan presentation, canvas lifecycle, and TUI interaction work from `graph-workflow-wip` on top of the latest accepted Graph Vibe frontend.

**Architecture:** `GraphPage` remains the source owner and passes `currentPlan` or `main` to one shared `GraphCockpit`. The cockpit derives a read-only model for Main while preserving the durable workflow model for Plan; `GraphCanvas` independently reconciles topology and redraw-only state. The old WIP commit is used as a behavioral reference, not merged wholesale.

**Tech Stack:** TypeScript, SolidJS, Bun test, Happy DOM, Playwright, OpenTUI, systemd user services

---

## File Map

- `packages/app/src/pages/graph.tsx`: pass the selected Graph source into the cockpit without changing route ownership.
- `packages/app/src/pages/graph-cockpit.tsx`: derive source-specific rail, inspector, controls, labels, and announcements.
- `packages/app/src/pages/graph-canvas.tsx`: separate topology simulation restarts from redraws and observe container resizes.
- `packages/app/test-browser/graph-workflow-cockpit.test.ts`: component regressions for Main, progress semantics, resize, and redraw behavior.
- `packages/app/e2e/regression/graph-workflow-cockpit.spec.ts`: preserve current product-shell coverage while adding Main and mobile canvas acceptance.
- `packages/tui/test/app-graph-workflow.test.tsx`: replace timing sleeps with condition-based workflow refresh assertions.
- `packages/tui/test/dialog-graph-status.test.tsx`: verify pending actions ignore duplicate keys and use condition-based readiness.
- `docs/superpowers/specs/2026-07-20-graph-workflow-integration-design.md`: approved integration contract.
- `packages/sdk/js/test/graph-nullability-patch.test.ts`: explicitly excluded because its implementation is absent.

### Task 1: Restore Main As A Read-Only Cockpit Source

**Files:**
- Modify: `packages/app/test-browser/graph-workflow-cockpit.test.ts`
- Modify: `packages/app/src/pages/graph-cockpit.tsx`
- Modify: `packages/app/src/pages/graph.tsx`

- [ ] **Step 1: Add the failing Main source component test**

Add a test that renders `GraphCockpit` with `source: "main"`, one visible node named `Released capability`, and no Plan task for that node. Assert that the rail and inspector show the graph node while `.graph-action`, `Execution mode`, `Build rail`, and workflow progress controls are absent.

```ts
test("Main derives its rail and inspector from visible graph nodes without plan controls", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const selected: Array<string | null> = []
  const dispose = render(
    () =>
      createComponent(GraphCockpit, {
        source: "main",
        workflow,
        graph: {
          nodes: [{
            id: "main-only",
            name: "Released capability",
            type: "atomic",
            level: "L2",
            status: "verified",
            testStatus: "passed",
            priority: null,
            sessionID: null,
            desc: "Visible only in Main",
          }],
          edges: [],
        },
        selectedNodeID: "main-only",
        onSelectNode: (id) => selected.push(id),
      }),
    root,
  )
  expect(root.textContent).toContain("Released capability")
  expect(root.textContent).toContain("Visible only in Main")
  expect(root.querySelector('[aria-label="Execution mode"]')).toBeNull()
  expect(root.textContent).not.toContain("Build rail")
  root.querySelector<HTMLButtonElement>(".graph-task")!.click()
  expect(selected).toEqual(["main-only"])
  dispose()
  root.remove()
})
```

- [ ] **Step 2: Run the test under a 1 GiB memory limit and verify RED**

Run from `packages/app` through a transient user service:

```bash
systemd-run --user --wait --collect --working-directory="$(pwd)" -p MemoryMax=1G -p MemorySwapMax=256M /home/kailiangs/.bun/bin/bun test --conditions=browser --preload ./happydom.ts ./test-browser/graph-workflow-cockpit.test.ts
```

Expected: the new Main assertion fails because the cockpit still uses Plan tasks and controls.

- [ ] **Step 3: Implement source-specific cockpit modeling**

Add `source?: "currentPlan" | "main"` to `GraphCockpit`. For Main, map `props.graph.nodes` to `Task` values, group them under one `Main graph` module, clear current task and checkpoint state, suppress execution actions, and render Main-specific labels. Keep all existing Plan expressions unchanged behind `isPlan()` checks.

Pass `source={state.source}` from `GraphPage`.

- [ ] **Step 4: Verify GREEN**

Run the bounded command from Step 2.

Expected: all tests in `graph-workflow-cockpit.test.ts` pass without reaching the memory limit.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/graph.tsx packages/app/src/pages/graph-cockpit.tsx packages/app/test-browser/graph-workflow-cockpit.test.ts
git commit -m "feat(app): restore read-only main graph"
```

### Task 2: Stabilize Canvas Resize And Redraw Behavior

**Files:**
- Modify: `packages/app/test-browser/graph-workflow-cockpit.test.ts`
- Modify: `packages/app/src/pages/graph-canvas.tsx`

- [ ] **Step 1: Add failing resize and redraw tests**

Add one test with a controllable `ResizeObserver` that changes a hidden mobile canvas container to `360x240` and asserts positive canvas dimensions after the callback. Add a second test with controlled `requestAnimationFrame` and reactive selection/current values; assert style-only updates do not enqueue another topology simulation frame.

- [ ] **Step 2: Run bounded tests and verify RED**

Run the Task 1 bounded component-test command.

Expected: resize observation is absent and style-only changes restart animation.

- [ ] **Step 3: Implement topology separation**

Track a serialized topology key containing graph ID, node IDs, and edge identity/source/target/relation. Reconcile nodes on data changes, but call `start()` only when the topology key changes. Put selected/current dependencies in a separate effect that calls `draw()`. Observe the canvas container with `ResizeObserver`, falling back to the existing window resize listener when unavailable.

- [ ] **Step 4: Verify GREEN and typecheck**

```bash
systemd-run --user --wait --collect --working-directory="$(pwd)" -p MemoryMax=1G -p MemorySwapMax=256M /home/kailiangs/.bun/bin/bun test --conditions=browser --preload ./happydom.ts ./test-browser/graph-workflow-cockpit.test.ts
bun typecheck
```

Expected: focused browser tests and App typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/graph-canvas.tsx packages/app/test-browser/graph-workflow-cockpit.test.ts
git commit -m "fix(app): stabilize graph canvas redraws"
```

### Task 3: Integrate Product-Shell E2E Coverage

**Files:**
- Modify: `packages/app/e2e/regression/graph-workflow-cockpit.spec.ts`

- [ ] **Step 1: Extend the mock API with a distinct Main graph**

Keep `/graph/current-plan` returning the Plan graph and make `/graph/main` return a graph containing `Released capability` with description `Visible only in Main`.

- [ ] **Step 2: Add Main and mobile assertions**

In both source and embedded route variants, select Main and assert the released node is visible while Plan rail and execution mode are absent. Return to Plan. At `390x844`, select the Graph tab and assert the labeled canvas and backing canvas have positive dimensions.

- [ ] **Step 3: Run the focused E2E under bounded services**

Start backend and Vite as separate user services, each with `MemoryMax=1536M`, then run:

```bash
bunx playwright test e2e/regression/graph-workflow-cockpit.spec.ts --project chromium --workers=1 --reporter=line
```

Expected: both source and embedded variants pass; product identity, Main/Plan behavior, and mobile canvas assertions remain intact.

- [ ] **Step 4: Commit**

```bash
git add packages/app/e2e/regression/graph-workflow-cockpit.spec.ts
git commit -m "test(app): cover main and plan graph views"
```

### Task 4: Restore TUI Status Reliability Coverage

**Files:**
- Modify: `packages/tui/test/app-graph-workflow.test.tsx`
- Modify: `packages/tui/test/dialog-graph-status.test.tsx`

- [ ] **Step 1: Replace fixed sleeps with bounded condition polling**

Add local `waitFor` helpers with a 2-second deadline and 5 ms interval. Render before each frame check. Replace the fixed sleeps around opening and refreshing Graph status with checks for the expected title and task text.

- [ ] **Step 2: Add the duplicate Continue regression**

Mount a checkpoint workflow whose Continue handler returns an unresolved promise. Press `c` twice, wait for `Continuing...`, and assert one invocation. Resolve the promise and wait for `c Continue` to return.

- [ ] **Step 3: Run focused TUI tests with a memory cap**

```bash
systemd-run --user --wait --collect --working-directory="$(pwd)" -p MemoryMax=1G -p MemorySwapMax=256M /home/kailiangs/.bun/bin/bun test test/app-graph-workflow.test.tsx test/dialog-graph-status.test.tsx
```

Expected: focused TUI tests pass. If renderer output is corrupt or readiness times out, stop and diagnose the current OpenTUI environment rather than raising the memory limit.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/test/app-graph-workflow.test.tsx packages/tui/test/dialog-graph-status.test.tsx
git commit -m "test(tui): stabilize graph status interactions"
```

### Task 5: Verify The Combined Product

**Files:**
- Verify only; modify production code only for a reproduced regression.

- [ ] **Step 1: Run package verification**

From package directories, run App unit/browser tests and typechecks, focused OpenCode Graph tests, TUI typecheck, and SDK typecheck. Use transient systemd limits for test commands that execute UI renderers.

Expected: zero failures, no OOM kill, and no service crossing its memory cap.

- [ ] **Step 2: Run accepted Graph Vibe regressions**

Run the product migration, product shell, workflow cockpit, and authenticated reload Playwright specs with one worker and line reporting.

Expected: migration, startup authentication, Home workflow entry, Main/Plan navigation, and same-session return pass.

- [ ] **Step 3: Launch the review instance**

Start backend and Vite as separate systemd user services on unused loopback ports. Use explicit Bun and Node 24 paths, isolated XDG roots, Basic auth, `MemoryMax=1536M`, `MemorySwapMax=256M`, and `OOMPolicy=kill` for each service.

- [ ] **Step 4: Perform visual acceptance**

Open the authenticated review URL and verify:

- Home starts a Graph workflow.
- Plan exposes workflow state and execution controls.
- Main exposes released topology and no execution controls.
- Mobile Graph canvas has positive dimensions.
- Returning from `Describe a goal` preserves the session.
- Service memory remains below configured limits.

- [ ] **Step 5: Await user acceptance before merging**

Keep `graph-workflow-review` separate from `dev` until the user approves the running result. Do not merge, push, or delete `graph-workflow-wip` during acceptance.
