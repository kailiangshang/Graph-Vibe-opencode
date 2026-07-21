# Graph Diagnostics Applicability Design

## Problem

Graph diagnostics currently treats every root `test`, `typecheck`, and `lint` script as runnable and passes every requested path to its diagnostic script. In this repository that produces false failures: the root `test` script is an intentional guard that always exits with an error, and oxlint rejects Markdown paths because it has no applicable files. Root typechecking can also exceed a bounded server cgroup when Turbo runs many package checks concurrently.

## Goals

- Do not run root scripts whose sole purpose is to reject execution from that directory.
- Do not run focused oxlint commands for unsupported Markdown targets.
- Preserve authoritative project-level checks and strict failure behavior.
- Keep prior diagnostic evidence immutable and recover the same durable workflow through a normal retry.
- Avoid public Schema or HttpApi changes.

## Resolution

`GraphDiagnostics.resolve` remains the single command-generation boundary shared by legacy and canonical tools.

1. Read the configured root diagnostic scripts.
2. Exclude an explicit guard script that only prints a prohibition and unconditionally exits with status 1.
3. If a verification specification requires an excluded diagnostic and no runnable script remains, return `diagnostic_script_missing`.
4. For oxlint-backed `lint`, omit focused commands whose paths all have Markdown extensions. Other diagnostic tools and supported paths keep existing behavior.
5. Record omitted focused diagnostics in an internal `skipped` list with their name, paths, and reason.
6. Continue to generate project-level commands from all runnable detected scripts. Skipping a non-applicable focused command does not reduce completeness when the authoritative project-level command runs.

Successful tool output and audit summaries report skipped diagnostics. Durable `VerificationEvidence.commands` continues to contain only commands that actually ran, avoiding fabricated execution evidence.

## Failure Semantics

- A required diagnostic with only a guard script is missing, not passing.
- A supported focused diagnostic that exits non-zero still fails normally.
- A project-level diagnostic that exits non-zero still fails normally.
- Existing failed evidence and retry counts are not rewritten. The current workflow uses its remaining retry budget after the fix.
- Review execution keeps a hard memory cap and constrains Turbo concurrency through the service environment; product code does not weaken verification to accommodate memory pressure.

## Tests

- A root test guard is excluded from detected project diagnostics.
- Requiring that excluded test returns `diagnostic_script_missing`.
- Oxlint with only Markdown targets omits the focused command, reports it as skipped, and retains project lint.
- Oxlint with a TypeScript target still emits focused and project lint commands.
- Existing target canonicalization, path safety, filtering, completeness, and command execution tests remain green.

## Live Recovery

After focused tests and Core/OpenCode typechecks pass, restart the isolated review backend with its existing data root, an 8 GiB memory ceiling, and `TURBO_CONCURRENCY=1`. Resume session `ses_07d868415ffeY0dqM620rC8xmv` without recreating the plan or reapplying the existing draft. Stop if the remaining durable diagnostic retry fails.
