# Graph Main Publication Design

## Goal

Close the product gap between a completed Graph workflow and the project Main
graph. A completed Current Plan remains unpublished until the user explicitly
confirms publication. After publication, Main shows the released topology and
the originating session can still review its completed Plan as an immutable
snapshot.

## Observed Defect

The accepted review session reached `complete` with every atomic task verified,
but `/graph/main` returned no nodes and the project had no graph versions. This
is valid storage state because promotion is explicit. The product defect is
that no reachable UI action performs that promotion, while selecting Main
renders an empty cockpit without explaining why.

An empty-state-only patch is insufficient: it would explain the blank canvas
without providing a way to publish a completed workflow.

## Product Semantics

- Current Plan is session-scoped work under review.
- Main is project-scoped, versioned, released topology.
- Workflow completion makes a Plan eligible for publication; it does not
  publish automatically.
- Publication requires an explicit user confirmation.
- Promotion remains the single storage operation that moves Current Plan nodes
  and edges into Main and creates a `graph_version` snapshot.
- A published session's Plan remains available as a read-only view of the
  version created by that session.

## Scope

This work adds:

- a user-confirmed `Publish to Main` action for completed workflows;
- an explicit empty Main state instead of an empty cockpit;
- a session Plan read model that falls back to the session's latest published
  version after promotion;
- validated graph-version snapshot decoding for persisted snapshot shapes;
- publication success, conflict, and retry behavior;
- regression coverage across Core, Server, App, and focused browser acceptance.

This work does not:

- auto-publish completed workflows;
- show unpromoted Current Plan nodes as if they were Main;
- change build-gate, verification, or conflict policy;
- redesign the Graph entry as a Changes-style review panel;
- add a new database table or alter the promotion transaction's ownership
  semantics.

## Architecture

### Published Plan Read Model

Add a session-aware Plan read model with this response shape:

```ts
type SessionPlanView = {
  source: "currentPlan" | "version"
  versionNumber: number | null
  publishedAt: number | null
  nodes: GraphNode[]
  edges: GraphEdge[]
}
```

The resolver loads the session's Current Plan first. If it contains nodes, that
graph remains authoritative. If it is empty, the resolver loads the newest
`graph_version` whose `project_id` and `session_id` match the workflow. If such
a version exists, its decoded snapshot becomes the read-only Plan view. If
neither exists, the resolver returns an empty `currentPlan` view.

Expose this read model through a new `GET /graph/plan-view?session=...`
endpoint. Keep `/graph/current-plan` unchanged because build gates and other
runtime consumers depend on its strict meaning: live, unpromoted session rows
only. This public Server `HttpApi` addition requires regenerating the Client
projections rather than editing generated sources directly.

`GraphWorkflowProjection` uses the same resolver rather than reading Current
Plan directly. This preserves workflow tasks, modules, progress, and audit
evidence after promotion without duplicating Plan-selection logic.

### Version Snapshot Compatibility

`graph_version` already stores `session_id`, version metadata, and a complete
snapshot, so no migration or workflow-state column is required. Promotion keeps
its existing persisted snapshot format.

Snapshot reads decode the persisted Drizzle-shaped rows into canonical graph
API rows. The decoder also accepts canonical rows that may already exist through
imports or earlier development data because graph versions are persisted user
data. Decoding produces a validated `GraphView`; malformed snapshots fail
explicitly rather than being cast to graph rows.

Add a focused storage operation for the latest version belonging to a project
and session. It queries by `project_id` and `session_id`, ordered by version
number descending, instead of loading every project version in memory.

### App Publication Flow

The Plan header shows `Publish to Main` only when all of these are true:

- workflow phase is `complete`;
- the Plan read model source is `currentPlan`;
- the Plan contains at least one node;
- no publication mutation is pending.

Selecting the action opens a confirmation dialog. The dialog states that Main
is project-wide and versioned and shows the node and edge counts that will be
published. Cancellation performs no request.

Confirmation calls the existing `/graph/current-plan/promote` endpoint. The
button and confirmation action remain disabled while the request is pending.
On success, the App invalidates Plan, workflow, Main, and version queries,
clears stale node selection, switches to Main, and announces the created
version. Switching back to Plan uses the immutable version-backed view.

### Empty Main State

When Main contains no nodes, `GraphPage` does not mount `GraphCockpit` with an
empty graph. It renders a specific `No published topology` state.

If the current workflow is complete and still has an unpublished Current Plan,
the state explains that the Plan is ready to publish and provides a return to
Plan action. Otherwise it explains that Main will appear after a completed Plan
is published. Publication itself remains in Plan so the user confirms while
viewing the exact scope being released.

## Data Flow

### Before Publication

1. Plan view resolves to live Current Plan rows.
2. Workflow projection derives tasks and evidence from that graph.
3. Main remains the project graph and may be empty.
4. A complete workflow exposes `Publish to Main` in Plan.

### Publication

1. The user opens the confirmation dialog and reviews node and edge counts.
2. Confirmation invokes the existing guarded promotion endpoint.
3. The workflow service verifies that no checkpoint or unfinished task remains.
4. The storage transaction snapshots the Plan with its session identity, moves
   its nodes and edges into Main, and returns the new version.
5. `graph.main.updated` is published as it is today.

### After Publication

1. Main loads the promoted project topology.
2. Strict Current Plan is empty by design.
3. Session Plan view resolves to the latest version snapshot for that session.
4. Workflow projection uses the same snapshot plus session audit evidence.
5. The user can switch between released Main and the completed, read-only Plan.

## Error Handling

- If workflow state changes before confirmation, promotion remains guarded by
  the existing workflow completion checks. The App refreshes Plan and workflow
  state and asks the user to review again.
- If another client publishes first, the second request cannot create an empty
  version. The App refreshes and resolves to the already-published snapshot.
- Network failure leaves the user on Plan with no optimistic Main state and a
  retryable error.
- Snapshot decode failure reports the Plan as unavailable; it never substitutes
  unvalidated data or silently falls back to an unrelated project version.
- Main remains read-only and never exposes Continue, Pause, mode, or mutation
  controls.

## Testing

### Core

- latest session version selects the highest matching version and ignores other
  sessions and projects;
- canonical imported snapshots decode as `GraphView`;
- persisted snake-case snapshots decode to the same `GraphView`;
- malformed snapshots fail explicitly;
- workflow projection uses Current Plan before publication and the matching
  version snapshot after publication while retaining evidence.

### Server

- Plan view returns `source: "currentPlan"` before promotion;
- incomplete workflows still reject promotion;
- completed workflows promote once and create one version;
- Plan view returns `source: "version"` with the published graph afterward;
- Main contains the promoted graph;
- a repeated promotion does not create an empty second version.

### App

- empty Main renders guidance rather than an empty cockpit;
- incomplete Plan does not expose publication;
- completed, unpublished Plan exposes publication;
- cancel performs no mutation;
- confirm disables duplicate submission;
- success refreshes data, switches to Main, and preserves Plan review;
- stale or failed promotion refreshes state without optimistic publication.

### Browser Acceptance

- complete a focused workflow, confirm publication, and observe released nodes
  in Main;
- return to Plan and observe the completed task topology and evidence;
- reload the authenticated session and retain both views;
- verify Main has no execution controls and the working tree is unchanged by
  publication.

After changing the public Server `HttpApi`, regenerate Client sources with
`bun run generate` from `packages/client`, then typecheck the affected App,
Client, Core, OpenCode, and SDK packages.

## Acceptance

- A completed workflow never publishes without user confirmation.
- The user has a reachable publication action and clear confirmation boundary.
- Successful publication creates exactly one version and populates Main.
- The originating session retains a read-only completed Plan after promotion.
- Empty Main is explanatory, not blank.
- Existing strict Current Plan, build-gate, migration, authentication, and
  generated-client contracts remain valid.
- The Graph review-panel interaction remains a separately tracked optimization.
