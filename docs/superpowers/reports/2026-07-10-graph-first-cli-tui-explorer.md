# CLI and TUI Explorer Report

## Status

Completed read-only exploration. PSOC remains valid.

## Identity Boundary

- Add a synchronous dynamic identity module at `packages/core/src/product.ts`.
- Select Graph Vibe only when `OPENCODE_CLIENT === "graph-vibe"`; all other values retain OpenCode identity.
- Evaluate identity at access time because tests and command paths mutate environment after imports.
- Do not rename packages, protocols, config paths, provider IDs, SDK symbols, telemetry keys, or persisted OpenCode infrastructure.

## Launcher Findings

- `scripts/graph-vibe` sets Graph mode but not `OPENCODE_CLIENT`; preserve its uncommitted symlink and caller-cwd fix.
- Root `package.json` invokes the OpenCode entrypoint directly and does not select Graph Vibe identity.
- `packages/opencode/package.json` maps `graph-vibe` to `bin/opencode`, but that wrapper does not inspect its invoked alias.
- The packaged alias must set both `OPENCODE_CLIENT=graph-vibe` and `OPENCODE_ENABLE_GRAPH_MODE=1` before launching the compiled executable.

## CLI Findings

- `packages/opencode/src/index.ts` hard-codes `.scriptName("opencode")` and command-help prefix detection.
- `packages/opencode/src/cli/ui.ts` unconditionally renders `Graph Vibe OpenCode · forked from anomalyco/opencode`, including ordinary OpenCode launches.
- Generic command descriptions, error guidance, update/uninstall text, mini-TUI presentation, and continuation commands should read product identity.
- Compatibility strings such as `opencode.json`, package names, OpenCode provider products, and issue metadata remain unchanged.

## TUI Findings

- `packages/tui/src/routes/home.tsx` owns the home placeholder and can render the fixed Graph Workflow capability block before the prompt.
- Graph commands belong in `appCommands` in `packages/tui/src/app.tsx` and must be conditionally registered, not merely hidden.
- `usePromptRef()` supports `set()` and `focus()`, allowing `/graph-start` to insert the approved template without submitting.
- Existing `Graph.currentPlan(...)` SDK data is sufficient for `/graph-status`; aggregate node `status` and `testStatus` without adding an API.
- Add focused pure helpers at `packages/tui/src/graph/workflow.ts` and dialogs for guide/status.
- `/graph-open` needs an explicit browser Web URL because source Vite and backend origins differ and internal transport uses `opencode.internal`.
- Help, status, terminal titles, crash labels, epilogue commands, tips, and permission guidance have separate hard-coded presentation strings.

## Tests

- Add `packages/core/test/product.test.ts` for dynamic identity selection.
- Add CLI subprocess identity coverage near `packages/opencode/test/cli/help/help-snapshots.test.ts`.
- Add `packages/tui/test/graph-workflow.test.ts` for task template, status aggregation, and graph URLs.
- Add TUI integration coverage near `packages/tui/test/app-lifecycle.test.tsx` for command registration, onboarding, titles, and command behavior.
- Extend `packages/tui/test/util/presentation.test.ts` for identity-specific continuation commands.

## Verification

- `packages/core`: `bun test test/product.test.ts && bun typecheck`
- `packages/tui`: focused graph workflow and lifecycle tests, then `bun typecheck`
- `packages/opencode`: focused CLI help/error/thread tests, then `bun typecheck`
- `packages/app`: session route regression test and `bun typecheck`

## Risks

- Product identity must not be cached at module load.
- Slash command registration must avoid custom-command collisions.
- Diagnostics are node-level, not a session-wide run state.
- Full and mini TUI presentation paths are separate.
- Solid/OpenTUI conventions must be used instead of React patterns.
