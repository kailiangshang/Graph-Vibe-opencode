# Graph Mode Tool Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in graph mode tool surface that exposes graph-aware Plan/Build/Artifact tools, hides raw write/exec tools, and injects graph workflow instructions.

**Architecture:** Keep graph tool logic in new `packages/opencode/src/tool/graph/` files and reuse core graph workflow services. Modify existing opencode files only at narrow composition points: runtime flag, tool registry, instruction system.

**Tech Stack:** TypeScript, Bun, Effect v4, opencode Tool API, core graph services, Drizzle-backed in-memory tests.

**Spec:** `docs/specs/2026-07-02-graph-tool-integration.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/graph/storage.ts` | Add `GraphStorage.node` LayerNode export |
| `packages/core/src/graph/domain.ts` | Add `GraphDomain.node` LayerNode export |
| `packages/core/src/graph/workflow/audit.ts` | Add `GraphAudit.node` LayerNode export |
| `packages/core/src/graph/workflow/plan.ts` | Add `GraphPlan.node` LayerNode export |
| `packages/core/src/graph/workflow/build.ts` | Add `GraphBuild.node` LayerNode export |
| `packages/opencode/src/tool/graph/prompt.txt` | Graph workflow instructions |
| `packages/opencode/src/tool/graph/util.ts` | Shared graph tool helpers: session resolution, path normalization, summaries |
| `packages/opencode/src/tool/graph/plan-admit.ts` | `graph_plan_admit` tool |
| `packages/opencode/src/tool/graph/build-gate.ts` | `graph_build_gate` tool |
| `packages/opencode/src/tool/graph/artifact-apply.ts` | `graph_artifact_apply` tool |
| `packages/opencode/src/tool/graph/index.ts` | Graph tool exports and registry helper predicates |
| `packages/opencode/src/effect/runtime-flags.ts` | Add `experimentalGraphMode` flag |
| `packages/opencode/src/tool/registry.ts` | Compose graph tools when graph mode is enabled |
| `packages/opencode/src/session/instruction.ts` | Append graph prompt when graph mode is enabled |

---

### Task 1: Core Graph LayerNode Wiring

**Files:**
- Modify: `packages/core/src/graph/storage.ts`
- Modify: `packages/core/src/graph/domain.ts`
- Modify: `packages/core/src/graph/workflow/audit.ts`
- Modify: `packages/core/src/graph/workflow/plan.ts`
- Modify: `packages/core/src/graph/workflow/build.ts`
- Test: `packages/core/test/graph-layer-node.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/graph-layer-node.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphDomain from "@opencode-ai/core/graph/domain"
import * as GraphAudit from "@opencode-ai/core/graph/workflow/audit"
import * as GraphPlan from "@opencode-ai/core/graph/workflow/plan"
import * as GraphBuild from "@opencode-ai/core/graph/workflow/build"

describe("graph LayerNode wiring", () => {
  test("graph workflow nodes compile", () => {
    expect(() => LayerNode.compile(LayerNode.group([
      GraphStorage.node,
      GraphDomain.node,
      GraphAudit.node,
      GraphPlan.node,
      GraphBuild.node,
    ]))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run RED**

Run: `cd packages/core && bun test test/graph-layer-node.test.ts`

Expected: FAIL because `node` exports do not exist on graph modules.

- [ ] **Step 3: Implement LayerNode exports**

Add `LayerNode` imports and exports:

```ts
import { LayerNode } from "../effect/layer-node"
```

For `storage.ts`:

```ts
export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
```

For `domain.ts`:

```ts
export const node = LayerNode.make({ service: Service, layer, deps: [GraphStorage.node] })
```

For workflow files, use correct relative import path `../../effect/layer-node` and dependencies:

```ts
GraphAudit.node => deps: [Database.node]
GraphPlan.node => deps: [GraphDomain.node]
GraphBuild.node => deps: [GraphStorage.node, GraphAudit.node]
```

- [ ] **Step 4: Run GREEN**

Run: `cd packages/core && bun test test/graph-layer-node.test.ts && bun typecheck`

Expected: PASS and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/storage.ts packages/core/src/graph/domain.ts packages/core/src/graph/workflow/audit.ts packages/core/src/graph/workflow/plan.ts packages/core/src/graph/workflow/build.ts packages/core/test/graph-layer-node.test.ts
git commit -m "feat(core/graph): expose graph workflow layer nodes"
```

---

### Task 2: Graph Plan and Build Tools

**Files:**
- Create: `packages/opencode/src/tool/graph/util.ts`
- Create: `packages/opencode/src/tool/graph/plan-admit.ts`
- Create: `packages/opencode/src/tool/graph/build-gate.ts`
- Create: `packages/opencode/src/tool/graph/index.ts`
- Test: `packages/opencode/test/tool/graph-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that:
- seed `ProjectTable` and `SessionTable` in an in-memory DB;
- initialize `GraphPlanAdmitTool` and execute it with `ctx.sessionID`;
- verify nodes are written to CurrentPlan without model-supplied `projectID`;
- initialize `GraphBuildGateTool` and verify a missing target returns `allowed: false`.

- [ ] **Step 2: Run RED**

Run: `cd packages/opencode && bun test test/tool/graph-tools.test.ts`

Expected: FAIL because graph tool modules do not exist.

- [ ] **Step 3: Implement `util.ts`**

Exports:
- `resolveGraphSession(ctx)` calls `Session.Service.get(ctx.sessionID)` and returns `{ projectID, sessionID }`.
- `formatJson(value)` returns pretty JSON string.
- `summarizeGate(result)` returns `allowed` or `blocked:<count>`.

- [ ] **Step 4: Implement `graph_plan_admit`**

Use `Tool.define("graph_plan_admit", ...)`. Parameters mirror spec. Execution:
- resolve graph session;
- call `GraphPlan.Service.admit({ projectID, sessionID, ...params })`;
- record `GraphAudit.tool.record` with `toolName: "graph.plan.admit"`;
- return title `CurrentPlan admitted` or `CurrentPlan dry-run` and JSON output.

- [ ] **Step 5: Implement `graph_build_gate`**

Use `Tool.define("graph_build_gate", ...)`. Execution:
- resolve graph session;
- call `GraphBuild.Service.evaluate({ projectID, sessionID, targetNodeID, executor: "manual", ...params })`;
- return title `Build gate allowed` or `Build gate blocked` and JSON output.

- [ ] **Step 6: Run GREEN**

Run: `cd packages/opencode && bun test test/tool/graph-tools.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/tool/graph/util.ts packages/opencode/src/tool/graph/plan-admit.ts packages/opencode/src/tool/graph/build-gate.ts packages/opencode/src/tool/graph/index.ts packages/opencode/test/tool/graph-tools.test.ts
git commit -m "feat(opencode): add graph plan and build gate tools"
```

---

### Task 3: Graph Artifact Apply Tool

**Files:**
- Create: `packages/opencode/src/tool/graph/artifact-apply.ts`
- Modify: `packages/opencode/src/tool/graph/index.ts`
- Test: `packages/opencode/test/tool/graph-artifact-apply.test.ts`

- [ ] **Step 1: Write failing tests**

Cover two behaviours:
- gate block prevents permission prompt and filesystem write;
- allowed full artifact asks `graph.artifact_write`, writes the file, and updates target node to `implemented` + `pending` test status.

- [ ] **Step 2: Run RED**

Run: `cd packages/opencode && bun test test/tool/graph-artifact-apply.test.ts`

Expected: FAIL because `graph_artifact_apply` does not exist.

- [ ] **Step 3: Implement path normalization**

In `util.ts`, add `resolveArtifactPaths(artifact, instance)`:
- reject absolute paths;
- reject `..` escapes;
- return absolute paths for FS operations and relative paths for permission patterns.

- [ ] **Step 4: Implement `graph_artifact_apply`**

Execution:
- resolve session/project;
- resolve paths;
- call `GraphBuild.Service.evaluate` with the artifact;
- if blocked, return JSON result and do not ask/write;
- ask permission `graph.artifact_write` with relative path patterns;
- read existing files with `FSUtil`;
- call `planArtifactApplication`;
- if invalid, record `GraphAudit.tool` blocked and return JSON result;
- write files with `FSUtil.writeWithDirs`;
- publish `FileSystem.Event.Edited` and `Watcher.Event.Updated`;
- update target node via `GraphStorage.Service.node.update(targetNodeID, { status: "implemented", testStatus: "pending" })`.

- [ ] **Step 5: Run GREEN**

Run: `cd packages/opencode && bun test test/tool/graph-artifact-apply.test.ts test/tool/graph-tools.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/tool/graph/artifact-apply.ts packages/opencode/src/tool/graph/index.ts packages/opencode/src/tool/graph/util.ts packages/opencode/test/tool/graph-artifact-apply.test.ts
git commit -m "feat(opencode): apply controlled graph artifacts"
```

---

### Task 4: Runtime Flag and Registry Graph Mode

**Files:**
- Modify: `packages/opencode/src/effect/runtime-flags.ts`
- Modify: `packages/opencode/src/tool/registry.ts`
- Test: `packages/opencode/test/tool/graph-mode.test.ts`

- [ ] **Step 1: Write failing registry tests**

Tests assert:
- default registry includes existing writable tools and does not include graph tools;
- with `RuntimeFlags.layer({ experimentalGraphMode: true })`, registry includes graph tools and excludes `shell`, `edit`, `write`, `apply_patch`.

- [ ] **Step 2: Run RED**

Run: `cd packages/opencode && bun test test/tool/graph-mode.test.ts`

Expected: FAIL because flag and registry wiring do not exist.

- [ ] **Step 3: Add runtime flag**

In `runtime-flags.ts`, add:

```ts
experimentalGraphMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_GRAPH_MODE"),
```

- [ ] **Step 4: Wire registry**

In `registry.ts`:
- import graph tools and helper predicate;
- initialize graph tools alongside builtins;
- when `flags.experimentalGraphMode`, filter builtins with `graphSafeBuiltin` and append graph tools;
- add graph service LayerNode dependencies.

- [ ] **Step 5: Run GREEN**

Run: `cd packages/opencode && bun test test/tool/graph-mode.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/effect/runtime-flags.ts packages/opencode/src/tool/registry.ts packages/opencode/test/tool/graph-mode.test.ts
git commit -m "feat(opencode): expose graph-safe tool mode"
```

---

### Task 5: Graph Workflow Prompt Injection

**Files:**
- Create: `packages/opencode/src/tool/graph/prompt.txt`
- Modify: `packages/opencode/src/session/instruction.ts`
- Test: `packages/opencode/test/session/graph-instruction.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Tests assert:
- default `Instruction.system()` does not include graph workflow text;
- graph mode includes graph workflow text containing `graph_plan_admit`, `graph_build_gate`, and `graph_artifact_apply`.

- [ ] **Step 2: Run RED**

Run: `cd packages/opencode && bun test test/session/graph-instruction.test.ts`

Expected: FAIL because prompt injection does not exist.

- [ ] **Step 3: Add prompt text**

Create `prompt.txt` with concise rules:
- plan first;
- gate before build;
- write only through artifact apply;
- never bypass stale/drift/gate blocks.

- [ ] **Step 4: Wire instruction system**

In `Instruction.system()`, append `GRAPH_WORKFLOW_PROMPT` when `flags.experimentalGraphMode` is true.

- [ ] **Step 5: Run GREEN**

Run: `cd packages/opencode && bun test test/session/graph-instruction.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/tool/graph/prompt.txt packages/opencode/src/session/instruction.ts packages/opencode/test/session/graph-instruction.test.ts
git commit -m "feat(opencode): add graph workflow instructions"
```

---

### Task 6: Final Verification and Integration

**Files:** all changed files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
cd packages/opencode && bun test test/tool/graph-mode.test.ts test/tool/graph-tools.test.ts test/tool/graph-artifact-apply.test.ts test/session/graph-instruction.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run package verification**

Run:

```bash
cd packages/core && bun typecheck && bun test test/graph-layer-node.test.ts test/graph-artifact.test.ts test/graph-build.test.ts test/graph-plan.test.ts
cd packages/opencode && bun typecheck
```

Expected: all pass.

- [ ] **Step 3: Merge and sync upstream**

Run:

```bash
git checkout dev
git merge --ff-only graph-tools
git fetch upstream
git merge upstream/dev --no-edit
```

Expected: feature branch fast-forwards; upstream merge is conflict-free or limited to known generated/lock files.

- [ ] **Step 4: Re-verify after merge**

Run:

```bash
cd packages/core && bun typecheck
cd packages/opencode && bun typecheck
```

Expected: both typechecks pass.

- [ ] **Step 5: Push and cleanup**

Run:

```bash
git push origin dev
git branch -d graph-tools
```

Expected: push succeeds; local feature branch deleted.
