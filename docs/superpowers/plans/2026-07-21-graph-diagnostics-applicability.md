# Graph Diagnostics Applicability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Graph diagnostics from executing intentional root guard scripts or focused oxlint commands for unsupported Markdown paths while preserving strict project-level verification.

**Architecture:** Keep applicability decisions in shared `GraphDiagnostics.resolve`, before permissions or child processes are created. Return internal skipped-command metadata to both Graph tool adapters, while durable evidence continues to contain only commands that actually ran.

**Tech Stack:** TypeScript, Bun test, Effect v4, Graph workflow legacy and canonical tool adapters.

---

### Task 1: Specify Diagnostic Applicability

**Files:**
- Create: `packages/core/test/graph-diagnostics.test.ts`
- Modify: `packages/core/src/graph/workflow/diagnostics.ts:24-97`

- [ ] **Step 1: Write failing resolver tests**

Create temporary projects with `package.json` scripts and real target files. Assert these behaviors:

```ts
test("excludes an intentional root test guard", async () => {
  await using dir = await project({
    test: "echo 'do not run tests from root' && exit 1",
    typecheck: "tsgo --noEmit",
    lint: "oxlint",
  })
  const result = await GraphDiagnostics.resolve({ directory: dir.path, verification: null })
  expect(result).toMatchObject({ ok: true, complete: true })
  if (!result.ok) return
  expect(result.commands.map((command) => command.name)).toEqual(["typecheck", "lint"])
})

test("reports a required guard-only test as missing", async () => {
  await using dir = await project({ test: "echo 'do not run tests from root' && exit 1" })
  const result = await GraphDiagnostics.resolve({
    directory: dir.path,
    verification: { criteria: ["verified"], diagnostics: [{ name: "test" }] },
  })
  expect(result).toEqual({ ok: false, reason: "diagnostic_script_missing", diagnostic: "test" })
})

test("skips focused oxlint for Markdown but retains project lint", async () => {
  await using dir = await project({ lint: "oxlint" }, { "README.md": "# Readme\n" })
  const result = await GraphDiagnostics.resolve({
    directory: dir.path,
    verification: { criteria: ["formatted"], diagnostics: [{ name: "lint", paths: ["README.md"] }] },
  })
  expect(result).toMatchObject({
    ok: true,
    complete: true,
    skipped: [{ name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" }],
  })
  if (!result.ok) return
  expect(result.commands.map((command) => command.command)).toEqual(["bun run lint"])
})

test("keeps focused oxlint for TypeScript", async () => {
  await using dir = await project({ lint: "oxlint" }, { "src/example.ts": "export {}\n" })
  const result = await GraphDiagnostics.resolve({
    directory: dir.path,
    verification: { criteria: ["linted"], diagnostics: [{ name: "lint", paths: ["src/example.ts"] }] },
  })
  expect(result).toMatchObject({ ok: true, skipped: [] })
  if (!result.ok) return
  expect(result.commands.map((command) => command.command)).toEqual([
    `bun run lint -- ${dir.path}/src/example.ts`,
    "bun run lint",
  ])
})
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/core` under a 1.5 GiB cgroup:

```bash
systemd-run --user --scope --quiet -p MemoryMax=1536M -p MemorySwapMax=256M bun test test/graph-diagnostics.test.ts
```

Expected: guard and Markdown applicability assertions fail because all scripts and focused paths are currently emitted.

- [ ] **Step 3: Implement minimal shared applicability logic**

Add a skipped result contract and filter command generation without changing public schemas:

```ts
export interface Skipped {
  readonly name: DiagnosticName
  readonly paths: ReadonlyArray<string>
  readonly reason: "unsupported_focused_paths"
}
```

The successful `Resolution` variant gains `readonly skipped: ReadonlyArray<Skipped>`. Filter detected scripts with a helper that recognizes only an explicit print-and-exit guard:

```ts
function isRunnableScript(script: string | undefined) {
  if (!script) return false
  const guard = /^\s*(?:echo|printf)\s+.+(?:&&|;)\s*exit\s+1\s*$/i.test(script)
  const prohibition = /(?:do not|don't|must not|cannot|can't)\s+run/i.test(script)
  return !guard || !prohibition
}
```

Validate all requested paths as before, then split each focused request into supported and skipped paths. Only oxlint-backed lint treats `.md` and `.mdx` as unsupported:

```ts
function supportsFocusedPath(name: DiagnosticName, script: string, relative: string) {
  if (name !== "lint" || !/(?:^|\s|\/|\\)oxlint(?:\s|$)/.test(script)) return true
  return !/\.mdx?$/i.test(relative)
}
```

Generate focused commands from supported paths, project commands from runnable scripts, and return `skipped` with `complete` unchanged.

- [ ] **Step 4: Run resolver tests and existing location tests**

Run from `packages/core`:

```bash
systemd-run --user --scope --quiet -p MemoryMax=1536M -p MemorySwapMax=256M bun test test/graph-diagnostics.test.ts test/location-layer.test.ts
```

Expected: all tests pass, including existing focused-path canonicalization and race checks.

- [ ] **Step 5: Commit shared resolver behavior**

```bash
git add packages/core/src/graph/workflow/diagnostics.ts packages/core/test/graph-diagnostics.test.ts
git commit -m "fix(graph): skip inapplicable diagnostics"
```

### Task 2: Expose Skipped Diagnostics Consistently

**Files:**
- Modify: `packages/core/src/tool/graph.ts:525-667`
- Modify: `packages/opencode/src/tool/graph/diagnostics-run.ts:188-353`
- Test: `packages/core/test/graph-diagnostics.test.ts`

- [ ] **Step 1: Add failing output-shape assertions**

Extend resolver tests to assert exact skipped metadata, including mixed supported and unsupported paths:

```ts
expect(result.skipped).toEqual([
  { name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" },
])
expect(result.commands[0]?.targets.map((target) => target.relative)).toEqual(["src/example.ts"])
```

- [ ] **Step 2: Verify the new assertions fail before adapter changes**

Run the Core resolver test command from Task 1. Expected: mixed-path assertion fails until supported paths and skipped metadata are separated correctly.

- [ ] **Step 3: Include skipped metadata in both adapters**

In both successful diagnostics paths, add `skipped: resolution.skipped` to metadata and model-facing JSON output. Include the skipped count in audit summaries without adding skipped entries to `VerificationEvidence.commands`:

```ts
const inputSummary = [
  ...commands.map((command) => command.name),
  ...(resolution.skipped.length > 0 ? [`skipped=${resolution.skipped.length}`] : []),
].join("; ")
```

Return shape:

```ts
{
  ran: true,
  passed: allPassed,
  complete: completeDiagnostics,
  verified,
  skipped: resolution.skipped,
  results,
}
```

- [ ] **Step 4: Run affected Graph suites**

Run Core `test/graph-diagnostics.test.ts test/location-layer.test.ts` and OpenCode `test/tool/graph-tools.test.ts test/tool/graph-artifact-apply.test.ts` in separate 1.5 GiB scopes. Expected: all pass.

- [ ] **Step 5: Run package typechecks**

Run `bun typecheck` from `packages/core` with a 3 GiB cap and from `packages/opencode` with a 5 GiB cap. Expected: both exit 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit adapter reporting**

```bash
git add packages/core/src/tool/graph.ts packages/opencode/src/tool/graph/diagnostics-run.ts packages/core/test/graph-diagnostics.test.ts
git commit -m "fix(graph): report skipped diagnostics"
```

### Task 3: Recover the Durable Review Workflow

**Files:**
- Preserve: `docs/graph-workflow-review-draft.md`
- Runtime state: `/tmp/opencode/graph-workflow-review`

- [ ] **Step 1: Restart the isolated backend safely**

Use the existing data/config roots, `MemoryMax=8192M`, `MemorySwapMax=256M`, and `TURBO_CONCURRENCY=1`. Keep UI port 4786 and backend port 4785.

- [ ] **Step 2: Verify service and durable state**

Check `/global/health`, then `/graph/workflow` for session `ses_07d868415ffeY0dqM620rC8xmv`. Expected: backend healthy; revision 4; task `atomic-draft-content` implemented with one failed diagnostic attempt and no active operation.

- [ ] **Step 3: Resume only the failed diagnostic**

Submit one async Build-agent prompt instructing the model to keep the existing plan/artifact and call `graph_diagnostics_run` with `timeout: 900000`. Do not admit a new plan or apply the draft again.

- [ ] **Step 4: Wait for observable idle state**

Poll `/session/status` until the session leaves `busy`, stopping immediately if the backend unit exits or reaches its memory ceiling.

- [ ] **Step 5: Inspect workflow evidence and worktree**

Verify the latest evidence omits the root guard and focused Markdown lint, reports both as skipped, and records successful project typecheck/lint. Confirm no unexpected files changed beyond the workflow artifact and intended README update.

- [ ] **Step 6: Final commit if the model completes the documentation task**

Review the generated content against the 10-15 line requirement before staging. Commit only accepted workflow output; leave unrelated files untouched.
