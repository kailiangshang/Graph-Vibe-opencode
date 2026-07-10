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
- Maximum total agents: 4
- Planned: 1 frontend explorer, 1 workflow explorer, 1 specification reviewer, 1 code-quality reviewer
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
