# Graph-First Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Graph Vibe a coherent Graph-first CLI, TUI, and Web product while preserving OpenCode-compatible internal contracts and default behavior.

**Architecture:** A dynamic Core product identity controls presentation without renaming internal infrastructure. The Graph Vibe launcher selects that identity and Graph mode; CLI/TUI read it at user-facing boundaries. Web delivery serves embedded assets when available, preserves upstream fallback for OpenCode, rejects that fallback for Graph Vibe, and coordinates local backend plus Vite in source checkouts.

**Tech Stack:** TypeScript, Bun, Effect v4, yargs, Solid/OpenTUI, Vite, Bun test.

---

## File Structure

- `packages/core/src/product.ts`: dynamic product identity selected from `OPENCODE_CLIENT`.
- `packages/core/test/product.test.ts`: identity selection and non-caching regression tests.
- `scripts/graph-vibe`: source launcher identity, graph mode, source root, and caller directory.
- `packages/opencode/bin/opencode`: npm alias identity selection.
- `packages/opencode/src/index.ts`: identity-aware yargs command name and help rendering.
- `packages/opencode/src/cli/ui.ts`: identity-aware CLI logo metadata.
- `packages/opencode/src/server/shared/ui.ts`: explicit embedded/upstream/error policy.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`: pass identity-derived fallback policy.
- `packages/opencode/src/cli/cmd/web.ts`: select packaged or source Graph Vibe Web delivery.
- `packages/opencode/src/cli/cmd/web-source.ts`: source backend/Vite process coordination.
- `packages/tui/src/graph/workflow.ts`: task draft, status aggregation, and graph URL helpers.
- `packages/tui/src/component/dialog-graph-guide.tsx`: beginner workflow guide.
- `packages/tui/src/component/dialog-graph-status.tsx`: Current Plan status display.
- `packages/tui/src/app.tsx`: conditional Graph commands, Web URL input, and terminal identity.
- `packages/tui/src/routes/home.tsx`: Graph Workflow capability block and prompt hint.
- `packages/tui/src/ui/dialog-help.tsx`: Graph command help and attribution.
- `packages/tui/src/component/dialog-status.tsx`: Graph mode state.

### Task 1: Dynamic Product Identity and Launchers

**Files:**
- Create: `packages/core/src/product.ts`
- Create: `packages/core/test/product.test.ts`
- Modify: `scripts/graph-vibe`
- Modify: `package.json`
- Modify: `packages/opencode/bin/opencode`

- [ ] **Step 1: Write the failing identity tests**

Test dynamic selection and exact public values:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { Product } from "../src/product"

const original = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = original
})

describe("Product.current", () => {
  test("uses OpenCode by default", () => {
    delete process.env.OPENCODE_CLIENT
    expect(Product.current()).toEqual(Product.OpenCode)
  })

  test("selects Graph Vibe dynamically", () => {
    process.env.OPENCODE_CLIENT = "graph-vibe"
    expect(Product.current()).toEqual(Product.GraphVibe)
    process.env.OPENCODE_CLIENT = "cli"
    expect(Product.current()).toEqual(Product.OpenCode)
  })
})
```

- [ ] **Step 2: Run the Core test and verify RED**

Run from `packages/core`:

```bash
bun test test/product.test.ts
```

Expected: failure because `src/product.ts` does not exist.

- [ ] **Step 3: Implement the dynamic identity**

Use a synchronous module with a self-export:

```ts
export const OpenCode = {
  id: "opencode",
  name: "OpenCode",
  cli: "opencode",
  capability: "The AI coding agent built for the terminal",
  attribution: "",
} as const

export const GraphVibe = {
  id: "graph-vibe",
  name: "Graph Vibe",
  cli: "graph-vibe",
  capability: "Graph-guided development",
  attribution: "Powered by OpenCode",
} as const

export function current() {
  return process.env.OPENCODE_CLIENT === GraphVibe.id ? GraphVibe : OpenCode
}

export * as Product from "./product"
```

- [ ] **Step 4: Select Graph Vibe in every launcher**

`scripts/graph-vibe` exports identity, graph mode, source root, and caller directory while preserving symlink resolution and package-local cwd. The root `graph-vibe` script invokes this launcher. The npm wrapper derives its alias from the unresolved invoked basename before `realpathSync(__filename)` and passes this environment into `spawn`:

```js
const graphVibe = path.basename(process.argv[1]).startsWith("graph-vibe")
const env = graphVibe
  ? { ...process.env, OPENCODE_CLIENT: "graph-vibe", OPENCODE_ENABLE_GRAPH_MODE: "1" }
  : process.env
```

- [ ] **Step 5: Run identity and launcher verification**

Run from `packages/core`:

```bash
bun test test/product.test.ts
bun typecheck
```

Run from repo root only for non-test launcher smokes:

```bash
scripts/graph-vibe -h
```

Expected: Core tests pass; launcher reaches the CLI with Graph Vibe environment and retains caller directory behavior.

### Task 2: CLI Product Presentation

**Files:**
- Create: `packages/opencode/test/cli/help/product-identity.test.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/src/cli/ui.ts`
- Modify: `packages/opencode/src/cli/error.ts`
- Modify: generic command presentation files under `packages/opencode/src/cli/cmd`

- [ ] **Step 1: Write real-process CLI help tests**

Use the existing CLI process helper to assert:

```ts
expect(openCode.stderr).toContain("opencode [project]")
expect(openCode.stderr).not.toContain("Graph Vibe")
expect(graphVibe.stderr).toContain("Graph Vibe")
expect(graphVibe.stderr).toContain("graph-vibe [project]")
expect(graphVibe.stderr).toContain("Powered by OpenCode")
expect(graphVibe.stderr).not.toContain("forked from")
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run from `packages/opencode`:

```bash
bun test test/cli/help/product-identity.test.ts
```

Expected: Graph Vibe invocation still reports `opencode` and fixed fork branding.

- [ ] **Step 3: Make yargs and logo identity-aware**

Read `Product.current()` once while constructing the CLI, use `product.cli` for `.scriptName(...)`, usage, and command-help prefix detection, and use product fields in `UI.logo()`.

- [ ] **Step 4: Replace generic presentation-only command strings**

Use `Product.current().name` or `.cli` in top-level command descriptions, provider guidance, restart/update text, and command examples. Keep compatibility names such as `opencode.json`, provider products, package names, and internal IDs unchanged.

- [ ] **Step 5: Run focused CLI tests and typecheck**

Run from `packages/opencode`:

```bash
bun test test/cli/help/product-identity.test.ts test/cli/help/help-snapshots.test.ts test/cli/error.test.ts
bun typecheck
```

Expected: both identities pass without changing default OpenCode behavior.

### Task 3: Identity-Aware Web UI Fallback

**Files:**
- Modify: `packages/opencode/test/server/httpapi-ui.test.ts`
- Modify: `packages/opencode/src/server/shared/ui.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`

- [ ] **Step 1: Write the no-upstream Graph Vibe tests**

Extend the focused UI test helper with `allowUpstreamFallback`. Cover:

```ts
expect(response.status).toBe(503)
expect(await response.text()).toContain("Graph Vibe Web assets are unavailable")
expect(proxiedUrl).toBeUndefined()
```

Keep the existing OpenCode upstream proxy assertion as a regression test.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `packages/opencode`:

```bash
bun test test/server/httpapi-ui.test.ts
```

Expected: the new option or 503 behavior is absent.

- [ ] **Step 3: Implement explicit delivery policy**

Extend `serveUIEffect` services with:

```ts
allowUpstreamFallback: boolean
```

After embedded asset lookup and before creating an upstream request, return:

```ts
HttpServerResponse.text(
  "Graph Vibe Web assets are unavailable. Rebuild Graph Vibe with embedded Web assets or run it from the source launcher.",
  { status: 503 },
)
```

The server route passes `Product.current().id !== Product.GraphVibe.id`.

- [ ] **Step 4: Run UI tests and typecheck**

Run from `packages/opencode`:

```bash
bun test test/server/httpapi-ui.test.ts
bun typecheck
```

Expected: Graph Vibe never calls upstream; OpenCode fallback and embedded delivery remain green.

### Task 4: Source Graph Vibe Web Coordinator

**Files:**
- Create: `packages/opencode/src/cli/cmd/web-source.ts`
- Create: `packages/opencode/test/cli/web-source.test.ts`
- Modify: `packages/opencode/src/cli/cmd/web.ts`
- Modify: `scripts/graph-vibe`
- Modify: `packages/app/src/entry.tsx` only if wildcard host calculation requires extraction

- [ ] **Step 1: Write coordinator contract tests**

Test injected process operations rather than globals. The contract accepts source root, project directory, network options, environment, child spawner, readiness waiters, browser opener, and termination signal. Assert backend cwd/argv, Vite cwd/env, encoded project URL, sibling cleanup, non-zero child failure, and timeout cleanup.

- [ ] **Step 2: Run the coordinator test and verify RED**

Run from `packages/opencode`:

```bash
bun test test/cli/web-source.test.ts
```

Expected: `web-source.ts` does not exist.

- [ ] **Step 3: Implement source coordination**

Validate these files before source mode starts:

```text
packages/opencode/src/index.ts
packages/app/package.json
```

Start backend `serve` with the caller project as cwd, wait for its listening URL, start Vite with backend host/port environment, wait for its URL, open the URL-safe encoded project route, then race child exits and termination signals. Cleanup terminates and awaits both children before returning.

- [ ] **Step 4: Select source coordination only for Graph Vibe source launches**

`WebCommand` calls the coordinator only when product identity is Graph Vibe and the validated launcher source-root environment exists. Packaged and ordinary OpenCode launches retain the existing in-process server path.

- [ ] **Step 5: Run source Web tests and live smoke**

Run from `packages/opencode`:

```bash
bun test test/cli/web-source.test.ts test/cli/serve/serve-process.test.ts
bun typecheck
```

Live smoke from `examples/game-2048` starts `graph-vibe web`, verifies the opened Web origin is local Vite, requests a Graph route, and terminates the process tree.

### Task 5: Pure TUI Graph Workflow Model

**Files:**
- Create: `packages/tui/src/graph/workflow.ts`
- Create: `packages/tui/test/graph-workflow.test.ts`

- [ ] **Step 1: Write helper tests**

Pin the exact task draft, ordered status counts, empty state, directory-keyed graph URL, server-keyed graph URL, and missing Web endpoint result.

- [ ] **Step 2: Run the helper test and verify RED**

Run from `packages/tui`:

```bash
bun test test/graph-workflow.test.ts
```

Expected: helper module does not exist.

- [ ] **Step 3: Implement pure helpers**

Export `TASK_DRAFT`, `summarizeCurrentPlan(nodes)`, and `graphWebUrl(input)`. Aggregate `pending`, `implemented`, `verified`, `deprecated` and `none`, `pending`, `passed`, `failed` in fixed order. Build URLs with Core `base64Encode` and never encode an already encoded directory.

- [ ] **Step 4: Run helper tests and TUI typecheck**

Run from `packages/tui`:

```bash
bun test test/graph-workflow.test.ts
bun typecheck
```

### Task 6: TUI Onboarding and Graph Commands

**Files:**
- Create: `packages/tui/src/component/dialog-graph-guide.tsx`
- Create: `packages/tui/src/component/dialog-graph-status.tsx`
- Create: `packages/tui/test/app-graph-workflow.test.tsx`
- Modify: `packages/tui/src/app.tsx`
- Modify: `packages/tui/src/routes/home.tsx`
- Modify: `packages/tui/src/ui/dialog-help.tsx`
- Modify: `packages/tui/src/component/dialog-status.tsx`

- [ ] **Step 1: Write TUI integration tests**

Using the existing OpenTUI renderer fixture, cover commands absent when disabled, all four slash commands present when enabled, exact `/graph-start` draft, guide copy, status aggregation, no-session guidance, no-Web guidance, Graph Workflow home block, and Graph Vibe terminal title.

- [ ] **Step 2: Run integration tests and verify RED**

Run from `packages/tui`:

```bash
bun test test/app-graph-workflow.test.tsx
```

Expected: no Graph commands or onboarding components exist.

- [ ] **Step 3: Render Graph-first onboarding**

When Graph mode is enabled, render:

```text
GRAPH WORKFLOW  ACTIVE
Plan → Build → Verify
Describe your goal normally, or run /graph-start
```

Use `Describe what you want to build; Graph Vibe will plan it first` as the normal prompt hint and keep generic tips below it.

- [ ] **Step 4: Register and implement four commands**

Conditionally spread `/graph`, `/graph-start`, `/graph-status`, and `/graph-open` into `appCommands`. `/graph-start` changes only the mounted prompt draft and focuses it. `/graph-status` reads `sdk.client.graph.currentPlan` with the active session and decoded SDK directory. `/graph-open` uses the explicit TUI Web URL and shows the exact `graph-vibe web` recovery command when unavailable.

- [ ] **Step 5: Extend help and status**

Help lists the four Graph commands and attribution. Status reports Graph Workflow Active; Graph Vibe identity with graph mode unexpectedly disabled reports the corrective launcher command.

- [ ] **Step 6: Run focused TUI tests and typecheck**

Run from `packages/tui`:

```bash
bun test test/graph-workflow.test.ts test/app-graph-workflow.test.tsx test/app-lifecycle.test.tsx
bun typecheck
```

### Task 7: Remaining User-Facing Identity Surfaces

**Files:**
- Modify: `packages/tui/src/component/logo.tsx`
- Modify: `packages/tui/src/component/error-component.tsx`
- Modify: `packages/tui/src/util/presentation.ts`
- Modify: `packages/tui/src/util/error.ts`
- Modify: `packages/tui/src/routes/session/permission.tsx`
- Modify: `packages/tui/src/feature-plugins/home/tips-view.tsx`
- Modify: mini-TUI files under `packages/opencode/src/cli/cmd/run`
- Modify: existing presentation tests

- [ ] **Step 1: Write identity regression assertions**

Assert default OpenCode and Graph Vibe continuation commands, crash labels, terminal title, generic tips, mini splash, and restart guidance. Do not assert renamed config/provider/package infrastructure.

- [ ] **Step 2: Run focused tests and verify RED**

Run from `packages/tui` and `packages/opencode` using the existing presentation and run-command test files.

- [ ] **Step 3: Replace presentation-only hard-coded names**

Use `Product.current()` at render/access time. Remove unconditional `forked from anomalyco/opencode`; show `Powered by OpenCode` only in Help/About-style surfaces.

- [ ] **Step 4: Run focused suites and typechecks**

Run from `packages/tui`:

```bash
bun test test/util/presentation.test.ts test/app-lifecycle.test.tsx test/util/renderer.test.ts
bun typecheck
```

Run from `packages/opencode`:

```bash
bun test test/cli/help/product-identity.test.ts test/cli/error.test.ts
bun typecheck
```

### Task 8: Packaging, Build, and End-to-End Verification

**Files:**
- Modify: `packages/opencode/script/publish.ts`
- Modify: `packages/opencode/package.json`
- Modify: `docs/graph-mode.md`
- Modify: `docs/superpowers/reports/2026-07-10-graph-first-product-experience.md`

- [ ] **Step 1: Preserve the Graph Vibe bin in generated package metadata**

Generate both entries:

```json
{
  "opencode": "./bin/opencode.exe",
  "graph-vibe": "./bin/graph-vibe.js"
}
```

The Graph Vibe wrapper sets identity and Graph mode before launching the installed OpenCode executable. Keep platform packages and native executable names unchanged.

- [ ] **Step 2: Update user documentation**

Document global CLI, Graph commands, source Web behavior, packaged embedded Web behavior, explicit missing-assets error, and OpenCode compatibility boundary.

- [ ] **Step 3: Run full focused verification**

Run package-local tests and typechecks from Core, TUI, OpenCode, and App. Build the app from `packages/app` with `bun run build` and one native package from `packages/opencode` with:

```bash
bun run script/build.ts --single --skip-install
```

- [ ] **Step 4: Run live CLI/TUI/Web dogfood**

From `examples/game-2048`, verify:

```text
graph-vibe -h              -> Graph Vibe identity
graph-vibe                 -> Graph Workflow onboarding and commands
/graph-status              -> Current Plan counts
/graph-open                -> active session Graph route
```

- [ ] **Step 5: Independent review and final audit**

Dispatch a read-only reviewer against the design, plan, report, and final diff. Fix every Critical/Important finding, rerun affected tests, close all harness agents, run `ledger-audit --mode final`, and record commits, test evidence, risks, and final status in the controller report.
