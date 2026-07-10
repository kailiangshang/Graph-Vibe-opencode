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
- Planned agents: 2 explorers, 1 implementation reviewer, 1 optional fixer/reviewer replacement
- Read-heavy exploration may run in parallel.
- Write-heavy implementation runs serially under the controller.
- Recursive dispatch is prohibited.

## Agent Ledger

| Handle | Role | Scope | Status | Final reason |
| --- | --- | --- | --- | --- |
| `ses_0b4f8076effeODvhpdAs9i8Pjh` | explorer | CLI identity, TUI commands, tests | closed | Findings persisted and consumed. |
| `ses_0b4f8073effe9LFZxUAL6MVUaq` | explorer | Web source/release delivery and tests | closed | Findings persisted and consumed. |

## Status

Implementation plan complete and self-reviewed. Preparing isolated execution worktree.

## Files Changed

- `docs/superpowers/specs/2026-07-10-graph-first-product-experience-design.md`
- `docs/superpowers/reports/2026-07-10-graph-first-product-experience.md`
- `docs/superpowers/reports/2026-07-10-graph-first-cli-tui-explorer.md`
- `docs/superpowers/reports/2026-07-10-graph-first-web-explorer.md`
- `docs/superpowers/plans/2026-07-10-graph-first-product-experience.md`

## Commits

- `1968e71c3 docs: define graph-first product experience`

## Tests Run

None for this implementation phase yet.

## Known Risks

- TUI components use Solid/OpenTUI conventions that must be followed rather than introducing React patterns.
- Source and packaged Web launch paths differ and need independent tests.
- Existing uncommitted `scripts/graph-vibe` symlink/cwd fix must be preserved and integrated deliberately.

## Degraded Mode

None. The cached harness binary and skill are available.

## Final Audit

Pending.
