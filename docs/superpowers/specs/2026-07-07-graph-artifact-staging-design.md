# Graph Artifact Staging Design

## Goal

Finish the remaining graph-mode reliability gaps by adding a production staged artifact flow for large changes, completing the missing graph write API surface, and wiring graph-specific realtime invalidation.

## Current State

`graph_artifact_apply` is the only graph-mode file write path. It accepts a complete `full` or `patch` artifact in one tool call, runs the Build gate, asks `graph.artifact_write`, validates the artifact against current files, writes all target files, updates the node to `implemented`, records audit rows, and now emits progress metadata.

This works for small changes but does not solve large artifacts. A single staging tool that accepts a complete artifact would still put the full content in one tool argument, so the new flow must accept content through multiple bounded chunks.

Several earlier dogfood gaps are already done: natural `contains` edges, `@N` plan references, repairable plan rejection, diagnostics timeout/filter/fix budget, main/current-plan graph views, graph diff, and HTTP delete node/edge. The remaining work is staged artifact input, missing graph write endpoints, graph-specific realtime events, and final dogfood harness coverage.

## Architecture

The system gets a durable `GraphArtifactDraft` workflow service in `packages/core`. Drafts are session-scoped and target one CurrentPlan node. Drafts collect file content chunks and metadata, but they never write the worktree. Final writes remain centralized in `graph_artifact_apply`.

Artifact capabilities expand from `full` and `patch` to include a `files` artifact for multi-file full-content writes. A sealed draft assembles to this `files` artifact. Existing `full` and `patch` behavior stays intact for small artifacts.

The staged flow is:

1. `graph_artifact_begin` creates an open draft for `projectID + sessionID + targetNodeID` with expected file metadata.
2. `graph_artifact_chunk` appends or replaces one bounded chunk for one draft file.
3. `graph_artifact_seal` verifies expected chunk counts and optional SHA-256 hashes, then marks the draft sealed.
4. `graph_artifact_apply` accepts either a direct artifact or a `draftID`. With a `draftID`, it loads the sealed draft, assembles the artifact, reruns the Build gate, asks permission, validates against current files, writes files, updates graph state, records audit, marks the draft applied, and emits progress metadata.

Direct `graph_artifact_apply` remains supported. If direct artifact content exceeds the direct-size threshold, the tool returns a repairable blocked result telling the agent to use staged artifacts or split the graph node.

## Draft Data Model

`graph_artifact_draft` stores:

- `id`: branded draft ID.
- `project_id`, `session_id`, `node_id`: ownership and cleanup keys.
- `status`: `open`, `sealed`, `applied`, or `cancelled`.
- `test`: test command/summary required for assembled files artifacts.
- `files`: JSON array of file draft entries.
- timestamps.

Each file draft entry contains:

- `path`: relative project path.
- `expected_chunks`: optional count.
- `expected_sha256`: optional final content hash.
- `chunks`: ordered chunk array with index and content.

The service exposes small methods: `create`, `get`, `list`, `putChunk`, `seal`, `markApplied`, and `cancel`. It does not know about permissions or worktree writes.

## Tool API

`graph_artifact_begin`:

```ts
{
  targetNodeID: string
  test: string
  files: Array<{
    path: string
    expectedChunks?: number
    expectedSha256?: string
  }>
}
```

`graph_artifact_chunk`:

```ts
{
  draftID: string
  path: string
  index: number
  content: string
}
```

`graph_artifact_seal`:

```ts
{
  draftID: string
}
```

`graph_artifact_apply`:

```ts
{
  targetNodeID: string
  artifact?: Artifact
  draftID?: string
}
```

Exactly one of `artifact` or `draftID` is required. The existing direct `artifact` path remains the small-artifact path.

## Error Handling

- Path escape is rejected before permission prompts, for both direct artifacts and drafts.
- Begin requires at least one file and non-empty test text.
- Chunk requires an existing open draft, a declared path, and a non-negative index.
- Seal fails with repairable output when chunks are missing, duplicated inconsistently, or final hashes do not match.
- Apply with a draft requires `sealed` status, matching session, and matching target node.
- Build gate blocks still return successful tool output with `applied:false` and no permission prompt.
- Artifact validation failure remains blocked and writes no files.
- Direct artifacts over threshold return a repairable blocked result with `reason:"artifact_too_large"`.

## Graph Write API

Add HTTP endpoints for the missing non-tool graph writes:

- `POST /graph/plan/admit`: admit a CurrentPlan for a session using the same domain service as `graph_plan_admit`.
- `PATCH /graph/node/:nodeID/status`: update node `status` and/or `testStatus` after resolving project/session context.
- `POST /graph/current-plan/promote`: promote a session CurrentPlan to main graph using existing `GraphDomain.promote`.

Handlers remain thin. They derive `projectID` and `sessionID` from route/session context, call core services, translate validation errors to 400 and not-found errors to 404, and publish graph events after successful mutations.

## Realtime Events

Add graph-specific events:

- `graph.plan.updated`: CurrentPlan changed. Payload includes `projectID`, `sessionID`, optional `nodeID`, optional `draftID`, and `reason`.
- `graph.main.updated`: main graph changed. Payload includes `projectID`, optional `sessionID`, optional version fields, and `reason`.

Publish once per high-level mutation, after DB mutation completes. The app graph page listens for these events and invalidates existing graph query keys. Existing message/file/session invalidation stays as fallback.

## Prompt And Harness Constraints

The graph prompt changes from “generate artifact and apply” to:

- small artifact: direct `graph_artifact_apply` is allowed;
- large or multi-file artifact: `graph_artifact_begin` → `graph_artifact_chunk` → `graph_artifact_seal` → `graph_artifact_apply({ draftID })`;
- large tasks should be split into graph atomic nodes first; staged artifact is for large content inside one valid atomic node, not a replacement for planning.

Dogfood uses an ignored project path and must prove a large multi-file artifact can be staged, sealed, applied, diagnosed, and observed without raw write tools.

## Testing Strategy

Core tests cover draft persistence, chunk ordering, seal validation, hash mismatch, status transitions, and assembled `files` artifacts.

Opencode tool tests cover begin/chunk/seal/apply, direct oversize blocking, staged apply preserving Build gate/permission/no-partial-write semantics, graph mode registry exposure, and prompt instructions.

HttpApi tests cover plan admit, node status patch, promote, and event publication side effects where practical.

App tests cover graph page invalidation when receiving `graph.plan.updated` or `graph.main.updated` events.

Final verification runs focused core/opencode/app tests, package typechecks, SDK generation if HttpApi contracts changed, and one real graph-mode dogfood session.
