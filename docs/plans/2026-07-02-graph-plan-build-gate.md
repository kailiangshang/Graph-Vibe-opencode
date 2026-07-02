# Plan/Build Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core Plan/Build gate primitives for graph-driven execution: CurrentPlan admission, hard Build gate evaluation, controlled Artifact validation/application, and audit persistence.

**Architecture:** Keep pure workflow logic in small modules under `packages/core/src/graph/workflow/`; wrap storage-backed behavior with Effect services. Do not wire opencode tool registry, TUI, Server, Protocol, or Autopilot in this subproject.

**Tech Stack:** TypeScript, Bun, Effect v4, Drizzle SQLite, existing graph storage/domain/derivation modules.

**Spec:** `docs/specs/2026-07-02-graph-plan-build-gate.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/graph/workflow/artifact.ts` | Pure Artifact types, SHA-256 hashing, validation, pure application plan |
| `packages/core/src/graph/workflow/gate.ts` | Pure Build gate evaluator using graph views, domain validation, conflicts, derivation issues, artifact issues |
| `packages/core/src/graph/workflow/audit.sql.ts` | Drizzle table definitions for `graph_tool_run` and `graph_generation_run` |
| `packages/core/src/database/migration/20260702022948_graph_workflow.ts` | SQL migration for audit tables and indexes |
| `packages/core/src/graph/workflow/audit.ts` | `GraphAudit.Service` record/list APIs |
| `packages/core/src/graph/workflow/plan.ts` | `GraphPlan.Service` CurrentPlan admission, dry-run and persisted modes |
| `packages/core/src/graph/workflow/build.ts` | `GraphBuild.Service` loads graph state, evaluates gate, records audit |
| `packages/core/test/graph-artifact.test.ts` | Pure artifact tests |
| `packages/core/test/graph-gate.test.ts` | Pure gate tests |
| `packages/core/test/graph-audit.test.ts` | Audit persistence integration tests |
| `packages/core/test/graph-plan.test.ts` | CurrentPlan admission integration tests |
| `packages/core/test/graph-build.test.ts` | Build workflow integration tests |

Dependency order: `artifact.ts` → `gate.ts` → `audit-sql.ts`/migration/`audit.ts` → `plan.ts` → `build.ts`.

---

### Task 1: Controlled Artifact Pure Module

**Files:**
- Create: `packages/core/src/graph/workflow/artifact.ts`
- Test: `packages/core/test/graph-artifact.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { hashContent, planArtifactApplication, validateArtifact } from "@opencode-ai/core/graph/workflow/artifact"

describe("Graph Artifact", () => {
  test("full artifact requires path, code, and test", () => {
    expect(validateArtifact({ mode: "full", path: "", code: "", test: "" }).map((i) => i.code)).toEqual([
      "empty_path",
      "empty_code",
      "empty_test",
    ])
  })

  test("patch artifact validates preimage hash before replacing old text", () => {
    const current = "export const n = 1\n"
    const result = planArtifactApplication(
      {
        mode: "patch",
        operations: [{ path: "src/a.ts", preimageHash: hashContent(current), old: "n = 1", replacement: "n = 2" }],
      },
      { "src/a.ts": current },
    )

    expect(result.valid).toBe(true)
    expect(result.files["src/a.ts"]).toBe("export const n = 2\n")
  })

  test("patch artifact reports hash mismatch and does not apply", () => {
    const result = planArtifactApplication(
      {
        mode: "patch",
        operations: [{ path: "src/a.ts", preimageHash: "bad", old: "n = 1", replacement: "n = 2" }],
      },
      { "src/a.ts": "export const n = 1\n" },
    )

    expect(result.valid).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain("preimage_hash_mismatch")
  })
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd packages/core && bun test test/graph-artifact.test.ts`

Expected: FAIL because `@opencode-ai/core/graph/workflow/artifact` does not exist.

- [ ] **Step 3: Implement minimal artifact module**

Implement:
- `FullArtifact`, `PatchArtifact`, `PatchOperation`, `Artifact`, `ArtifactIssue`, `ArtifactApplyResult`
- `hashContent(content)` using `new Bun.CryptoHasher("sha256").update(content).digest("hex")`
- `validateArtifact(artifact)`
- `planArtifactApplication(artifact, files)` returning `{ valid, issues, files }`

Rules:
- `full` returns target file content as `code` after format validation.
- `patch` starts from the provided `files` map, checks each preimage hash, checks `old` is non-empty and present, then replaces the first occurrence.
- No filesystem writes.

- [ ] **Step 4: Run test to verify GREEN**

Run: `cd packages/core && bun test test/graph-artifact.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/workflow/artifact.ts packages/core/test/graph-artifact.test.ts
git commit -m "feat(core/graph): controlled artifact validation"
```

---

### Task 2: Pure Build Gate Evaluator

**Files:**
- Create: `packages/core/src/graph/workflow/gate.ts`
- Test: `packages/core/test/graph-gate.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { evaluateBuildGate } from "@opencode-ai/core/graph/workflow/gate"
import type { GraphView, NodeID } from "@opencode-ai/core/graph/storage"

const PID = "proj_test" as any
const SID = "ses_test"
const node = (id: string, extra = {}) => ({
  id: id as NodeID,
  projectID: PID,
  sessionID: SID,
  type: "atomic",
  name: id,
  level: "L2",
  priority: null,
  category: null,
  status: "pending",
  desc: null,
  content: null,
  codeHash: null,
  testStatus: "none",
  confidence: 1,
  timeCreated: 0,
  timeUpdated: 0,
  ...extra,
} as const)

describe("Build gate", () => {
  test("blocks target outside CurrentPlan", () => {
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: "missing" as NodeID,
      main: { nodes: [], edges: [] },
      currentPlan: { nodes: [], edges: [] },
    })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain("target_not_in_current_plan")
  })

  test("blocks unimplemented blocks dependency", () => {
    const dep = node("dep", { status: "pending" })
    const target = node("target")
    const currentPlan: GraphView = {
      nodes: [dep, target],
      edges: [{ id: "edge" as any, projectID: PID, sessionID: SID, sourceID: dep.id, targetID: target.id, relation: "blocks", confidence: 1, timeCreated: 0 }],
    }

    const result = evaluateBuildGate({ projectID: PID, sessionID: SID, targetNodeID: target.id, main: { nodes: [], edges: [] }, currentPlan })

    expect(result.allowed).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain("blocked_by_dependency")
  })

  test("reports artifact write permission requirement", () => {
    const target = node("target")
    const result = evaluateBuildGate({
      projectID: PID,
      sessionID: SID,
      targetNodeID: target.id,
      main: { nodes: [], edges: [] },
      currentPlan: { nodes: [target], edges: [] },
      artifact: { mode: "full", path: "src/a.ts", code: "export {}\n", test: "test\n" },
      diagnosticsRequested: true,
    })

    expect(result.allowed).toBe(true)
    expect(result.requiredPermissions).toEqual(["artifact_write", "diagnostics_run"])
  })
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd packages/core && bun test test/graph-gate.test.ts`

Expected: FAIL because `gate.ts` does not exist.

- [ ] **Step 3: Implement minimal gate evaluator**

Implement:
- `BuildGateInput`, `GateIssue`, `GateResult`, `evaluateBuildGate(input)`
- Use `validateSubgraph(currentPlan)` from `../validation`
- Use `detectConflicts(currentPlan, main)` from `../conflict`
- Use `validateArtifact(input.artifact)` from `./artifact`

Rules:
- All issue severities are `block` in this subproject.
- `allowed = issues.every((issue) => issue.severity !== "block")`
- Required permission order is stable: `artifact_write`, then `diagnostics_run`.

- [ ] **Step 4: Add gate coverage for stale, conflicts, validation, derivation issues**

Add tests for:
- target status `verified` and `deprecated` → `target_status_blocked`
- node content `{ stale: true }` → `stale_intent`
- invalid current plan edge → `current_plan_invalid`
- main/plan conflict → `conflict_detected`
- consistency issue `stale_node`/`missing_node`/`hash_mismatch` → `structural_drift`
- consistency issue `missing_code_ref`/`invalid_code_ref`/`missing_code` → `missing_code_reference`

- [ ] **Step 5: Run test to verify GREEN**

Run: `cd packages/core && bun test test/graph-gate.test.ts test/graph-artifact.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/graph/workflow/gate.ts packages/core/test/graph-gate.test.ts
git commit -m "feat(core/graph): build gate evaluator"
```

---

### Task 3: Audit Tables and Service

**Files:**
- Create: `packages/core/src/graph/workflow/audit.sql.ts`
- Create: `packages/core/src/graph/workflow/audit.ts`
- Create: `packages/core/src/database/migration/20260702022948_graph_workflow.ts`
- Test: `packages/core/test/graph-audit.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphAudit from "@opencode-ai/core/graph/workflow/audit"

const PID = "proj_test" as any
const SID = "ses_test"
const layer = GraphAudit.layer.pipe(Layer.provideMerge(GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))))) as any

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID, project_id: PID, slug: "test", directory: "/tmp/test" as any, title: "test", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* effect }).pipe(Effect.provide(layer), Effect.scoped))

describe("GraphAudit", () => {
  test("records and lists tool runs by session", async () => {
    await run(Effect.gen(function* () {
      const audit = yield* GraphAudit.Service
      yield* audit.tool.record({ projectID: PID, sessionID: SID, toolName: "graph.build.gate", toolType: "graph", status: "blocked", inputSummary: "target" })
      const rows = yield* audit.tool.list({ projectID: PID, sessionID: SID })
      expect(rows.length).toBe(1)
      expect(rows[0].toolName).toBe("graph.build.gate")
      expect(rows[0].status).toBe("blocked")
    }))
  })
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd packages/core && bun test test/graph-audit.test.ts`

Expected: FAIL because audit module/tables do not exist.

- [ ] **Step 3: Implement SQL tables and migration**

Create `GraphToolRunTable` and `GraphGenerationRunTable` using snake_case fields. Migration creates both tables plus indexes:
- `graph_tool_run_project_session_idx`
- `graph_tool_run_node_idx`
- `graph_generation_run_project_session_idx`
- `graph_generation_run_node_idx`

- [ ] **Step 4: Implement `GraphAudit.Service`**

Expose:
- `tool.record(input)` / `tool.list(filter)`
- `generation.record(input)` / `generation.list(filter)`

Map DB rows to camelCase row interfaces. Use generated IDs with `gtr_` and `ggr_` prefixes.

- [ ] **Step 5: Run audit tests and migration check**

Run: `cd packages/core && bun test test/graph-audit.test.ts`

Expected: PASS.

Run: `cd packages/core && bun run script/migration.ts --check`

Expected: no drift.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/graph/workflow/audit.sql.ts packages/core/src/graph/workflow/audit.ts packages/core/src/database/migration/20260702022948_graph_workflow.ts packages/core/test/graph-audit.test.ts
git commit -m "feat(core/graph): workflow audit persistence"
```

---

### Task 4: CurrentPlan Admission Service

**Files:**
- Create: `packages/core/src/graph/workflow/plan.ts`
- Test: `packages/core/test/graph-plan.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphDomain from "@opencode-ai/core/graph/domain"
import * as GraphPlan from "@opencode-ai/core/graph/workflow/plan"

const PID = "proj_test" as any
const SID = "ses_test"

describe("GraphPlan.admit", () => {
  test("dry-run validates but does not write CurrentPlan", async () => {
    // Use same seed/layer pattern as graph-domain.test.ts.
    // Admit one atomic node with dryRun: true.
    // Assert result.dryRun === true and storage.currentPlan({ sessionID: SID }).nodes.length === 0.
  })

  test("persists nodes and edges as session-scoped CurrentPlan", async () => {
    // Admit two atomic nodes and a blocks edge.
    // Assert currentPlan has two nodes, one edge, all with sessionID === SID.
  })
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd packages/core && bun test test/graph-plan.test.ts`

Expected: FAIL because `plan.ts` does not exist.

- [ ] **Step 3: Implement `GraphPlan.Service`**

Expose:
- `admit(input): Effect<AdmitPlanResult, GraphDomain.ValidationError | GraphStorage.NotFoundError>`

Implementation:
- Bind `GraphDomain.Service` to `domain` before use.
- For dry-run, build an in-memory `GraphView` from input nodes/edges with project/session injected and call `validateSubgraph`.
- For persisted mode, create nodes with `domain.node.create({ ...node, projectID, sessionID })`, then edges with `domain.edge.create({ ...edge, projectID, sessionID })`.
- Return counts.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && bun test test/graph-plan.test.ts test/graph-domain.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/workflow/plan.ts packages/core/test/graph-plan.test.ts
git commit -m "feat(core/graph): current plan admission service"
```

---

### Task 5: Build Workflow Service

**Files:**
- Create: `packages/core/src/graph/workflow/build.ts`
- Test: `packages/core/test/graph-build.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphBuild from "@opencode-ai/core/graph/workflow/build"
import * as GraphAudit from "@opencode-ai/core/graph/workflow/audit"

const PID = "proj_test" as any
const SID = "ses_test"

describe("GraphBuild.evaluate", () => {
  test("loads CurrentPlan, blocks invalid target, and records audit", async () => {
    // Seed project/session.
    // Create a CurrentPlan node, then evaluate a missing target.
    // Assert result.allowed === false.
    // Assert one generation run and one tool run were recorded with status blocked.
  })

  test("returns allowed gate result for buildable node and records dry_run", async () => {
    // Create a pending CurrentPlan target.
    // Evaluate with dryRun: true and a valid full artifact.
    // Assert allowed === true, requiredPermissions contains artifact_write, generation status dry_run.
  })
})
```

- [ ] **Step 2: Run test to verify RED**

Run: `cd packages/core && bun test test/graph-build.test.ts`

Expected: FAIL because `build.ts` does not exist.

- [ ] **Step 3: Implement `GraphBuild.Service`**

Expose:
- `evaluate(input): Effect<GateResult>`

Implementation:
- Bind `GraphStorage.Service` and `GraphAudit.Service` to named variables before calling methods.
- Load `main` and `currentPlan`.
- Call `evaluateBuildGate`.
- Record `generation` with status `blocked` if `allowed === false`, `dry_run` if input has `dryRun`, otherwise `succeeded`.
- Record `tool` named `graph.build.gate` with matching status.
- Return the `GateResult`.

- [ ] **Step 4: Run workflow tests**

Run: `cd packages/core && bun test test/graph-build.test.ts test/graph-gate.test.ts test/graph-audit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/workflow/build.ts packages/core/test/graph-build.test.ts
git commit -m "feat(core/graph): build gate workflow service"
```

---

### Task 6: Final Verification and Integration

**Files:**
- Verify all changed graph workflow files.
- Update docs only if implementation diverges from spec.

- [ ] **Step 1: Run focused graph workflow tests**

Run: `cd packages/core && bun test test/graph-artifact.test.ts test/graph-gate.test.ts test/graph-audit.test.ts test/graph-plan.test.ts test/graph-build.test.ts`

Expected: all pass.

- [ ] **Step 2: Run full package verification**

Run: `cd packages/core && bun typecheck`

Expected: clean.

Run: `cd packages/core && bun test`

Expected: all pass.

Run: `cd packages/core && bun run script/migration.ts --check`

Expected: no schema drift.

- [ ] **Step 3: Check upstream divergence**

Run: `git diff --stat dev -- packages/core docs/specs docs/plans`

Expected: changes are isolated to graph workflow docs/core files and migration.

- [ ] **Step 4: Merge and sync**

Run:

```bash
git checkout dev
git merge --ff-only plan-build-gate
git fetch upstream
git merge upstream/dev --no-edit
```

Expected: fast-forward branch merge; upstream merge should be conflict-free or limited to known brand files.

- [ ] **Step 5: Re-verify after merge**

Run: `cd packages/core && bun typecheck && bun test && bun run script/migration.ts --check`

Expected: all pass.

- [ ] **Step 6: Push and cleanup**

Run:

```bash
git push origin dev
git branch -d plan-build-gate
```

Expected: push succeeds; feature branch deleted.
