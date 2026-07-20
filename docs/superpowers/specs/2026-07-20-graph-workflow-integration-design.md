# Graph Workflow Integration Design

## Goal

Integrate the valid Graph workflow command and presentation work preserved in
`graph-workflow-wip` into the latest `dev` product baseline without regressing
Graph Vibe migration, authentication, routing, or the accepted frontend flow.

The integration is delivered on `graph-workflow-review` and remains separate
from `dev` until automated verification and user visual acceptance complete.

## Scope

The integration restores:

- A read-only Main graph backed by `/graph/main`.
- The existing executable Plan workflow backed by current-plan and workflow
  projections.
- Main-specific task rail and inspector content derived from visible graph
  nodes.
- Canvas resize and redraw behavior needed when the mobile Graph tab becomes
  visible.
- Canvas simulation stability when only selection or current-task styling
  changes.
- Accessible workflow progress semantics.
- TUI Graph status refresh and duplicate-action protection.
- Regression coverage for the combined behavior.

The integration does not change server APIs, schemas, storage, migration,
authentication, or generated SDK output. The orphan
`graph-nullability-patch.test.ts` is excluded because its referenced production
script was never preserved in the WIP checkpoint.

## Architecture

The latest `dev` branch remains authoritative. Valid changes from commit
`d419ecade` are selectively applied rather than merging the old branch state.

`GraphPage` continues to own source selection. It passes the selected source to
`GraphCockpit`:

- `currentPlan` uses the durable workflow projection, current task, checkpoint,
  progress, execution mode, and Continue/Pause actions.
- `main` uses the graph returned by `/graph/main`. The cockpit derives a
  read-only task model from visible nodes and suppresses execution controls.

`GraphCockpit` remains the common presentation boundary. It selects the task
model, modules, actions, labels, current-node highlighting, inspector guidance,
and announcements based on the source. Main and Plan do not duplicate the
overall cockpit layout.

`GraphCanvas` separates topology changes from style changes. Node and edge
identity changes restart layout simulation. Selection, current task, and
non-topological updates redraw without restarting simulation. A
`ResizeObserver` redraws after container size changes, including hidden mobile
tabs becoming visible.

## Data Flow

1. The route and selected source remain owned by `GraphPage`.
2. `GraphPage` fetches `/graph/current-plan` or `/graph/main` through the
   existing query path.
3. `GraphPage` passes the source, workflow projection, and graph projection to
   `GraphCockpit`.
4. For Plan, the cockpit uses workflow tasks and modules unchanged.
5. For Main, the cockpit maps visible graph nodes into a read-only task rail and
   one synthetic Main module.
6. Node selection remains local UI state and updates the shared inspector.
7. Canvas topology reconciliation runs only when graph identity, node IDs, or
   edge topology changes.

## Error Handling

- Existing Graph unavailable, loading, empty, and route-level error handling
  remains authoritative.
- Main never exposes Continue, Pause, mode selection, or workflow state strips.
- Plan retains existing pending-state disabling and workflow guidance.
- A missing selected node falls back to the current Plan task or first visible
  graph node according to source.
- Resize observation is optional; environments without `ResizeObserver` retain
  the window resize fallback.
- TUI pending actions ignore duplicate keys until the first action settles.

## Conflict Resolution

The only predicted textual merge conflict is
`packages/app/e2e/regression/graph-workflow-cockpit.spec.ts`. Resolution must
preserve both the latest Graph Vibe product-shell scenarios and the WIP Main
graph/mobile canvas assertions. No accepted migration or authentication test may
be removed to make the conflict pass.

The orphan SDK test is omitted rather than weakened or replaced with a stub.
Recovering nullable SDK generation is a separate task that requires the missing
production transformation design.

## Verification

Verification is bounded to prevent another WSL-wide OOM:

- Run unit and browser tests under a systemd memory limit.
- Run App, E2E, OpenCode, TUI, and SDK typechecks from package directories.
- Run focused Graph cockpit App, E2E, and TUI tests first.
- Run broader App suites only after focused tests pass.
- Do not rerun the known runaway WIP test unchanged.
- Launch backend and Vite as separate systemd user services with explicit
  memory limits and compatible Bun/Node paths.
- Verify Main is read-only, Plan retains controls, mobile Canvas has positive
  dimensions, and the accepted Graph Vibe Home/session flow remains intact.

## Acceptance

The integration is ready to merge only when:

- Main shows released topology and no execution controls.
- Plan shows workflow controls and current-task state.
- Canvas remains visible after mobile tab changes and does not restart layout
  for selection-only updates.
- TUI status refresh and duplicate action tests pass.
- Migration, authenticated reload, Home workflow entry, and same-session return
  remain functional.
- The bounded services stay below their memory limits during visual acceptance.
- The user approves the final running result before merge to `dev`.
