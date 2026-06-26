# Graph-Port Foundation — Strategic Principles

- **Date:** 2026-06-26
- **Status:** Decided (brainstorm session with user)
- **Governs:** all future graph-port sub-projects (each gets its own spec)

## Context

`graph-vibe-opencode` is a fork of `anomalyco/opencode` (TypeScript/Bun). The original
GVC (Go) was built on the premise "graph is THE truth, opencode-style tools are a
subservient backend." Rebasing onto the **real** opencode creates a conflict: opencode's
own session/agent loop is naturally the primary state. The five principles below resolve
that conflict and set the rules every graph-port feature must follow.

Original GVC vision reference: `/home/kailiangs/open-source-project/graph-vibe-coding`
(PRD §3.4.1). The original Go implementation is **not** reused; only its concepts are
ported onto the TS/Bun opencode base.

## 1. Architecture direction — Hybrid

opencode stays **primary**: its session, provider/model/connect system, and agent loop
remain the main state. A graph-driven **Plan/Build mode** is added on top.

Not "graph replaces opencode" (too invasive, fights upstream), not "graph is a pure
advisory plugin" (dilutes the core value). Hybrid: opencode for the everyday chat/tool
loop, an opt-in graph mode for disciplined, inspectable development.

## 2. Graph model — code is truth, graph is derived + annotated

Reject the original "graph is THE truth." **Code on disk is ground truth** (it must be —
git, editors, and other AI tools all agree on that). The graph is two parts:

- **Structural subgraph** — files / symbols / dependencies. Derivable from code, rebuilt
  via tree-sitter (opencode already ships tree-sitter).
- **Intent subgraph** — PRD nodes, CurrentPlan, decisions, audit trail. Things the code
  alone does not capture; append-only annotations.

## 3. Drift handling — soft reconciliation, never user-blocking

When code and graph diverge:

- Structural part **auto re-derives** (re-parse affected nodes).
- Intent part **degrades gracefully** — mismatched nodes flagged `stale / needs-review`,
  never "broken."
- Hard-block **only** at the CurrentPlan **Build gate** (submitting a controlled change).
  Daily chat / external edits are never blocked.

This deliberately **softens** original PRD F37 ("block if inconsistent"). Blocking users
on every drift is the root cause of the "graph becomes unmaintainable" failure mode.

## 4. Constraint asymmetry — user soft, agent hard

- **Users cannot be hard-constrained** (they own the filesystem, git, other editors and
  other AI tools). Drift from users is reconciled softly (principle 3).
- **The agent can be hard-constrained.** The LLM calls we make inside graph-mode have only
  one path to the world: our tool runtime.

## 5. Agent hard lock — tool affordance + runtime gate + prompt manual

"Hard-constraining the agent via prompt" is insufficient — a prompt is a *soft* constraint
on the LLM too (models drift, ignore instructions, hallucinate). The truly hard lock is
structural:

- **Tool affordance (hardest):** in Plan/Build mode the agent is given only graph-aware
  tools (no raw `write_file`; instead `graph.proposeChange`, `build.applyNode`, etc.). The
  model cannot call a tool that is not offered — independent of compliance.
- **Runtime gate (hard):** gated tools check CurrentPlan / sync state server-side before
  applying; violating tool-calls are refused — independent of compliance.
- **Prompt (soft, the manual):** explains the graph workflow, node model, and why
  plan-then-build, so the model rarely fights the gate. Lubrication, not the lock.

Split: **structural constraints** (no edits outside plan, must sync, node integrity) →
tool + gate, hard-enforced. **Behavioral / quality constraints** (reasoning style,
granularity, when to plan) → prompt, soft-guided.

Maps onto opencode's existing mechanisms: tool registry (swap in the gated set for
graph-mode), permissions (Build gate judged here), system-prompt / agents config (graph
workflow lives here).

## Why the graph cannot become unmaintainable

The structural subgraph is always rebuildable from code; the intent subgraph degrades to
stale flags instead of corrupting. Worst case = a batch of stale annotations needing
re-review, never a lock-out. Per-session snapshots + versioning isolate any damage; a
broken session can be dropped and rebuilt.

## Out of scope for this document

Node/edge model details, graph↔opencode storage mapping, CurrentPlan / Plan / Build /
Autopilot mechanics, structural derivation flow, web visualization, and the MVP slice.
Each is a separate spec in a future graph-port brainstorm, governed by these principles.
