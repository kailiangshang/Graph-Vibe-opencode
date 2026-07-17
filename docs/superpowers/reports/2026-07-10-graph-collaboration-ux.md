# Graph Collaboration UX Report

## PSOC

### Problem

The Graph page does not keep the task list, current task, graph selection, details, and actions in a stable visual hierarchy. Graph-mode conversations expose internal tool names, do not reliably list work before execution, and can interpret "step by step" as permission to run every task without a user-visible checkpoint.

### Scenarios

- A user sees the complete task list and the currently executing task before the first code change.
- A user selects an execution cadence after planning and may change it while work is running.
- Task-list selection, graph-node selection, and the details inspector remain synchronized.
- A user can understand progress without learning internal Graph tool names.
- Verification reflects task-specific evidence rather than repeating an unrelated passing test command.
- A desktop user gets a three-pane workflow cockpit; a mobile user gets equivalent task, graph, and detail tabs.

### Options

1. Restyle the current Graph page only. Rejected because conversation behavior remains unchanged.
2. Restyle the page and rely on prompt instructions for collaboration. Rejected because model compliance is not a durable workflow boundary.
3. Build a restrained liquid-glass workflow cockpit and add structured, state-backed execution cadence and checkpoints shared by UI and conversation.

### Chosen Plan

Use option 3. Keep the existing Graph data model and compatibility boundaries where possible. Add the smallest durable workflow state needed to represent execution mode and checkpoints, enforce it at Graph build admission, and make both Graph UI and agent instructions consume the same task/current-state vocabulary.

## Agent Budget

- Maximum concurrent agents: 2
- Maximum total agents: 8
- Planned: 2 explorers, 4 serial implementation workers, 1 specification reviewer, 1 code-quality reviewer
- Explorers and reviewers are read-only; implementation remains controller-owned and serial.
- Recursive dispatch is prohibited.

## Agent Ledger

| Handle | Role | Scope | Status | Final reason |
| --- | --- | --- | --- | --- |
| `ses_0b3d4df57ffeV2ezRAggzAwDDM` | explorer | Graph page layout, design-system constraints, tests | closed | Findings consumed into the design. |
| `ses_0b3d4df02ffeqJszZh5SKISxDx` | explorer | Graph prompt, durable state, gates, conversation tests | closed | Findings consumed into the design. |

## Status

Design discovery complete. Specification drafting in progress.

## Files Changed

- `docs/superpowers/reports/2026-07-10-graph-collaboration-ux.md`

## Commits

None yet.

## Tests Run

Dogfood evidence: the current `game-2048` suite passes 14 logic tests, but those tests do not cover the newly added history, storage, AI, theme, animation, or UI behavior.

## Known Risks

- Workflow checkpoint persistence may affect Graph protocol or schema generation boundaries.
- Liquid-glass styling must preserve contrast, click targets, reduced-motion behavior, and mobile usability.
- Prompt-only interaction tests cannot prove every provider follows instructions; durable gate behavior needs implementation-level tests.

## Degraded Mode

None.

## Final Audit

Pending.

## Storage Migration Release Verification

### Status

Graph Vibe storage isolation and first-run OpenCode migration Tasks 7-12 completed on 2026-07-17. Independent specification and code-quality reviews approved the final implementation after all Critical and Important findings were closed.

### Architecture Evidence

- SQLite discovery uses a read-only, file-backed `VACUUM INTO` online snapshot instead of copying live DB/WAL files. Snapshot generation is bounded to 16 GiB, uses private temporary directories, streams its digest, and detects same-batch commits and source replacement.
- Reference discovery keyset-pages raw session history with bounded page memory, scan rows/bytes, retained reference count, and retained path bytes. The approximately 2.9 GB live store completes discovery without materializing all payloads.
- Configuration migration excludes disposable `target`, `dist`, `build`, and `coverage` trees while retaining skill source, runtime scripts, and executable modes. Disposable target symlinks are rejected before dependency installation.
- Session relationships import selected ancestors before children. Reconstructed Graph mapping IDs are bounded, deterministic, and session-qualified. Model-enhancement requests are queued by default with conservative secret redaction and retain only destination-owned identity after finalization.
- Session, Graph, permission, and PTY mutations are gated before writes or process forks until Graph Vibe migration completion. OpenCode bypasses the product gate.
- Graph Vibe npm artifacts use only `graph-vibe-*` platform packages. Port `4097`, `graph-vibe.local`, package lifecycle, mDNS ownership, upgrade errors, and uninstall failures are product-specific.

### Live Dry Run

Discovery ran against the real mixed OpenCode store with every Graph Vibe destination path redirected below `/tmp/opencode/task12-release.SqzHDy`. It invoked discovery only; it did not execute or finalize migration and did not write permanent Graph Vibe roots.

This live check proves source immutability for discovery and preflight against the real store. The complete execute, validate, and finalize path is covered separately by `packages/opencode/test/integration/product-migration.test.ts`, whose active-WAL fixture includes config, credentials, MCP OAuth, normal/active/detached/corrupt sessions, referenced output, and mixed Graph rows and compares the complete source manifest before and after finalization.

| Check | Result |
| --- | --- |
| Lifecycle | `draft`, revision `1`, `canFinalize: false` |
| Logical SQLite snapshot | `2,904,350,720` bytes |
| Source sessions | `299` |
| Existing Graph sessions | `2` sessions containing at least one `graph_node` row |
| Default session migration | disabled, `0` effectively selected |
| Selected categories | config (`2,673,084` bytes) and credentials (`2,871` bytes) |
| Execution preflight | `2,675,955` selected bytes + `2,904,350,720` snapshot bytes = `2,907,026,675` required |
| Available space | `940,417,789,952` bytes on the filesystem containing the temporary Graph Vibe data root |
| Source content manifest | before/after digest `549b9c86e94116e8143f2f6526856b8c19e6652a6a8133de6c95426717e1315a` |
| Source identity manifest | before/after digest `746e934e680d79824d72c6e550fb89fa1325b7b5cdb222b1be4e9d325ac766e5` |
| Redacted discovery report | digest `49c360ec2cd09c646090fcedcf3f989cdf0edd6dd24282acde328f2351f70bb9` |

The source content manifest is a sorted list of `opencode.db`, `opencode.db-wal`, `auth.json`, and `opencode.json` plus each file's SHA-256; the table records the SHA-256 of that manifest. The source identity manifest is a sorted list of those paths plus size, mode, inode, mtime, and ctime; its independent digest is recorded above. The redacted discovery-report digest covers the JSON summary used for the table and intentionally contains no credential values. All compared values were identical before and after. SQLite SHM is treated as a reader-managed coordination file and is not used as durable source content.

Source identity is defined by migration-relevant consistent snapshot content. SQLite cannot expose a read-only, restart-stable transaction epoch that both ignores checkpoint layout changes and detects a transaction restoring identical final content. Accepting identical logical content is safe because migration outputs are unchanged; same-batch mutations remain conservatively rejected through `data_version` and inode checks.

The persisted `source fingerprint` is a separate versioned SHA-256 over canonical database path, online-snapshot size and SHA-256, session count, accepted config/auth/MCP/dependency inventory, and referenced-file identity estimates. It controls retry and execution admission. The content and identity manifest digests above are release-audit evidence only and are not used by runtime admission.

### Lifecycle Manifests

- Graph Vibe npm manifest contains only `graph-vibe-*` optional dependencies.
- `graph-vibe uninstall --dry-run --force` lists only Graph Vibe data, cache, config, state, and the `graph-vibe` package.
- OpenCode dry-run lists only OpenCode roots and `opencode-ai`.
- `graph-vibe upgrade` reports its unconfigured release channel, performs no OpenCode fallback, and exits with status `1`.

### Verification Matrix

The worktree was based on `5a5afde327420f70d847530b5d263cb47141c6c1`; Tasks 7-12 remained uncommitted during verification. Primary commands were:

```bash
(cd packages/core && bun test)
(cd packages/opencode && bun test)
(cd packages/core && bun test test/product-migration-*.test.ts)
(cd packages/opencode && bun test test/integration/product-migration.test.ts test/server/httpapi-public-openapi.test.ts test/server/graph-api.test.ts test/cli/uninstall-product.test.ts test/cli/upgrade-product.test.ts test/cli/package-manifest.test.ts test/cli/package-artifacts.test.ts)
(cd packages/core && bun typecheck && bun run migration --check)
(cd packages/opencode && bun typecheck)
(cd packages/app && bun typecheck && bun run build)
./packages/sdk/js/script/build.ts
git diff --check
```

- Core full: `1449 pass`, `0 fail` across 174 files.
- OpenCode full before the final review fixes: `3270 pass`, `22 skip`, `1 todo`, `0 fail` across 269 files.
- OpenCode final full: `3292 pass`, `22 skip`, `1 todo`, `0 fail` across 3315 tests and 270 files (`502.30s`).
- Latest focused migration, Graph, gate, permission, PTY, network, packaging, lifecycle, generated-client, and review regressions all passed. Final Core migration coverage passed `130/130`; final lifecycle review passed `72/72`.
- Schema full `19/19`, TUI `239/239` with one skip, Session UI `65/65`, SDK `8/8`, and Desktop `64/64` passed during the package matrix.
- App migration unit/browser/Playwright coverage passed, including Playwright `6/6`; production build and latest App typecheck passed. The unrelated Arabic locale completeness test still reports three pre-existing missing reveal labels.
- Core, Protocol, Server, OpenCode, Client, SDK, and App typechecks passed after final public API generation.
- Client and legacy SDK second-run generation hashes were deterministic.
- `bun run migration --check` and `git diff --check` passed.

Independent review records are retained by agent session handle: snapshot spec/quality `ses_095e86659ffe4oRudsqUhgQuXb` / `ses_095de118effeYDtqv3yshYjfby`; packaging `ses_095bd4bc7ffeK1WWLDLuOY3y0O` / `ses_095ba25ffffet4EWi3yMj69Mh0`; Graph migration `ses_091f1f7f2ffe8E2plUvWyViDTM` / `ses_091ede52fffe1DFUnbm5cbbCL3`; permission/PTY gates `ses_091b84fc7ffeXAOAL0fzB5egfm` / `ses_091b3a125ffexU9kGwOQzt4BGL`; lifecycle `ses_091a3b4eefferU5qEDc8FBFZKu` / `ses_091a1a9e0ffe3TEx58zl9eQK3m`; final blocker closure `ses_0916e4934ffe3nLTu9PgsbwsGY`.

### Final Audit

No unresolved migration release blocker remains. No commit or publication was performed. Graph Vibe's upgrade release channel intentionally remains disabled until release infrastructure is configured.

Known limits are explicit: snapshots above 16 GiB fail closed; Graph Vibe packages were prepared and tested but not published; the upgrade release channel remains disabled; Windows-specific package branches were type-checked and fixture-covered but not executed on this Linux host; and the unrelated Arabic locale completeness test still has three missing labels. Interrupted migration resumes from committed journal items when the source fingerprint still matches, while fresh start is restricted to a pristine draft.
