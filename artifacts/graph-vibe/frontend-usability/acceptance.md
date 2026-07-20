# Graph Vibe Frontend Usability Acceptance

Date: 2026-07-20

Refreshed: 2026-07-20T10:52:09+08:00

Result: PASS WITH KNOWN CAVEAT

Repository paths are written as `<repo>` or relative paths. The temporary server password and browser auth token were never printed, logged, or written to this report.

## Authenticated Isolated Non-loopback Acceptance

The accepted instance used the documented source-checkout entrypoint from the repository root. Product flags were not injected manually; `bun run graph-vibe` invoked `./scripts/graph-vibe`, which selected Graph Vibe identity and source mode.

This acceptance ran only in an isolated local environment. It proves Basic authentication enforcement and authenticated browser functionality; it does not prove TLS, transport encryption, or confidentiality. Basic auth over plain HTTP leaves credentials and application traffic unencrypted and is not suitable for an untrusted LAN or remote network.

| Field             | Value                         |
| ----------------- | ----------------------------- |
| tmux session      | `gv-final-recapture-4733`     |
| tmux pane PID     | `1028701`                     |
| backend           | `0.0.0.0:4733`, PID `1028778` |
| UI                | `0.0.0.0:4734`, PID `1028811` |
| isolated root     | `<isolated-root>`             |
| initial directory | `<repo>`                      |

Ports `4733` and `4734`, the root, and the tmux session name were unused before launch. The temporary password was generated as 48 random bytes, base64 encoded, stored with mode `0600`, and removed with the isolated root after acceptance.

Credential-redacted reproduction commands:

```bash
repo="$(git rev-parse --show-toplevel)"
root="<isolated-root>"
mkdir -p "$root"/{home,data,config,state,cache,tmp}
openssl rand -base64 -out "$root/server-password" 48
chmod 600 "$root/server-password"
tmux new-session -d -s gv-final-recapture-4733 "env HOME=\"$root/home\" XDG_DATA_HOME=\"$root/data\" XDG_CONFIG_HOME=\"$root/config\" XDG_STATE_HOME=\"$root/state\" XDG_CACHE_HOME=\"$root/cache\" TMPDIR=\"$root/tmp\" TMP=\"$root/tmp\" TEMP=\"$root/tmp\" OPENCODE_SERVER_PASSWORD=\"\$(tr -d '\n' < \"$root/server-password\")\" OPENCODE_GRAPH_VIBE_UI_PORT=4734 OPENCODE_GRAPH_VIBE_NO_OPEN=1 OPENCODE_DISABLE_CHANNEL_DB=1 bun run graph-vibe web --hostname 0.0.0.0 --port 4733 --no-mdns --print-logs"
```

The tmux pane showed the source launcher command:

```text
$ ./scripts/graph-vibe web --hostname "0.0.0.0" --port "4733" --no-mdns --print-logs
Graph Vibe server listening on http://0.0.0.0:4733
VITE ready
Graph Vibe
Graph-guided development
Powered by OpenCode
```

Readiness used authenticated condition polling for the backend and unauthenticated UI asset readiness. No fixed startup delay was used.

## Authentication Evidence

The server middleware supports Basic authentication through `OPENCODE_SERVER_PASSWORD`. The Web app's supported startup flow consumes an `auth_token` query, creates an authenticated server connection, and immediately removes the token from the visible URL. Before navigation, the live spec registers an init script that temporarily inserts the in-memory token into browser history before application scripts execute. `page.goto(...)` receives only the sanitized project URL, and the test verifies that application startup removes `auth_token` from `page.url()`. These results demonstrate authentication only: the accepted URLs used plain HTTP on an isolated local environment, so neither credentials nor traffic had transport confidentiality.

Direct health probes use native `fetch`, not Playwright's request fixture. The helper returns only the numeric status and replaces transport failures with a credential-free error:

```json
{
  "unauthenticatedStatus": 401,
  "authenticatedStatus": 200
}
```

Browser evidence:

```text
unauthenticatedHealthStatus: 401
authenticatedHealthStatus: 200
backendBrowserRequests: 62
auth_token present after startup navigation: false
reload health status: 200
reload product migration status: 200
auth_token present after reload: false
```

## Discovered Live Spec

Executable spec: `packages/app/e2e/live/graph-vibe-live-acceptance.spec.ts`.

It is discovered by normal Playwright test matching and skips unless all explicit `GRAPH_VIBE_LIVE_*` inputs are present.

Discovery command and result from `packages/app`:

```bash
bunx playwright test --list e2e/live/graph-vibe-live-acceptance.spec.ts --project chromium
```

```text
[chromium] › live/graph-vibe-live-acceptance.spec.ts › authenticated isolated non-loopback Graph Vibe workflow
Total: 1 test in 1 file
```

Exact credential-redacted execution command from `packages/app`:

```bash
GRAPH_VIBE_LIVE_UI_URL=http://127.0.0.1:4734 \
GRAPH_VIBE_LIVE_BACKEND_URL=http://127.0.0.1:4733 \
GRAPH_VIBE_LIVE_DIRECTORY="<repo>" \
GRAPH_VIBE_LIVE_PASSWORD="$(tr -d '\n' < "<isolated-root>/server-password")" \
GRAPH_VIBE_LIVE_ARTIFACTS="<repo>/artifacts/graph-vibe/frontend-usability" \
PLAYWRIGHT_PORT=4734 \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4734 \
PLAYWRIGHT_SERVER_PORT=4733 \
PLAYWRIGHT_WORKERS=1 \
bunx playwright test e2e/live/graph-vibe-live-acceptance.spec.ts --project chromium --reporter=line
```

Initial result: `1 passed (9.4s)`.

Authenticated reload regression recheck against a fresh isolated public launcher: `1 passed (11.9s)`. The browser made 62 backend requests; both `GET /global/health` and `GET /global/product-migration` were observed twice, including HTTP 200 responses after reload.

The spec attaches `console`, `pageerror`, and backend request listeners before browser navigation. It counts method plus path only and never reads or records headers, credentials, query strings, or request bodies. After startup sanitizes the URL, the spec reloads the document, requires HTTP 200 from health and migration discovery, and verifies `auth_token` remains absent. The file explicitly sets `retries: 0`, `trace: "off"`, `video: "off"`, and automatic `screenshot: "off"`; the command explicitly selects the line reporter instead of the configured HTML reporter. Explicit curated screenshots remain enabled.

After each live run, no trace, video, or automatic screenshot files existed. `packages/app/e2e/test-results` contained only `.last-run.json`, with `status: "passed"` and an empty `failedTests` array. The existing `packages/app/e2e/playwright-report/index.html`, repository acceptance artifacts, and staged comparison screenshots were included as applicable even though each run explicitly selected the line reporter. A binary-safe scan after the reload recheck checked the worktree for the raw password, base64 startup token, and complete Basic Authorization value. Each scan returned `0` matching files. Only these zero counts were recorded.

Traversal checkpoints:

1. Rejected unauthenticated backend health with HTTP 401.
2. Accepted authenticated health with HTTP 200; product identity was verified through the rendered UI.
3. Bootstrapped browser credentials through the supported `auth_token` flow without putting the token in `page.goto(...)`, then verified the token was removed from the URL.
4. Reloaded after token removal, observed authenticated HTTP 200 health and migration discovery, and verified the token remained absent from the URL.
5. Completed fresh start with status `completed`.
6. Dismissed `Introducing Tabs` through its visible dismissal control.
7. Added and selected `<repo>` from Home.
8. Verified title, Graph Vibe lockup, capability, selected project, and `Start Graph Workflow` at desktop and mobile widths.
9. Verified empty Graph, `No plan admitted`, and `Describe a goal`.
10. Clicked `Describe a goal`, returned to the same session composer, and measured zero mobile help/submit overlap.

Observed POST list:

```text
POST /global/product-migration/fresh-start
POST /session
```

Execution and error counters:

```json
{
  "messagePromptPost": 0,
  "promptAsyncPost": 0,
  "v2PromptPost": 0,
  "modelPost": 0,
  "providerPost": 0,
  "consoleErrors": 0,
  "pageErrors": 0,
  "mobileInteractiveOverlap": 0
}
```

Backend method/path counters are below. Volatile identifiers are normalized to `:id`; methods, paths, and counts are otherwise unchanged.

```text
GET /agent                                            2
GET /api/reference                                    3
GET /command                                          2
GET /config                                           1
GET /experimental/resource                            2
GET /file                                             7
GET /find/file                                        1
GET /global/config                                    2
GET /global/event                                     2
GET /global/health                                    2
GET /global/product-migration                         2
GET /graph/current-plan                               1
GET /graph/workflow                                   4
GET /lsp                                              2
GET /mcp                                              2
GET /path                                             4
GET /permission                                       1
GET /project                                          2
GET /provider                                         6
GET /question                                         1
GET /session                                          3
GET /session/:id                                      4
GET /session/:id/message                              1
GET /session/status                                   1
GET /vcs                                              1
PATCH /project/:id                                    1
POST /global/product-migration/fresh-start             1
POST /session                                          1
```

## Mobile Collision Regression

DOM ownership trace:

- `HelpButton` owns the fixed `bottom-5 right-5` global link.
- `SessionComposerRegion` owns the mobile composer width and padding.
- `PromptInput` owns the bottom-right `[data-action="prompt-submit"]` control.

The new standard E2E assertion at 390x844 computes the intersection area of the help and submit bounding boxes.

```text
RED before fix: 361 px² overlap
GREEN after fix: 0 px² overlap
```

The smallest fix reserves the global help gutter on mobile with `pl-3 pr-12`, while `sm:px-3` preserves desktop layout.

## Concurrent Product-Isolation Topology

No arbitrary HTTP listeners were added.

The health identity test creates both `Bun.spawn` children in one array before awaiting either process. Each child receives a distinct isolated home/XDG subtree and makes its real `Default().app.request("/global/health")` request inside that process. The parent then awaits both with `Promise.all`. The OpenCode and Graph Vibe health children are therefore concurrent OS processes, although their health requests are in-process app requests rather than TCP listeners.

The broader runtime isolation test also calls `spawnRuntime` twice before reading either child. Its file barrier requires each child to publish `initialized`, `before-mutation`, `mutation-started`, and `after-mutation` rendezvous state and wait for its peer. That barrier proves overlapping lifetime and mutation phases rather than merely adjacent process launches. Live acceptance separately proves distinct bound ports.

## Screenshots

The first fresh live run wrote screenshots to the isolated root for byte comparison. All four staged hashes differed, so a second fresh authenticated run recaptured the repository artifacts. The final retained comparison against the previous report changed both desktop hashes and retained both mobile hashes. The Tabs overlay was dismissed, the visible Home/Graph/composer states remained correct, and mobile overlap remained zero. The source-channel `DEV` badge remains unedited. The workspace image reader confirmed the staged visible states, and `file` confirmed the final PNG dimensions.

| Artifact                                         | Dimensions | SHA-256                                                            | Evidence                                                  |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `final-desktop-home-1440x900.png`                | 1440x900   | `fa2d5d5a9f7418c199958ec2e3d9a4fa575fc72057abe061d6234843fb2fa0c0` | Product shell, capability, current project, CTA           |
| `final-mobile-home-390x844.png`                  | 390x844    | `b5c0a7696a3135f5c5b202267aa08e59435de96baa4b8d31a1d6390e557163e2` | Responsive Home and CTA                                   |
| `final-desktop-empty-graph-1440x900.png`         | 1440x900   | `e357ceaf1c6343b9a6a3d1d30af9f541165857f925455d8b4f8e4ccfc7964d18` | Empty Graph and `Describe a goal`                         |
| `final-mobile-same-session-composer-390x844.png` | 390x844    | `edfb2ce7fd694a9cf9e0e170ba8f918f25732343439351023669252b1b493629` | Same-session composer with separated help/submit controls |

## Generation Determinism

Both passes ran:

```bash
(cd packages/client && bun run generate)
./packages/sdk/js/script/build.ts
```

Immediate hash commands:

```bash
git ls-files -z packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/v2/gen | sort -z | xargs -0 sha256sum | sha256sum
git diff --binary -- packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/v2/gen | sha256sum
```

| Pass | Generated content SHA-256                                          | Generated diff SHA-256                                             |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1    | `c966c551ec4bfbf03f75526cded0afdb06a2dcf93f5ed92d094ec4a0a4c0ef70` | `89c63f195a3b6dc095d3ff70a67dda7732978ec89a31918e41a501001290413c` |
| 2    | `c966c551ec4bfbf03f75526cded0afdb06a2dcf93f5ed92d094ec4a0a4c0ef70` | `89c63f195a3b6dc095d3ff70a67dda7732978ec89a31918e41a501001290413c` |

## Focused Verification

| Package             | Command                                                                                                                                                                                                                                                                                                                                                                                               | Result                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/opencode` | `bun test test/server/httpapi-global.test.ts test/integration/product-isolation.test.ts test/cli/web-source.test.ts test/cli/graph-vibe-launcher.test.ts`                                                                                                                                                                                                                                             | 23 passed, 0 failed, 169 assertions, 4 files    |
| `packages/app`      | `bun test --preload ./happydom.ts ./src/utils/product-presentation.test.ts ./src/utils/server-health.test.ts ./src/pages/product-migration.test.ts ./src/pages/graph-helpers.test.ts ./src/pages/layout/helpers.test.ts ./src/pages/home-session-open.test.ts ./src/context/layout.test.ts ./src/utils/route-scope.test.ts`                                                                           | 65 passed, 0 failed, 149 assertions, 8 files    |
| `packages/app`      | `bun test --conditions=browser --preload ./happydom.ts ./test-browser/home-graph-vibe.test.ts ./test-browser/product-migration.test.ts ./test-browser/product-title.test.ts ./test-browser/graph-workflow-cockpit.test.ts ./test-browser/body-design.test.ts ./test-browser/server-availability-gate.test.ts`                                                                                         | 38 passed, 0 failed, 173 assertions, 6 files    |
| `packages/sdk/js`   | `bun test test/product-migration.test.ts`                                                                                                                                                                                                                                                                                                                                                             | 4 passed, 0 failed, 17 assertions, 1 file       |
| `packages/app`      | `PLAYWRIGHT_PORT=4741 PLAYWRIGHT_SERVER_PORT=4096 PLAYWRIGHT_WORKERS=1 bunx playwright test e2e/regression/product-migration.spec.ts e2e/regression/graph-vibe-product-shell.spec.ts e2e/regression/graph-workflow-cockpit.spec.ts e2e/regression/cross-server-tab-close.spec.ts e2e/regression/remote-tab-busy.spec.ts e2e/regression/legacy-new-session.spec.ts --project chromium --reporter=line` | 45 passed, 0 failed, 6 files                    |
| `packages/app`      | authenticated isolated live command above                                                                                                                                                                                                                                                                                                                                                             | 1 passed, 0 failed                              |
| `packages/app`      | `bunx playwright test --list e2e/live/graph-vibe-live-acceptance.spec.ts --project chromium --reporter=line`                                                                                                                                                                                                                                                                                          | 1 test discovered in 1 file                     |
| `packages/app`      | `bun test --preload ./happydom.ts ./src/utils/startup-auth-token.test.ts`                                                                                                                                                                                                                                                                                                                             | 7 passed, 0 failed, 14 assertions, 1 file       |
| `packages/app`      | `bun test --preload ./happydom.ts ./src/context/server.test.ts`                                                                                                                                                                                                                                                                                                                                       | 12 passed, 0 failed, 31 assertions, 1 file      |
| `packages/app`      | `bun run test:unit`                                                                                                                                                                                                                                                                                                                                                                                   | 630 passed, 0 failed, 1657 assertions, 94 files |
| `packages/app`      | `PLAYWRIGHT_PORT=4741 PLAYWRIGHT_SERVER_PORT=4096 PLAYWRIGHT_WORKERS=1 bunx playwright test e2e/regression/product-migration.spec.ts e2e/regression/graph-vibe-product-shell.spec.ts --project chromium --reporter=line`                                                                                                                                                                              | 35 passed, 0 failed, 2 files                    |
| `packages/app`      | authenticated public-launch reload recheck                                                                                                                                                                                                                                                                                                                                                            | 1 passed, 0 failed                              |

The historical focused matrix and the current reload-fix checks all completed without failures. Counts overlap because the full App unit suite includes the focused utility and context tests.

### Full App Unit Suite

Command from `packages/app`:

```bash
bun run test:unit
```

Result: 630 passed, 0 failed, 1657 assertions across 94 files. The suite emitted the existing non-failing warning: `notification-click: navigate function not set, falling back to window.location.assign`.

### E2E Topology

The cross-server specs intentionally define server A as `4096` and depend on that identity being the implicit local server. All 45 tests passed with `PLAYWRIGHT_SERVER_PORT=4096`, including trailing-slash draft ownership, the two exact-target Graph lineage-error cases, and same-server OpenCode draft redirection compatibility. Browser routing fulfilled the mocked `4096/4097` server requests; the existing process on `4097` was not modified.

Typechecks:

```text
packages/opencode  bun typecheck          PASS
packages/app       bun typecheck          PASS
packages/app       bun run typecheck:e2e  PASS
packages/client    bun typecheck          PASS
packages/sdk/js    bun typecheck          PASS
```

## Existing Debug App Isolation And Cleanup

The existing debug app was unchanged before and after acceptance:

| Observation | tmux pane PID | Backend                      | UI                           |
| ----------- | ------------: | ---------------------------- | ---------------------------- |
| Before      |      `233751` | `0.0.0.0:4097`, PID `233827` | `0.0.0.0:4444`, PID `233859` |
| After       |      `233751` | `0.0.0.0:4097`, PID `233827` | `0.0.0.0:4444`, PID `233859` |

Acceptance cleanup:

```bash
tmux kill-session -t gv-final-recapture-4733
for attempt in {1..40}; do if test -z "$(ss -H -ltn 'sport = :4733 or sport = :4734')"; then exit 0; fi; sleep 0.25; done; exit 1
rm -rf -- "<isolated-root>"
```

Post-cleanup checks confirmed:

- acceptance tmux session absent;
- ports `4733` and `4734` closed;
- isolated root and password file absent;
- screenshot-comparison session, ports `4723` and `4724`, and isolated root absent;
- focused E2E UI port `4741` closed and mock server identity `4096` remained unbound;
- `graph-vibe-trial` session, ports, and PIDs unchanged.
