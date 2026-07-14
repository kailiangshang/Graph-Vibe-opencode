# Graph Vibe Storage Isolation and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Graph Vibe a completely independent runtime namespace and a guided, resumable, one-time migration from OpenCode configuration, credentials, selected sessions, and historical Graph data.

**Architecture:** Bootstrap selects an immutable product profile before global paths are evaluated. Migration Core reads an OpenCode database through a read-only SQLite transaction, journals work only in Graph Vibe's database, imports selected relational closures, then reconstructs Graph history without replaying effects. TUI and Web consume typed migration projections, while Core enforces the first-run write gate.

**Tech Stack:** TypeScript, Bun, Effect v4, Drizzle SQLite, Effect HttpApi, SolidJS, OpenTUI, Electron, Bun test, Playwright

---

## File Structure

Isolation foundation:

- Modify `packages/core/src/product.ts`: immutable product profile fields and bootstrap selection.
- Modify `packages/core/src/global.ts`: profile-derived global path construction.
- Modify `packages/core/src/database/database.ts`: profile-derived database filename and unsafe overlap guard.
- Modify `packages/core/src/flag/flag.ts`: Graph Vibe unsafe-path and migration test overrides.
- Modify `packages/opencode/bin/graph-vibe.cjs`: establish product identity before executable import.
- Modify `scripts/graph-vibe`: remove shared database behavior and use isolated profile defaults.

Configuration and lifecycle:

- Modify `packages/opencode/src/config/paths.ts`: read-only `.opencode` and writable `.graph-vibe` source descriptors.
- Modify `packages/opencode/src/config/config.ts`: provenance-aware writes and Graph Vibe config names.
- Modify `packages/opencode/src/config/tui.ts`: preserve source mutability through TUI config loading.
- Modify `packages/opencode/src/cli/cmd/agent.ts`, `mcp.ts`, and `plug.ts`: route Graph Vibe project writes to `.graph-vibe`.
- Modify `packages/opencode/src/installation/index.ts`, `cli/cmd/upgrade.ts`, and `cli/cmd/uninstall.ts`: product-specific package lifecycle.
- Modify `packages/cli/src/services/daemon.ts`: product-specific registration and default port.
- Modify `packages/desktop/src/main/index.ts`, `server.ts`, `sidecar.ts`, and `electron-builder.config.ts`: independent desktop identity and environment.

Migration domain:

- Create `packages/schema/src/product-migration.ts`: public migration schemas and tagged errors.
- Create `packages/core/src/product-migration/sql.ts`: migration and item journal tables.
- Create `packages/core/src/product-migration/state.ts`: lifecycle, plan revisions, item transitions, and finalization.
- Create `packages/core/src/product-migration/source.ts`: read-only OpenCode source discovery and snapshot transaction.
- Create `packages/core/src/product-migration/planner.ts`: category, project, session, size, and conflict planning.
- Create `packages/core/src/product-migration/config.ts`: staged config and credential import.
- Create `packages/core/src/product-migration/session.ts`: selected session relationship closure import.
- Create `packages/core/src/product-migration/graph.ts`: mixed-store Graph import and deterministic reconstruction.
- Create `packages/core/src/product-migration/service.ts`: orchestration and write-gate projection.
- Add generated database migration through the existing `packages/core/script/migration.ts` workflow.

API and clients:

- Create `packages/opencode/src/server/routes/instance/httpapi/groups/product-migration.ts` and matching handler: discovery, plan, execute, pause, retry, validate, finalize.
- Modify `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts` and `handlers/global.ts` to register migration endpoints.
- Regenerate `packages/sdk/js/src/v2/gen` with the mandated SDK script.
- Create `packages/tui/src/component/dialog-product-migration.tsx`: first-run migration wizard.
- Modify `packages/tui/src/app.tsx`: enforce migration gate before normal routing.
- Create `packages/app/src/pages/product-migration.tsx`: responsive migration onboarding.
- Modify `packages/app/src/app.tsx` and startup data context: route Graph Vibe to migration before project/session UI.

## Task 1: Immutable Product Profile and Global Paths

**Files:**
- Modify: `packages/core/src/product.ts`
- Modify: `packages/core/src/global.ts`
- Test: `packages/core/test/product.test.ts`
- Test: `packages/core/test/global.test.ts`

- [ ] **Step 1: Write failing profile and path tests**

Add table-driven assertions that OpenCode resolves `opencode` and Graph Vibe resolves `graph-vibe`, including data, config, cache, state, tmp, log, repos, database basename, ports, package, desktop ID, and protocol.

```ts
test("Graph Vibe owns an isolated runtime profile", () => {
  expect(Product.forClient("graph-vibe")).toMatchObject({
    id: "graph-vibe",
    storage: "graph-vibe",
    database: "graph-vibe.db",
    backendPort: 4097,
    uiPort: 4444,
    package: "graph-vibe",
    desktopID: "ai.graph-vibe.desktop",
    protocol: "graph-vibe",
  })
})

test("profile paths never overlap", () => {
  const open = Global.paths(Product.OpenCode, roots)
  const graph = Global.paths(Product.GraphVibe, roots)
  expect(Object.keys(open).filter((key) => key !== "home").every((key) => open[key] !== graph[key])).toBe(true)
})
```

- [ ] **Step 2: Run the focused Core tests and observe RED**

Run from `packages/core`:

```bash
bun test test/product.test.ts test/global.test.ts
```

Expected: fail because profiles do not expose storage/lifecycle fields and global paths are hard-coded.

- [ ] **Step 3: Implement profile-derived paths**

Add a pure profile selector and pure path constructor. Resolve `Path` once from `Product.current()` at module initialization.

```ts
export const GraphVibe = {
  id: "graph-vibe",
  name: "Graph Vibe",
  cli: "graph-vibe",
  storage: "graph-vibe",
  database: "graph-vibe.db",
  config: "graph-vibe",
  backendPort: 4097,
  uiPort: 4444,
  package: "graph-vibe",
  desktopID: "ai.graph-vibe.desktop",
  protocol: "graph-vibe",
  capability: "Graph-guided development",
  attribution: "Powered by OpenCode",
} as const

export function paths(profile: Product.Profile, roots = platformRoots()) {
  const data = path.join(roots.data, profile.storage)
  const cache = path.join(roots.cache, profile.storage)
  return {
    home: roots.home,
    data,
    config: path.join(roots.config, profile.storage),
    cache,
    state: path.join(roots.state, profile.storage),
    tmp: path.join(roots.tmp, profile.storage),
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
  }
}
```

- [ ] **Step 4: Verify Core tests and typecheck**

Run from `packages/core`:

```bash
bun test test/product.test.ts test/global.test.ts
bun typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit isolation profile**

```bash
git add packages/core/src/product.ts packages/core/src/global.ts packages/core/test/product.test.ts packages/core/test/global.test.ts
git commit -m "fix(core): isolate graph vibe global paths"
```

## Task 2: Database, Launcher, and Unsafe Overlap Guard

**Files:**
- Modify: `packages/core/src/database/database.ts`
- Modify: `packages/core/src/flag/flag.ts`
- Modify: `packages/opencode/bin/graph-vibe.cjs`
- Modify: `scripts/graph-vibe`
- Create: `packages/core/test/database.test.ts`
- Test: `packages/opencode/test/cli/graph-vibe-launcher.test.ts`
- Test: `packages/opencode/test/cli/graph-vibe-published-bin.test.ts`

- [ ] **Step 1: Write failing database and launcher tests**

Assert default Graph Vibe uses `<graph data>/graph-vibe.db`, local launch no longer sets `OPENCODE_DISABLE_CHANNEL_DB`, and an explicit OpenCode DB path is rejected unless `GRAPH_VIBE_ALLOW_OPENCODE_PATHS=1`.

```ts
expect(Database.pathFor(Product.GraphVibe, graphPaths, {})).toBe(path.join(graphPaths.data, "graph-vibe.db"))
expect(() => Database.pathFor(Product.GraphVibe, graphPaths, { OPENCODE_DB: openDB })).toThrow(
  "Graph Vibe refuses an OpenCode database path",
)
```

- [ ] **Step 2: Run tests and observe RED**

Run from `packages/core` and `packages/opencode`:

```bash
bun test test/database.test.ts
bun test test/cli/graph-vibe-launcher.test.ts test/cli/graph-vibe-published-bin.test.ts
```

- [ ] **Step 3: Implement database selection and launcher cleanup**

Use the profile basename for stable channels, retain channel suffixes inside the product namespace, and make overlap validation a pure function used before opening SQLite. Remove `OPENCODE_DISABLE_CHANNEL_DB` from Graph Vibe launchers.

- [ ] **Step 4: Verify focused tests and typechecks**

Run from both package directories:

```bash
bun test test/database.test.ts
bun typecheck
bun test test/cli/graph-vibe-launcher.test.ts test/cli/graph-vibe-published-bin.test.ts
bun typecheck
```

- [ ] **Step 5: Commit database isolation**

```bash
git add packages/core/src/database/database.ts packages/core/src/flag/flag.ts packages/core/test/database.test.ts packages/opencode/bin/graph-vibe.cjs scripts/graph-vibe packages/opencode/test/cli
git commit -m "fix(opencode): isolate graph vibe database"
```

## Task 3: Read-Only `.opencode` Compatibility and `.graph-vibe` Overlay

**Files:**
- Modify: `packages/opencode/src/config/paths.ts`
- Modify: `packages/opencode/src/config/config.ts`
- Modify: `packages/opencode/src/config/tui.ts`
- Modify: `packages/opencode/src/config/tui-migrate.ts`
- Modify: `packages/opencode/src/cli/cmd/agent.ts`
- Modify: `packages/opencode/src/cli/cmd/mcp.ts`
- Modify: `packages/opencode/src/cli/cmd/plug.ts`
- Test: `packages/opencode/test/config/config.test.ts`
- Test: `packages/opencode/test/config/tui.test.ts`
- Test: `packages/opencode/test/cli/graph-vibe-config.test.ts`

- [ ] **Step 1: Write failing immutability and overlay tests**

Create a project with `.opencode/opencode.json`, package files, and no `.gitignore`. Load Graph Vibe config and assert byte-for-byte source equality, no dependency install, and `.graph-vibe/graph-vibe.json` precedence.

```ts
expect(await Bun.file(openConfig).text()).toBe(before)
expect(await fileExists(path.join(project, ".opencode", ".gitignore"))).toBe(false)
expect(result.model).toBe("graph/provider-model")
```

- [ ] **Step 2: Run config tests and observe RED**

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts test/config/tui.test.ts test/cli/graph-vibe-config.test.ts
```

- [ ] **Step 3: Add source provenance and mutability**

Return descriptors instead of bare paths.

```ts
export class Source extends Schema.Class<Source>("ConfigSource")({
  directory: Schema.String,
  product: Schema.Literals(["opencode", "graph-vibe"]),
  writable: Schema.Boolean,
}) {}
```

Skip schema insertion, gitignore creation, package installation, and migrations for `writable: false`. Route Graph Vibe project CLI writes to `.graph-vibe`.

- [ ] **Step 4: Run full config tests and typecheck**

```bash
bun test test/config test/cli/graph-vibe-config.test.ts
bun typecheck
```

- [ ] **Step 5: Commit config isolation**

```bash
git add packages/opencode/src/config packages/opencode/src/cli/cmd packages/opencode/test/config packages/opencode/test/cli/graph-vibe-config.test.ts
git commit -m "fix(opencode): isolate graph vibe configuration"
```

## Task 4: Independent Package, Daemon, and Desktop Lifecycle

**Files:**
- Modify: `packages/opencode/src/installation/index.ts`
- Modify: `packages/opencode/src/cli/cmd/upgrade.ts`
- Modify: `packages/opencode/src/cli/cmd/uninstall.ts`
- Modify: `packages/opencode/script/publish.ts`
- Modify: `packages/cli/src/services/daemon.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/server.ts`
- Modify: `packages/desktop/src/main/sidecar.ts`
- Modify: `packages/desktop/electron-builder.config.ts`
- Test: `packages/opencode/test/cli/uninstall.test.ts`
- Test: `packages/opencode/test/installation.test.ts`
- Create: `packages/cli/test/daemon.test.ts`
- Test: `packages/desktop/electron-builder.config.test.ts`

- [ ] **Step 1: Write failing lifecycle isolation tests**

Assert Graph Vibe dry-run uninstall contains only Graph Vibe roots/package, upgrade never requests OpenCode endpoints, daemon uses Graph Vibe state and starts from `4097`, and desktop IDs differ for every channel.

- [ ] **Step 2: Run package-focused tests and observe RED**

```bash
# packages/opencode
bun test test/cli/uninstall.test.ts test/installation.test.ts
# packages/cli
bun test test/daemon.test.ts
# packages/desktop
bun test electron-builder.config.test.ts
```

- [ ] **Step 3: Implement profile-specific lifecycle**

Make package/release commands depend on `Product.current()`. Graph Vibe operations fail closed until a configured Graph Vibe release endpoint exists; no branch may fall back to `opencode-ai`, Homebrew `opencode`, or `opencode.ai/install`.

- [ ] **Step 4: Verify tests and typechecks**

Run the focused tests and `bun typecheck` in `packages/opencode`, `packages/cli`, and `packages/desktop`.

- [ ] **Step 5: Commit lifecycle isolation**

```bash
git add packages/opencode packages/cli/src/services/daemon.ts packages/cli/test/daemon.test.ts packages/desktop
git commit -m "fix: isolate graph vibe lifecycle"
```

## Task 5: Migration Schemas, Journal, and First-Run Gate

**Files:**
- Create: `packages/schema/src/product-migration.ts`
- Create: `packages/core/src/product-migration/sql.ts`
- Create: `packages/core/src/product-migration/state.ts`
- Create: `packages/core/src/product-migration/service.ts`
- Modify: `packages/core/src/session/session.ts`
- Test: `packages/core/test/product-migration-state.test.ts`
- Test: `packages/core/test/product-migration-gate.test.ts`

- [ ] **Step 1: Write failing lifecycle and gate tests**

Cover legal transitions, exact revision conflicts, per-item retries, fresh-start finalization, permanent completion, and Graph Vibe session admission rejection before finalization. OpenCode must bypass this gate.

```ts
expect(yield* migration.state()).toMatchObject({ status: "draft", revision: 1 })
expect(yield* Session.create(input).pipe(Effect.flip)).toMatchObject({ _tag: "ProductMigrationRequired" })
```

- [ ] **Step 2: Run tests and observe RED**

Run from `packages/core`:

```bash
bun test test/product-migration-state.test.ts test/product-migration-gate.test.ts
```

- [ ] **Step 3: Define schemas and Drizzle tables**

Create `product_migration`, `product_migration_item`, and `product_migration_entity` tables. Store plan selection and bounded errors as validated JSON; never store secret values.

- [ ] **Step 4: Implement state machine and Core gate**

All mutations take `expectedRevision`. `finalize` requires validated status and writes `source_import_completed`. Session admission checks the service only for Graph Vibe.

- [ ] **Step 5: Generate and verify database migration**

Run from `packages/core`:

```bash
bun run migration --generate
bun run migration --check
bun test test/database-migration.test.ts test/product-migration-state.test.ts test/product-migration-gate.test.ts
bun typecheck
```

- [ ] **Step 6: Commit migration foundation**

```bash
git add packages/schema/src/product-migration.ts packages/core
git commit -m "feat(core): add product migration journal"
```

## Task 6: Read-Only OpenCode Source Discovery and Planning

**Files:**
- Create: `packages/core/src/product-migration/source.ts`
- Create: `packages/core/src/product-migration/planner.ts`
- Test: `packages/core/test/product-migration-source.test.ts`
- Test: `packages/core/test/product-migration-planner.test.ts`

- [ ] **Step 1: Write failing read-only source tests**

Build an OpenCode fixture with WAL enabled and a writer transaction. Discover through a read-only SQLite connection, anchor one read transaction, and assert a consistent project/session snapshot and unchanged source database, WAL, config, and credentials.

- [ ] **Step 2: Write failing planning tests**

Cover default configuration selection, credentials selected without exposed values, sessions disabled by default, current-project recent-session defaults, byte estimates, invalid paths, unsupported schema, and plan revision changes.

- [ ] **Step 3: Run tests and observe RED**

```bash
bun test test/product-migration-source.test.ts test/product-migration-planner.test.ts
```

- [ ] **Step 4: Implement read-only source and planner**

Open the source with read-only flags, execute `BEGIN`, anchor the snapshot with the first schema query, and retain the scoped connection only for one execution batch. Reject any source path under Graph Vibe's namespace.

- [ ] **Step 5: Verify tests and typecheck**

```bash
bun test test/product-migration-source.test.ts test/product-migration-planner.test.ts
bun typecheck
```

- [ ] **Step 6: Commit source planning**

```bash
git add packages/core/src/product-migration packages/core/test/product-migration-source.test.ts packages/core/test/product-migration-planner.test.ts
git commit -m "feat(core): plan opencode migration"
```

## Task 7: Configuration and Credential Migration

**Files:**
- Create: `packages/core/src/product-migration/config.ts`
- Test: `packages/core/test/product-migration-config.test.ts`

- [ ] **Step 1: Write failing staged-copy tests**

Cover config/TUI conversion to Graph Vibe names, agents/commands/skills/themes/references/plugins, provider auth, MCP auth, DB credentials, private modes, structural conflicts, invalid absolute paths, no copied package/cache/log directories, interruption, and atomic promotion.

- [ ] **Step 2: Run the test and observe RED**

```bash
bun test test/product-migration-config.test.ts
```

- [ ] **Step 3: Implement staged migration**

Decode source data with existing schemas, redact plan projections, copy secrets only during execution, reinstall declared dependencies in the Graph Vibe config root after promotion, and preserve source bytes.

- [ ] **Step 4: Verify test and typecheck**

```bash
bun test test/product-migration-config.test.ts
bun typecheck
```

- [ ] **Step 5: Commit config migration**

```bash
git add packages/core/src/product-migration/config.ts packages/core/test/product-migration-config.test.ts
git commit -m "feat(core): migrate opencode configuration"
```

## Task 8: Session Relationship Closure Import

**Files:**
- Create: `packages/core/src/product-migration/session.ts`
- Test: `packages/core/test/product-migration-session.test.ts`

- [ ] **Step 1: Write failing session import tests**

Cover project/session selection, entity ID mapping, messages, parts, inputs, todos, referenced tool output, missing attachments, transaction rollback, detached projects, active/pending source sessions becoming `needs_attention`, no one-time permission copy, and no provider/tool replay.

- [ ] **Step 2: Run the test and observe RED**

```bash
bun test test/product-migration-session.test.ts
```

- [ ] **Step 3: Implement relationship closure import**

Read selected rows from the anchored source transaction, allocate target IDs through `product_migration_entity`, rewrite foreign keys in memory, then commit one target transaction per session. Copy only file paths referenced by selected parts after realpath and root validation.

- [ ] **Step 4: Verify test and typecheck**

```bash
bun test test/product-migration-session.test.ts
bun typecheck
```

- [ ] **Step 5: Commit session migration**

```bash
git add packages/core/src/product-migration/session.ts packages/core/test/product-migration-session.test.ts
git commit -m "feat(core): migrate opencode sessions"
```

## Task 9: Mixed Graph Import and Historical Reconstruction

**Files:**
- Create: `packages/core/src/product-migration/graph.ts`
- Modify: `packages/core/src/graph/workflow/plan.ts`
- Test: `packages/core/test/product-migration-graph.test.ts`

- [ ] **Step 1: Write failing mixed-store tests**

Cover known legacy Graph tables, ID remapping, existing evidence preservation, missing-field destination upgrade, unknown Graph schema fallback to transcript reconstruction, deterministic goals/tasks/artifacts/diagnostics, and no verified status from prose alone.

- [ ] **Step 2: Run the test and observe RED**

```bash
bun test test/product-migration-graph.test.ts
```

- [ ] **Step 3: Implement import and deterministic reconstruction**

Prefer valid imported Graph rows. Build missing graph versions from immutable session history and record `source_message_ids`, deterministic/inferred provenance, and confidence. Mark the session `ready` after deterministic reconstruction or `detached` when its project path is absent.

- [ ] **Step 4: Add model enhancement queue contract**

Use the existing model boundary to request structured goal/module/dependency enrichment from copied history only. Persist enhancement as a replaceable graph version; never mutate deterministic status/evidence.

- [ ] **Step 5: Verify Graph tests and typecheck**

```bash
bun test test/product-migration-graph.test.ts test/graph-plan.test.ts
bun typecheck
```

- [ ] **Step 6: Commit Graph reconstruction**

```bash
git add packages/core/src/product-migration/graph.ts packages/core/src/graph/workflow/plan.ts packages/core/test
git commit -m "feat(core): rebuild imported session graphs"
```

## Task 10: Migration HttpApi and Generated SDK

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/product-migration.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/product-migration.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- Test: `packages/opencode/test/server/product-migration-api.test.ts`
- Generated: `packages/sdk/js/src/v2/gen/**`
- Test: `packages/sdk/js/test/product-migration.test.ts`

- [ ] **Step 1: Write failing revision and redaction API tests**

Cover discover, draft update, execute, pause, retry, validate, finalize, fresh start, stale revision, bounded errors, no secret values, and endpoint rejection for OpenCode profile.

- [ ] **Step 2: Run API tests and observe RED**

```bash
bun test test/server/product-migration-api.test.ts
```

- [ ] **Step 3: Implement typed HttpApi and handlers**

Bind the product migration service once. Return typed conflict, unsupported-source, insufficient-space, validation, and finalized errors. Publish a migration-updated event after every successful mutation.

- [ ] **Step 4: Regenerate SDK and add contract tests**

Run from `packages/sdk/js`:

```bash
./script/build.ts
bun test test/product-migration.test.ts
bun typecheck
```

Run the generator a second time and verify no tracked diff changes.

- [ ] **Step 5: Verify OpenCode API tests and typecheck**

```bash
bun test test/server/product-migration-api.test.ts
bun typecheck
```

- [ ] **Step 6: Commit API and SDK**

```bash
git add packages/opencode/src/server packages/opencode/test/server/product-migration-api.test.ts packages/sdk/js
git commit -m "feat(opencode): expose product migration api"
```

## Task 11: TUI and Web First-Run Migration Experience

**Files:**
- Create: `packages/tui/src/component/dialog-product-migration.tsx`
- Modify: `packages/tui/src/app.tsx`
- Test: `packages/tui/test/product-migration.test.tsx`
- Create: `packages/app/src/pages/product-migration.tsx`
- Create: `packages/app/src/pages/product-migration.test.ts`
- Modify: `packages/app/src/app.tsx`
- Modify: `packages/app/src/context/server-sync.tsx`
- Test: `packages/app/test-browser/product-migration.test.ts`
- Create: `packages/app/e2e/regression/product-migration.spec.ts`

- [ ] **Step 1: Write failing TUI first-run tests**

Assert Graph Vibe opens migration before normal routing, configuration and credentials default selected, sessions require explicit enablement, project/session selection shows size, pause/resume works, stale revisions refresh, and finalize unlocks the TUI. OpenCode must skip the wizard.

- [ ] **Step 2: Write failing App browser tests**

Render discovery, selection, dry-run failure, progress, paused, failed-item, validation, ready-to-finalize, fresh-start, and completed states. Assert secrets never render and main navigation remains gated.

- [ ] **Step 3: Run tests and observe RED**

```bash
# packages/tui
bun test test/product-migration.test.tsx
# packages/app
bun test src/pages/product-migration.test.ts
bun run test:browser -- test-browser/product-migration.test.ts
```

- [ ] **Step 4: Implement the TUI wizard**

Use the SDK projection as the only state authority. Keep focus, keyboard navigation, terminal resize, and screen-reader labels consistent with existing dialogs. Require an explicit final confirmation.

- [ ] **Step 5: Implement responsive Web onboarding**

Use a project/session master-detail selector on desktop and step-based panels on mobile. Use semantic progress bars, checkboxes, status regions, conflict dialogs, and 44px touch targets.

- [ ] **Step 6: Add source and embedded E2E**

Cover fresh start and a fixture migration through finalization on both routes. Assert normal session creation is blocked before and enabled after finalization.

- [ ] **Step 7: Verify TUI and App**

Run from each package:

```bash
bun test
bun typecheck
```

Also run App browser tests, production build, E2E typecheck, and focused Playwright migration spec.

- [ ] **Step 8: Commit onboarding**

```bash
git add packages/tui packages/app
git commit -m "feat(app): add opencode migration onboarding"
```

## Task 12: End-to-End Isolation, Migration, and Release Verification

**Files:**
- Create: `packages/opencode/test/integration/product-isolation.test.ts`
- Create: `packages/opencode/test/integration/product-migration.test.ts`
- Modify: `docs/superpowers/reports/2026-07-10-graph-collaboration-ux.md`
- Modify: product installation documentation selected during implementation

- [ ] **Step 1: Add dual-process isolation test**

Launch OpenCode and Graph Vibe with the same synthetic home and assert distinct DB/WAL, config, state, daemon, cache, log, tmp, and plugin paths. Mutate each product and compare directory manifests to prove no cross-write.

- [ ] **Step 2: Add complete migration fixture test**

Create an active-WAL OpenCode fixture containing config, credentials, MCP OAuth, normal sessions, an active session, detached project, referenced output, corrupt session, and mixed Graph tables. Execute onboarding through finalization and assert all acceptance criteria.

- [ ] **Step 3: Run package verification matrix**

Run focused and full tests plus `bun typecheck` from `packages/schema`, `packages/core`, `packages/opencode`, `packages/cli`, `packages/tui`, `packages/session-ui`, `packages/app`, `packages/desktop`, and `packages/sdk/js`. Run migration check, SDK determinism, App production build, browser tests, and Playwright source/embedded tests.

- [ ] **Step 4: Run live dry-run against the current mixed store**

Use a Graph Vibe temporary destination and the real OpenCode source in discovery/dry-run mode only. Verify the report detects the approximately 2.8 GB source, selected config categories, existing Graph sessions, required space, and source immutability. Do not finalize or write the user's permanent Graph Vibe directory during verification.

- [ ] **Step 5: Review upgrade and uninstall manifests**

Run both products' dry-run lifecycle commands and assert Graph Vibe output contains no OpenCode path, package, formula, app ID, or release endpoint.

- [ ] **Step 6: Complete spec and quality reviews**

Run independent specification and code-quality review. Fix every Critical and Important finding and rerun affected verification.

- [ ] **Step 7: Commit final verification and documentation**

```bash
git add packages/opencode/test/integration docs
git commit -m "test: verify graph vibe product isolation"
```
