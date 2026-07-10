# Graph UI Bootstrap Report

## PSOC

Problem: graph workflow backend and graph route exist, but users need a visible UI entry to open the graph for the current session and validate the self-bootstrap loop.

Scenarios:
- A user in an active session can open that session's graph view without hand-editing the URL.
- The graph route keeps using the existing Current Plan/Main graph APIs.
- Focused tests and typecheck validate the route/helper/UI entry change.

Options:
- Add a per-session sidebar graph action.
- Add a current-session graph action near the session page actions.
- Add both actions after the first slice proves useful.

Chosen Plan: Add the smallest current-session graph entry first, with a route helper and focused test coverage. Do not redesign the graph canvas in this slice.

## Agent Budget

- Max concurrent agents: 2
- Max total agents: 5
- Read-heavy roles may run in parallel; write roles stay serial.

## Agent Ledger

| Handle | Role | Status | Write Scope | Report | Final Reason |
| --- | --- | --- | --- | --- | --- |
| ui-entry-explorer | explorer | closed | read-only | Reported `session-header.tsx` as the smallest current-session insertion point and `session-route.test.ts` as focused helper coverage. | completed |
| ui-entry-reviewer | reviewer | closed | read-only | Found 2 Important issues: GraphPage encoded-directory API calls and server-scoped route loss. Both fixed. | completed |

## Status

Implemented and verified.

## Files Changed

- `packages/app/src/utils/session-route.ts` — added `legacySessionGraphHref` + `sessionGraphHref`
- `packages/app/src/utils/session-route.test.ts` — focused tests for both graph href helpers
- `packages/app/src/components/session/session-header.tsx` — Graph action in legacy + V2 header, server-scoped aware
- `packages/app/src/pages/graph.tsx` — fixed encoded-directory bug: API calls now use `sdk().directory`
- `packages/app/src/app.tsx` — added `/server/:serverKey/session/:id/graph` route with `TargetGraphRoute`
- `docs/superpowers/reports/2026-07-10-graph-ui-bootstrap.md`

## Tests Run

- `packages/app`: `bun test src/utils/session-route.test.ts` — 9 pass, 0 fail
- `packages/app`: `bun typecheck` — passed

## Known Risks

- `TargetGraphRouteContent` duplicates session-lineage resolution from `ResolvedTargetSessionRoute`; future refactor could extract shared provider tree.
- Graph icon uses `branch` as closest available; a dedicated graph/network icon would be better.

## Degraded Mode

None.

## Final Audit

- Focused tests pass (9/9).
- App typecheck passes (exit 0).
- Reviewer findings addressed and fixed.
- Route helper RED→GREEN cycle completed for both `legacySessionGraphHref` and `sessionGraphHref`.
