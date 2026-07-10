# Graph-First Product Experience Design

## Problem

Graph Vibe currently enables graph workflow behavior inside OpenCode's system context and tool registry, but the product surface does not explain or expose that behavior. Users launch `graph-vibe` and still see OpenCode-oriented CLI help, TUI copy, tips, and commands. In source mode, `graph-vibe web` silently falls back to `https://app.opencode.ai` when no embedded UI exists, so the browser displays upstream OpenCode without Graph Vibe's graph page.

The result is a hidden capability rather than a usable product mode. Even project developers cannot reliably tell whether Graph Workflow is active, how to start a graph-guided task, how to inspect progress, or why the Web UI lacks graph functionality.

## Product Principles

1. Graph capability is primary. The default user-facing experience explains Plan, Build, and Verify before discussing implementation details.
2. OpenCode attribution is respectful but secondary. User-facing surfaces use `Powered by OpenCode`; persistent `forked from` branding is removed.
3. Internal compatibility remains intact. Package names, protocol types, database structures, SDK exports, and provider identifiers retain their OpenCode-compatible names.
4. Product identity is centralized. CLI, TUI, server output, and Web UI must not independently hard-code product names.
5. Incorrect fallback is an error. Graph Vibe must never silently serve upstream Web UI when the local Graph Vibe UI is unavailable.
6. New users begin with normal language. Internal graph tools remain agent-facing; users receive workflow commands and task templates instead.

## Product Identity Boundary

Introduce a lightweight product identity module in Core with two projections:

- OpenCode identity for upstream-compatible launches.
- Graph Vibe identity when the launcher sets `OPENCODE_CLIENT=graph-vibe`.

Graph Vibe identity contains:

```text
id: graph-vibe
name: Graph Vibe
cli: graph-vibe
capability: Graph-guided development
attribution: Powered by OpenCode
```

The `scripts/graph-vibe` launcher sets:

```bash
OPENCODE_CLIENT=graph-vibe
OPENCODE_ENABLE_GRAPH_MODE=1
```

User-facing code reads the product identity for command names, help text, terminal titles, startup messages, error labels, documentation links, and attribution. Internal imports and wire contracts do not use product identity.

## CLI Experience

`graph-vibe -h` must render Graph Vibe as the command name and use Graph Vibe descriptions and examples. Commands inherited unchanged from OpenCode remain available, but their user-facing invocation examples use the active product CLI name.

Expected help header:

```text
Graph Vibe
Graph-guided development powered by OpenCode

Usage: graph-vibe [project]
```

`graph-vibe` with no arguments opens the TUI for the caller's current directory. `graph-vibe web` starts the Graph Vibe Web UI. `graph-vibe serve` remains a headless API server.

## TUI Experience

### Home

When Graph Workflow is active, the home screen displays a stable capability block below the logo:

```text
GRAPH WORKFLOW  ACTIVE
Plan → Build → Verify
Describe your goal normally, or run /graph-start
```

The normal prompt placeholder becomes graph-oriented, for example:

```text
Describe what you want to build; Graph Vibe will plan it first
```

Graph onboarding guidance takes priority over random generic tips. Normal OpenCode tips remain available after the graph guidance has been shown.

### Commands

Graph commands are visible only while Graph Workflow is enabled:

- `/graph`: opens the Graph Workflow guide.
- `/graph-start`: inserts a beginner-friendly task template into the prompt and focuses the editor.
- `/graph-status`: shows Current Plan counts grouped by status and diagnostics state for the active session.
- `/graph-open`: opens the active session's graph in Graph Vibe Web. When no session or Web endpoint exists, it gives an actionable message instead of failing silently.

The task template is:

```text
What do you want to build or change?

Goal:
Success criteria:
Constraints:
```

The Graph guide describes only user actions:

1. Describe the desired outcome in normal language.
2. Graph Vibe creates and validates a plan.
3. Inspect progress with `/graph-status`.
4. Completion requires diagnostics to pass.

Agent-facing tool names such as `graph_plan_admit` and `graph_diagnostics_run` do not appear in beginner guidance.

### Supporting Surfaces

- `/help` includes a Graph Workflow section when active.
- `/status` displays Graph Workflow state.
- Terminal title and crash/error screens use the active product name.
- OpenCode attribution appears in About/help, not as a permanent logo subtitle.

## Web Experience

### Source Development

For a source checkout, `graph-vibe web` launches two coordinated processes:

1. Graph-enabled backend server.
2. Local `packages/app` Vite server targeting that backend.

The command opens the Vite URL, reports both backend and Web URLs, forwards termination signals, and shuts both children down together. It preserves the caller's project directory for initial project selection.

### Packaged Binary

Production builds embed this repository's `packages/app/dist` through the existing embedded Web UI build path. Graph Vibe identity forbids fallback to `https://app.opencode.ai` when embedded assets are absent. The server returns an explicit diagnostic response explaining that Graph Vibe Web assets are unavailable.

OpenCode identity retains upstream fallback behavior to minimize changes to the upstream-compatible path.

### Graph Navigation

The Web UI exposes Graph from the active session header and supports both directory-keyed and server-keyed routes. Graph API calls use the SDK's decoded directory, never an encoded route segment.

## Data Flow

1. Launcher sets product identity and Graph Workflow flags.
2. CLI reads product identity before constructing yargs help.
3. TUI reads the same identity and Graph flag to register Graph commands and render onboarding.
4. `/graph-start` modifies only the local prompt draft; submission follows the normal session path.
5. Core graph system context and tool registry admit and execute the workflow.
6. `/graph-status` reads graph HTTP endpoints for the current session and directory.
7. `/graph-open` constructs the correct Web graph URL from active server/session context.
8. `graph-vibe web` serves local Graph Vibe assets and the same graph HTTP API.

## Error Handling

- Graph commands hidden when Graph Workflow is disabled.
- `/graph-status` without a session reports that the user must start or select a session.
- `/graph-open` without an active Web endpoint prints the exact `graph-vibe web` command.
- Missing local Web assets in Graph Vibe mode return a non-200 diagnostic response; no upstream proxy fallback occurs.
- Failure of either source-mode Web child process terminates the other and returns a non-zero exit code.
- Product identity defaults to OpenCode unless explicitly selected, preserving upstream-compatible behavior.

## Testing

### Product Identity

- Graph Vibe launcher selects Graph Vibe identity.
- Default/upstream launch retains OpenCode identity.
- CLI help uses the selected command name.

### TUI

- Graph commands register only when Graph Workflow is enabled.
- `/graph-start` inserts the expected template.
- Graph home capability block and placeholder render while enabled.
- `/graph-status` handles no-session, empty-plan, and populated-plan states.
- `/graph-open` produces directory-keyed and server-keyed URLs and reports missing Web configuration.

### Web

- Source launcher starts backend and Vite, opens the Vite URL, and cleans up both processes.
- Graph Vibe mode never proxies upstream UI when embedded assets are missing.
- OpenCode mode retains the existing upstream fallback.
- Embedded Graph Vibe build contains the graph route and session entry.

### Regression

- Core and OpenCode typechecks pass.
- Focused graph API, graph tool, app route, and TUI command tests pass.
- A live smoke starts `graph-vibe` and `graph-vibe web` from `examples/game-2048`, creates a session, opens Graph, and reads Current Plan status.

## Scope Boundaries

This work does not rename internal packages, SDK symbols, protocol fields, database tables, provider integrations, or persisted OpenCode paths. Those names are compatibility infrastructure rather than product presentation. The graph visualization's deeper visual redesign remains a separate iteration after product identity, onboarding, and Web delivery are reliable.
