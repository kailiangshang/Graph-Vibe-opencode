# Graph Collaboration UX Design

## Context

The `game-2048` dogfood session `ses_0b51b82baffeH3cNoU2mGGpnVu` exposed two connected product problems.

The Graph page lacks a stable task hierarchy. Selection exists only inside the page, there is no durable current task, the inspector appears and disappears, controls compete for space, and the canvas is the only place where relationships are visible.

The conversation is driven by a prompt named "Autopilot." It admits a plan, exposes internal tool names, and then instructs the model to continue through every pending node. When the user asked for step-by-step implementation, the model completed ten atomic tasks without a checkpoint. It repeated the same progress sentence after each task and claimed every task was verified even though the project still had only one test file covering the original game logic.

The Graph engine enforced artifact writes and project diagnostics correctly, but the product did not provide a collaborative execution contract or trustworthy task-level verification.

## Goals

- Make the complete task list and current task visible before and during implementation.
- Synchronize task-list selection, graph-node selection, and a stable details inspector.
- Let the user select atomic, module, or autopilot execution cadence.
- Enforce cadence and checkpoints in shared Core state rather than relying on model compliance.
- Replace internal Graph tool identifiers with user-facing workflow activities.
- Persist task-specific verification requirements and bounded verification evidence.
- Derive composite and PRD progress from descendant atomic tasks.
- Deliver a restrained liquid-glass visual language without reducing contrast, accessibility, or mobile usability.
- Preserve existing OpenCode-compatible package names, internal tool IDs, Graph HTTP compatibility boundaries, and stored Graph data.

## Non-Goals

- Replacing the custom graph canvas with a third-party graph library.
- Promoting Graph HTTP into the new Protocol/Client boundary.
- Building clustered or remotely coordinated Graph execution.
- Turning the Graph page into a general project-management product.
- Storing unbounded command output in Graph tables.
- Renaming internal Graph tools or database identifiers.

## Product Model

Graph collaboration has four user-facing concepts:

1. **Plan**: an ordered set of atomic tasks grouped into modules.
2. **Current task**: the only atomic task authorized for mutation.
3. **Execution mode**: when the workflow must stop for user confirmation.
4. **Checkpoint**: a durable boundary that prevents further mutation until the user continues.

The graph remains the implementation source of truth, but clients consume a shared workflow projection instead of independently inferring current work from node status.

## Execution Modes

### Atomic

- The first atomic task starts after the plan is presented.
- A pending checkpoint is created after every successfully verified atomic task.
- Continuing authorizes exactly the next atomic task.
- Best for high-control or unfamiliar work.

### Module

- This is the default and recommended mode.
- The first module starts after the plan is presented.
- Atomic tasks inside the authorized module may continue in dependency order.
- A pending checkpoint is created after all atomic descendants of that module are verified.
- Continuing authorizes the next module.

### Autopilot

- The plan is presented, then all buildable atomic tasks may continue in dependency order.
- Routine atomic and module checkpoints are skipped.
- The workflow still stops for an explicit key decision, structural ambiguity, exhausted repair budget, or user pause.

Mode selection is a user action. The agent may describe or recommend modes but cannot approve a checkpoint or change the persisted mode through a model tool.

The user selects a mode in `/graph-start`, the Graph page, or the TUI Graph status dialog. The mode may be changed only while idle or at a checkpoint. A user pause creates a checkpoint before the next mutation boundary.

## Plan Presentation

Successful plan admission produces a structured user-facing plan card in both Web and TUI conversation timelines. This rendering does not depend on the model writing a good summary.

The plan card contains:

- Goal
- Execution mode
- Module count and atomic task count
- Ordered modules and atomic tasks
- Verification criteria summary
- First current task
- When the workflow will next stop

The card appears before the first artifact mutation part in the conversation timeline. Internal names such as `graph_plan_admit`, `graph_build_gate`, and `graph_artifact_apply` never appear in normal user-facing text.

The system instruction still contains registered tool names because the model needs them, but it explicitly prohibits quoting those identifiers to the user. It requires human vocabulary such as “preparing the plan,” “checking readiness,” “applying task changes,” and “verifying the task.”

## Conversation Contract

Before planning a broad or ambiguous goal, the agent asks focused product questions instead of inventing a large feature set. Once enough context exists, it admits the plan and lets the structured plan card present the complete task list.

Before every mutation scope, the conversation states:

- Current task name
- Module name
- Intended user-visible outcome
- Verification that will be run

Progress updates occur at meaningful boundaries, not after every internal tool call. A useful update includes what changed, verification evidence, what comes next, and whether user action is required.

At a checkpoint the assistant explains exactly what continuing authorizes and points to the Continue action. It does not interpret vague phrases as approval. Approval is accepted only through the revisioned user API used by the TUI/Web action.

Tool failures that recover internally remain compact. A failure that changes scope, exhausts retry budget, or blocks progress becomes a user-facing blocker with cause and options.

The final summary reports verified, failed, and remaining tasks from the workflow projection. It does not claim that pending composite or PRD nodes are complete.

## Durable Workflow State

Add one `graph_workflow_state` row per session:

```text
session_id               primary key, foreign key session
project_id               foreign key project
mode                     atomic | module | autopilot, nullable until selected
current_node_id          nullable foreign key graph_node
checkpoint_kind          atomic | module | decision | failure | pause, nullable
checkpoint_scope_node_id nullable foreign key graph_node
checkpoint_status        none | pending | approved
checkpoint_reason        nullable text
revision                 integer
time_created             integer
time_updated             integer
```

The row stores authority, not duplicate task progress. Atomic node `status` and `test_status` remain canonical for implementation and verification outcomes.

The existing `graph_tool_run` audit remains the transition history. It records mode changes, checkpoint requests, approvals, current-task changes, task verification, and module completion.

### Revision Rules

- Plan admission or plan mutation increments `revision` and invalidates prior approval.
- Mode change increments `revision`.
- Checkpoint creation increments `revision`.
- Approval requires `expectedRevision` equal to the current revision.
- Stale approval returns a typed conflict and never changes authority.
- Repeating an approval for the already-approved current revision is idempotent.

## Plan Admission And Advancement

Plan admission performs these operations transactionally:

1. Validate and persist nodes and edges.
2. Require executable tasks to be atomic nodes.
3. Compute stable atomic ordering from `blocks` dependencies with node ID as deterministic tie-breaker.
4. Resolve each atomic task to one nearest incoming `contains` composite.
5. Reject module mode when an atomic task has multiple nearest composite parents.
6. Preserve an existing user-selected mode.
7. Set the first atomic task as current.
8. In atomic mode, mark the first atomic scope approved for the current revision.
9. In module mode, mark the first composite scope approved for the current revision.
10. In autopilot, set no routine checkpoint and authorize dependency-ordered execution.
11. Emit plan and workflow invalidation events.

If no mode has been selected, the plan remains visible but mutation is blocked with `execution_mode_required` until the user selects one.

After complete successful diagnostics:

- Atomic mode selects the next atomic as current and creates a pending atomic checkpoint that names that next task.
- Module mode advances automatically within the approved module. After its final atomic, it selects the first atomic of the next module as current and creates a pending module checkpoint that names the completed and upcoming modules.
- Autopilot advances to the next buildable atomic unless another hard checkpoint exists.
- Failed diagnostics retain the same current task and authorization scope.
- Exhausted repair budget creates a failure checkpoint.
- Completion clears the current task and leaves no approval authority.

Checkpoint approval authorizes only the current revision and scope. In atomic mode that scope is one node; in module mode it is one unambiguous composite and its atomic descendants. The next advancement invalidates that approval before selecting another scope.

## Build-Gate Enforcement

Checkpoint enforcement belongs in shared Core `GraphBuild.evaluate`, because both current Core tools and legacy OpenCode tools already reevaluate this gate immediately before artifact application.

The gate adds these stable issue codes:

- `execution_mode_required`
- `checkpoint_pending`
- `current_task_mismatch`
- `target_not_atomic`
- `module_scope_ambiguous`
- `dependency_not_verified`
- `verification_spec_missing`
- `verification_evidence_incomplete`

Only the durable `current_node_id` may receive an artifact. Artifact application to PRD or composite nodes is rejected.

A blocking dependency must be `verified`; `implemented` is no longer sufficient. Readiness HTTP, build ordering, and the shared gate use the same rule.

The direct status mutation HTTP endpoint may not set `implemented` or `verified`. Those transitions remain owned by artifact application and complete diagnostics. Manual deprecation and reset actions use narrower action-specific contracts.

Promotion to Main requires every executable atomic task to be verified and no pending checkpoint or failed task.

## Task-Specific Verification

Each newly admitted atomic node includes a structured verification specification:

```ts
{
  criteria: string[]
  diagnostics: Array<{
    name: "test" | "typecheck" | "lint"
    paths?: string[]
  }>
}
```

Rules:

- Criteria must be non-empty and describe observable behavior.
- Diagnostic names refer only to server-detected project scripts.
- Paths are validated relative project paths; raw shell commands are never accepted.
- Focused test paths must exist before diagnostics can verify a task.
- Complete project diagnostics still run after focused checks.
- A task is verified only when its focused checks and complete project checks pass.
- UI work requires an automated browser, DOM, or component test path rather than an unrelated logic test.

Existing persisted nodes without a verification specification retain compatibility. They may run full project diagnostics, but the projection labels their evidence as “project checks only” and does not pretend that focused acceptance criteria were proven.

Add bounded structured evidence to `graph_tool_run`:

```ts
{
  kind: "diagnostics"
  nodeID: string
  criteria: string[]
  artifactPaths: string[]
  complete: boolean
  passed: boolean
  commands: Array<{
    name: string
    command: string
    exitCode: number | null
    timedOut: boolean
    passed: boolean
    excerpt?: string
  }>
}
```

Excerpts are size-limited. Full output remains in Session history.

## Shared Workflow Projection

Core exposes one projection consumed by HTTP, Web, and TUI:

```ts
{
  mode: "atomic" | "module" | "autopilot" | null
  revision: number
  phase: "planning" | "building" | "verifying" | "checkpoint" | "complete" | "failed"
  checkpoint: {
    status: "none" | "pending" | "approved"
    kind?: "atomic" | "module" | "decision" | "failure" | "pause"
    scopeNodeID?: string
    scopeName?: string
    reason?: string
  }
  currentTask: WorkflowTask | null
  modules: WorkflowModule[]
  tasks: WorkflowTask[]
  progress: {
    total: number
    verified: number
    failed: number
    percent: number
  }
}
```

`tasks` contains atomic nodes only. Each task includes module identity, stable order, status, test status, buildable/current flags, verification summary, and latest bounded evidence.

Composite and PRD statuses are derived for display:

- `verified`: every descendant atomic is verified
- `implemented`: at least one descendant has started but not all are verified
- `pending`: no descendant has started
- `failed`: at least one descendant has failed diagnostics

Raw GraphView statuses remain unchanged for compatibility.

## HTTP API

Keep Graph in the existing compatibility `InstanceHttpApi` boundary.

Add:

```text
GET   /graph/workflow?session=...
PATCH /graph/workflow/mode?session=...
POST  /graph/workflow/checkpoint/approve?session=...
POST  /graph/workflow/checkpoint/pause?session=...
```

Mutation payloads carry `expectedRevision`. Responses return the updated workflow projection. Conflicts are typed and include the current projection so clients can recover without guessing.

Extend node audit to expose bounded input/output summaries, errors, and structured evidence. Do not expose unbounded command output.

Graph workflow changes emit a schema event that invalidates Web and TUI projections.

After changing this HTTP API, regenerate the legacy JavaScript SDK with `./packages/sdk/js/script/build.ts`. Do not edit generated files directly. `packages/client` generation is not required because Graph remains outside Protocol.

## Graph Web: Workflow Cockpit

### Desktop Layout

The Graph route becomes a stable three-column cockpit:

1. **Task rail**, 272-304px
2. **Graph canvas**, flexible center
3. **Details inspector**, 320-360px

The top bar contains project/session context, Plan/Build/Verify phase, source selector, execution-mode control, progress, pause/continue state, and a back-to-session action.

### Task Rail

- Groups atomic tasks under derived composite modules.
- Shows stable order, verified/current/blocked/pending/failed state, and module progress.
- Keeps the current task visible and highlighted.
- Selecting a task updates the shared selected node and centers it in the graph.
- Uses semantic buttons and a keyboard-accessible scroll region.

### Graph Canvas

- Remains the relationship visualization, not the only accessible task representation.
- Single click selects and updates the details inspector.
- Double click centers and zooms the node.
- Clicking empty canvas clears manual selection and returns the inspector to the durable current task.
- Current, selected, verified, blocked, pending, and failed states use shape/icon/text plus color.
- Simulation input updates reactively when source, filter, or graph data changes.
- Initial layout is deterministic.
- The animation loop settles and suspends; reduced motion disables continuous movement.
- Wheel coordinates use container-local positions.
- Canvas colors resolve from semantic CSS variables.

### Details Inspector

The inspector is always present on desktop. With no manual selection it shows the durable current task. It contains:

- Task and module names
- Current status and checkpoint state
- Goal and acceptance criteria
- Dependencies and blockers
- Changed files
- Verification checks and latest evidence
- User actions such as Continue, Pause, View Changes, and Return to Current Task

Actions stay in a sticky inspector footer. Canvas zoom and centering controls remain separate from workflow actions.

### Mobile Layout

Below 768px, render one accessible tabset:

- Tasks
- Graph
- Details

The selected node ID and durable current task are shared across tabs. Selecting a task switches to Graph only when the user asks to locate it; otherwise the task list remains stable. Touch targets are at least 44px.

## Liquid-Glass Visual Language

The visual direction is restrained and tool-focused, not decorative glass everywhere.

- Base uses existing cold neutral semantic backgrounds.
- Top bar, task rail, inspector, current-task banner, and node cards use translucent semantic surfaces with a solid fallback.
- Backdrop blur is limited to major surfaces.
- Borders use low-opacity light edges and existing elevation tokens.
- The graph canvas keeps a stable dark or light base with subtle depth gradients.
- Primary text remains opaque.
- Primary actions remain solid rather than translucent.
- No neon-lime global accent.

State palette uses existing semantic tokens, adjusted toward lower saturation:

- Current/active: muted cyan-teal
- Verified: restrained green
- Blocked/checkpoint: amber
- Failed: semantic red
- Pending: neutral blue-gray
- Manual selection: cool blue outline distinct from current task

Light and dark themes receive explicit surface mixes. `prefers-reduced-transparency` falls back to opaque surfaces where supported, and reduced-motion removes nonessential transitions.

## TUI Collaboration Surface

`/graph-start` opens or inserts an execution-mode choice with Module preselected. It starts the plan request without requiring a second plan-review step.

`/graph-status` shows:

- Mode
- Phase
- Current task and module
- Ordered task names with status
- Verified/total progress
- Pending checkpoint reason
- Continue and Pause actions when applicable

Add `/graph-continue` as an explicit revisioned checkpoint approval. The command fetches the current projection immediately before approval and handles stale revision conflicts by refreshing the dialog.

Generic Graph tool rendering maps internal IDs to user activities. Raw `graph_*` identifiers are not shown in normal frames, expanded tool titles, or subagent status text.

## Error Handling

- Loading, empty-plan, no-mode, checkpoint, complete, and request-error states are visually distinct.
- Stale revisions refresh workflow state and explain that the plan changed.
- A selected node removed by refetch falls back to the current task, then the first task.
- Plan-level readiness issues are labeled as plan issues rather than selected-task failures.
- Failed task diagnostics show a bounded excerpt and link back to the session transcript for complete output.
- A mode change attempted during active mutation is rejected with guidance to Pause first.
- Network mutations disable only the affected action and retain readable current state.

## Accessibility

- Use existing accessible Tabs, SegmentedControl, Button, Progress, Badge, and ScrollView primitives.
- Task list is the semantic keyboard representation of graph nodes.
- Current task and progress changes are announced through a polite live region.
- State is never encoded by color alone.
- Focus remains in the initiating pane unless a user explicitly asks to locate a graph node.
- Inspector actions have stable labels and visible focus states.
- Canvas has an accessible label and points users to the task list for keyboard navigation.
- Contrast is checked in light/dark themes and glass/opaque fallbacks.

## File Boundaries

Expected new or changed boundaries:

- Core workflow state schema, migration, service, projection, gate, advancement, verification, and tests
- Existing Graph HTTP group/handlers and server tests
- Regenerated legacy JavaScript SDK
- Graph page shell and pure projection helpers
- New extracted `graph-canvas.tsx` complex rendering boundary
- Graph cockpit component and Playwright tests
- TUI status/start/continue surfaces and tests
- Web and TUI Graph tool presentation mappings and tests
- Canonical Graph workflow prompt and instruction tests
- User documentation

Do not add a graph-library dependency or a global liquid-glass design-system primitive in this change. Keep visual styles local to the Graph cockpit until the pattern proves reusable.

## Testing Strategy

### Core

- Workflow state persistence and migration parity
- Revisioned mode and checkpoint transitions
- Atomic, module, and autopilot advancement
- Pause, failure, and stale-plan behavior
- Current-task and atomic-target enforcement
- Verified-only dependencies
- Parent rollup and ambiguous module membership
- Verification-spec validation and structured evidence

### Tools

- Artifact apply cannot bypass a checkpoint or current-task mismatch
- Blocked apply requests no write permission and writes no files
- Complete diagnostics advance workflow correctly
- Failed diagnostics retain current authority
- Unrelated passing tests cannot verify a focused task
- Current and legacy Graph tool integrations share enforcement

### HTTP And SDK

- Workflow projection, mode change, pause, approval, stale revision conflict
- Plan change invalidates authority
- State survives runtime reconstruction
- Evidence appears in node audit
- Direct status API cannot forge implementation or verification
- Legacy SDK regeneration is clean

### Web

- Pure ordering, grouping, filtering, rollup, selection reconciliation, and progress helpers
- Desktop three-pane synchronization
- Mobile task/graph/details tabs
- Keyboard behavior and live announcements
- Loading, empty, error, checkpoint, and complete states
- Light/dark, reduced motion, and opaque fallback
- Reactive canvas data updates and deterministic positioning

### TUI And Conversation

- Plan card lists all tasks before mutation activity
- `/graph-status` shows mode/current task/task names/checkpoint
- `/graph-continue` uses exact revision
- Internal Graph tool IDs do not appear in user-facing snapshots
- Prompt requires user-facing vocabulary and mode semantics

### Dogfood Acceptance

Run a fresh `game-2048` session from a clean baseline:

1. Request a broad enhancement.
2. Confirm the assistant asks focused questions or uses supplied constraints.
3. Confirm the plan card lists modules/tasks and current work before mutation.
4. Exercise module mode and verify a real module checkpoint.
5. Confirm the Graph cockpit tracks current task and evidence.
6. Confirm each new behavior has focused tests rather than reusing only `logic.test.ts`.
7. Confirm the final summary matches durable task and parent rollups.

## Acceptance Criteria

- A user can answer “what is being changed now, why, and how it will be verified” from either TUI or Graph Web without reading internal tool logs.
- Execution cadence is selected by the user and enforced after restart.
- Artifact mutation cannot proceed beyond a pending checkpoint.
- Current task is durable and consistent across Core, HTTP, Web, TUI, and conversation rendering.
- Plan, task, and verification claims match persisted state and evidence.
- The Graph page implements the approved three-pane liquid-glass cockpit and mobile tab equivalent.
- No Critical or Important accessibility, security, lifecycle, or compatibility findings remain after review.
