# Web Explorer Report

## Status

Completed read-only exploration. PSOC remains valid.

## Source Delivery

- `scripts/graph-vibe` changes cwd to `packages/opencode`; `web` does not currently receive the caller project directory.
- `packages/opencode/src/cli/cmd/web.ts` starts only `Server.listen(...)`, opens its URL, and waits forever. It does not start `packages/app` Vite or supervise child processes.
- Source Graph Vibe Web needs launcher-owned source-root and initial-directory values, plus a coordinator that starts backend and Vite, waits for readiness, opens the Vite project URL, and terminates both children together.
- Backend cwd must be the caller project directory because workspace routing falls back to `process.cwd()`.
- The opened source URL should include the URL-safe encoded project directory.

## Runtime UI Policy

- `packages/opencode/src/server/shared/ui.ts` dynamically imports the virtual `opencode-web-ui.gen.ts`; any missing import becomes `null` and currently proxies `https://app.opencode.ai`.
- Pass an explicit `allowUpstreamFallback` policy from server route assembly.
- Embedded assets serve for both identities.
- Missing assets retain upstream fallback for normal OpenCode.
- Missing assets return an explicit `503 Service Unavailable` for Graph Vibe before any upstream HTTP request.
- Identity, not the Graph experimental flag alone, controls the fallback policy.

## Packaged Delivery

- `packages/opencode/script/build.ts` already builds `packages/app/dist`, generates the virtual asset map, and embeds it in native binaries.
- The Graph route is already code-split from `packages/app/src/app.tsx` and is included by the app production build.
- Do not edit `packages/app/dist`, `opencode-web-ui.gen.ts`, or generated SDK trees.
- `packages/opencode/script/publish.ts` reconstructs package bins and currently drops the source package's `graph-vibe` alias; packaged identity needs an explicit wrapper/publish entry.

## Graph Routing

- Existing routes `/:dir/session/:id/graph` and `/server/:serverKey/session/:id/graph` are correct.
- `GraphPage` uses `sdk().directory`, preserving decoded filesystem paths.
- Existing session header links support both route forms.
- No public HttpApi change or SDK regeneration is required.

## Tests

- Extend `packages/opencode/test/server/httpapi-ui.test.ts` with Graph Vibe no-assets 503/no-upstream and OpenCode fallback regression cases.
- Add focused source coordinator tests for child args/cwd/env, browser URL, child failure, signal cleanup, and readiness timeout.
- Preserve `packages/opencode/test/cli/serve/serve-process.test.ts` regression coverage.
- Keep app graph helper and session route tests in final verification.
- Add a packaged build smoke for embedded Graph routes and no-embed identity policy when feasible.

## Verification

- `packages/opencode`: focused UI/coordinator/server tests and `bun typecheck`.
- `packages/app`: focused graph/route tests, `bun typecheck`, and `bun run build`.
- Native package: `bun run script/build.ts --single --skip-install` from `packages/opencode`.

## Risks

- Published Graph Vibe identity is incomplete until the package wrapper survives publish generation.
- Readiness parsing must tolerate ANSI output and race child exit/timeouts.
- Child process trees must be terminated and awaited before the top-level CLI calls `process.exit()`.
- Wildcard backend hosts cannot be used literally by remote browsers.
- Password-protected source mode must not expose credentials in printed URLs.
- The embedded UI import promise is process-global; tests should use explicit disable inputs rather than order-dependent import failures.
