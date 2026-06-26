# Minimal Dual-Name Rename — Design

- **Date:** 2026-06-26
- **Sub-project:** 0 (scaffolding, surface-level)
- **Status:** Approved in brainstorm; pending spec review

## Goal

Rebrand the fork to **"Graph Vibe OpenCode"** while honoring the upstream
(`anomalyco/opencode`). Surface-level and mechanical: minimal churn, zero friction for
future `merge upstream/dev`. This is branding scaffolding only — it does **not** touch the
graph feature (see `2026-06-26-graph-port-foundation.md` and future graph-port specs).

## Decisions

- **Brand name:** "Graph Vibe OpenCode" — keeping "opencode" in the name is the tribute to
  the fork origin.
- **Dual-name:** keep the `opencode` command working **and** add a `graph-vibe` alias.
- **Unchanged (tribute + upstream-merge):** `@opencode-ai/*` workspace scope and all
  internal package names, `OPENCODE_*` env vars, `~/.config/opencode` and
  `~/.local/share/opencode` dirs.

## Change set

1. **root `package.json`** — `name`: `opencode` → `graph-vibe-opencode`. Keep
   `repository.url` pointing at `https://github.com/anomalyco/opencode` (tribute).
2. **`packages/opencode/package.json`** — add `"graph-vibe": "./bin/opencode"` to `bin`
   (shares the existing platform-binary lookup shim). Keep `name: opencode`.
3. **root `package.json`** — add a `"graph-vibe"` script mirroring `dev`:
   `bun run --cwd packages/opencode --conditions=browser src/index.ts`.
4. **`README.md`** — title → "Graph Vibe OpenCode"; add a tribute line "Forked from
   [anomalyco/opencode]". Translated `README.*.md` are **out of scope** this round.
5. **`packages/opencode/src/cli/ui.ts`** — keep the "opencode" ASCII logo; add a subtitle
   line beneath it: "Graph Vibe OpenCode · forked from anomalyco/opencode".

## Explicitly NOT changed

- `@opencode-ai/*` workspace scope and all internal package names
- `OPENCODE_*` environment variables
- `~/.config/opencode`, `~/.local/share/opencode` (config + storage dirs)
- `src/index.ts` `.scriptName("opencode")` (kept — tribute, minimal churn)
- `packages/opencode` package name; platform package names `opencode-<plat>-<arch>`
- `bunfig.toml`, lockfile, all source logic

## Acceptance criteria

- `bun dev` still launches the TUI and renders with no regression.
- Root package identity reports `graph-vibe-opencode`.
- `bun run graph-vibe` launches the same TUI as `bun dev`.
- `bun dev --version` still works.
- After a build, both the `opencode` and `graph-vibe` bin entries resolve to the same CLI.
- `git diff --stat` touches only: root `package.json`,
  `packages/opencode/package.json`, `README.md`, `packages/opencode/src/cli/ui.ts`.

## Out of scope

- Translated README rebrand (future).
- Any graph-port feature (separate specs).
- npm publish name / distribution (not publishing yet).
