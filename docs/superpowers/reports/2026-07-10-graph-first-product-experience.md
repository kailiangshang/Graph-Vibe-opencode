# Graph-First Product Experience Report

## PSOC

### Problem

Graph Workflow exists in runtime behavior but is hidden behind OpenCode-oriented CLI/TUI presentation, while source-mode `graph-vibe web` may serve upstream UI without Graph Vibe routes.

### Scenarios

- A new user runs `graph-vibe -h` and sees Graph Vibe commands and examples.
- A new user opens the TUI and immediately understands Plan, Build, and Verify.
- A user starts and inspects graph work through stable slash commands without learning internal tool names.
- A source developer runs `graph-vibe web` and receives the local Graph Vibe Web UI and backend.
- A packaged Graph Vibe server with missing embedded assets fails explicitly instead of proxying upstream UI.
- A normal OpenCode launch retains its current identity and Web fallback behavior.

### Options

1. Replace OpenCode naming globally. Rejected because it would break package/protocol compatibility and increase upstream merge cost.
2. Patch each visible string independently. Rejected because identity would continue to drift across CLI, TUI, and Web.
3. Add a centralized user-facing product identity selected by the launcher, then make Graph-specific TUI and Web behavior depend on that identity and the existing Graph flag.

### Chosen Plan

Use option 3. Preserve internal OpenCode-compatible names, add Graph Vibe identity at user-facing boundaries, expose graph onboarding and commands in TUI, and make Graph Vibe Web use local assets with explicit failure instead of upstream fallback.

## Agent Budget

- Maximum concurrent agents: 2
- Maximum total agents: 4
- Used agents: 2 explorers, 1 specification reviewer, 1 code-quality reviewer
- Read-heavy exploration may run in parallel.
- Write-heavy implementation runs serially under the controller.
- Recursive dispatch is prohibited.

## Agent Ledger

| Handle | Role | Scope | Status | Final reason |
| --- | --- | --- | --- | --- |
| `ses_0b4f8076effeODvhpdAs9i8Pjh` | explorer | CLI identity, TUI commands, tests | closed | Findings persisted and consumed. |
| `ses_0b4f8073effe9LFZxUAL6MVUaq` | explorer | Web source/release delivery and tests | closed | Findings persisted and consumed. |
| `ses_0b4b887c1ffe162Wa7tFNpXcx5` | specification reviewer | Graph-first product behavior and plan compliance | closed | Re-review found no Critical or Important product-code findings. |
| `ses_0b49ec050ffeFZGCCXxFc7pLsu` | code-quality reviewer | Networking, lifecycle, security, portability, regression risk | closed | Re-review found no Critical or Important findings; one Minor availability-marker limitation remains. |

## Status

Implementation, review loops, fresh verification, builds, and live Web smokes are complete on `graph-first-product` at `f232fd874`.

## Files Changed

- Product identity: `packages/core/src/product.ts`, CLI entrypoints, command descriptions, errors, logos, and launch wrappers.
- Source Web: `packages/opencode/src/cli/cmd/web-source.ts`, `web.ts`, private readiness route, local-network CORS policy, and browser backend URL resolution.
- Packaged Web: embedded asset fallback policy and Graph Vibe 503 diagnostics.
- TUI: Graph-first home, guide/status dialogs, slash commands, help/status presentation, authenticated Web availability checks, and product-aware errors.
- App: Graph beginner guidance, Graph route helpers, and wildcard source backend URL resolution.
- Packaging: `packages/opencode/bin/graph-vibe.cjs`, package metadata, publish script, and root package bin mapping.
- Documentation and tests: `docs/graph-mode.md` plus focused Core, OpenCode, TUI, and App tests.

## Commits

- `1968e71c3 docs: define graph-first product experience`
- `81cf2e96c fix: make graph-vibe launcher symlink-safe`
- `7ae33244e docs: plan graph-first product implementation`
- `c9fdc8a50 feat: add graph vibe product identity`
- `aacaa125e feat(opencode): present graph vibe CLI identity`
- `023e9eedb fix(opencode): prevent graph vibe web fallback`
- `0f823fd1a feat(opencode): launch local graph vibe web`
- `6ef68c100 feat(tui): add graph workflow helpers`
- `8957c91ea feat(tui): add graph-first workflow experience`
- `aba0a7b62 feat(opencode): publish graph vibe launcher`
- `2154f7732 fix: address graph-first product review`
- `375c85be5 fix(tui): harden graph web routing`
- `f232fd874 fix(opencode): harden source web networking`

## Tests Run

- Core: `bun test test/product.test.ts` - 4 passed; `bun typecheck` passed.
- TUI: Graph workflow, Graph app integration, lifecycle, presentation, and renderer suites - 17 passed; `bun typecheck` passed.
- OpenCode: product help/snapshots, CLI errors, embedded UI, source Web, serve process, and launcher suites - 42 passed with 34 snapshots; `bun typecheck` passed.
- App: Graph helpers, session routes, and source backend URL suites - 18 passed; `bun typecheck` passed.
- Server: `bun typecheck` passed.
- Fresh focused total: 81 tests passed, 0 failed.

## Builds And Smokes

- `packages/app`: `bun run build` passed; Vite reported only the existing large-chunk warning.
- `packages/opencode`: `bun run script/build.ts --single --skip-install` passed and produced `dist/opencode-linux-x64/bin/opencode`.
- Native build smoke passed with version `0.0.0-graph-first-product-202607101021`.
- Source Web live smoke passed on backend `45196` and Vite `45444`: backend health 200, direct Graph SPA route 200, local `/src/entry.tsx` confirmed, and both ports closed after SIGTERM.
- Embedded Web live smoke passed on `42960`: Graph Vibe and OpenCode help identities, backend health 200, root 200, direct Graph SPA route 200, production embedded assets confirmed, and the port closed after SIGTERM.
- A fresh tmux TUI process remained healthy, but OpenTUI's alternate-screen output was blank to `tmux capture-pane`; this attempt is not counted as visual verification. The prior interactive dogfood remains historical evidence, while the fresh TUI evidence is the 17-test integration/lifecycle suite.

## Known Risks

- `/graph-open` currently treats any 2xx response from the configured Web root as available. An unrelated service on that exact port can therefore produce a false-positive open; reviewers classified this as Minor.
- Automatic source-Web CORS covers localhost, private/link-local IPv4, ULA/link-local IPv6, and the configured mDNS hostname. A public routed hostname requires an explicit `--cors` value.
- Production App builds retain the existing large-chunk warning; no new build failure or runtime failure was observed.

## Degraded Mode

None. The cached harness was available throughout and its final ledger audit passed.

## Final Audit

- Specification review: no Critical or Important findings remain.
- Code-quality review: no Critical or Important findings remain.
- Cached agent ledger: final audit passed with all 4 agent rows closed.
- Fresh tests: 81 passed, 0 failed.
- Fresh typechecks: Core, TUI, OpenCode, App, and Server passed.
- Fresh builds: App production and native single-target builds passed.
- Fresh source and embedded Web live smokes passed with shutdown verification.
