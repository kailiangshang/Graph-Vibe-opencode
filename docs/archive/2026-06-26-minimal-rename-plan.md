# Minimal Dual-Name Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the fork to "Graph Vibe OpenCode" (dual-name, honoring upstream) with minimal churn and zero upstream-merge friction.

**Architecture:** Surface-only edits: root package identity + a `graph-vibe` bin/script alias + README brand/credit + a TUI logo subtitle. No scope/env/config-dir changes.

**Tech Stack:** Bun monorepo, TypeScript, yargs CLI.

**Spec:** `docs/archive/2026-06-26-minimal-rename-design.md`

---

### Task 1: Branch + root package identity

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Create the work branch off dev**

```bash
git checkout dev && git checkout -b rename-branding
```

- [ ] **Step 2: Rename root package + add `graph-vibe` dev script**

In `package.json` (root), change:
```json
  "name": "opencode",
```
to:
```json
  "name": "graph-vibe-opencode",
```

And directly under the `"dev"` script (line 9), add:
```json
    "graph-vibe": "bun run --cwd packages/opencode --conditions=browser src/index.ts",
```

- [ ] **Step 3: Verify JSON valid**

Run: `bun -e 'JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log("ok")'`
Expected: `ok`

---

### Task 2: `graph-vibe` bin alias

**Files:**
- Modify: `packages/opencode/package.json:18-20`

- [ ] **Step 1: Add the alias bin entry**

Change:
```json
  "bin": {
    "opencode": "./bin/opencode"
  },
```
to:
```json
  "bin": {
    "opencode": "./bin/opencode",
    "graph-vibe": "./bin/opencode"
  },
```

- [ ] **Step 2: Verify JSON valid**

Run: `bun -e 'JSON.parse(require("fs").readFileSync("packages/opencode/package.json","utf8")); console.log("ok")'`
Expected: `ok`

---

### Task 3: README brand + fork credit

**Files:**
- Modify: `README.md:10`

- [ ] **Step 1: Replace the tagline + add a tribute line**

Change line 10:
```html
<p align="center">The open source AI coding agent.</p>
```
to:
```html
<p align="center">Graph Vibe OpenCode — graph-driven development, forked from opencode.</p>
<p align="center"><sub>Forked from <a href="https://github.com/anomalyco/opencode">anomalyco/opencode</a>. Full credit to the upstream project.</sub></p>
```

---

### Task 4: TUI logo subtitle

**Files:**
- Modify: `packages/opencode/src/cli/ui.ts:48-104` (function `logo`)

- [ ] **Step 1: Add a subtitle constant + append it in both return paths**

Right after the `logo(pad?: string) {` line, add:
```ts
  const subtitle = "Graph Vibe OpenCode · forked from anomalyco/opencode"
```

In the **non-TTY branch**, change:
```ts
    return result.join("").trimEnd()
  }
```
to:
```ts
    return result.join("").trimEnd() + EOL + (pad ?? "") + subtitle
  }
```

In the **TTY branch** (final return), change:
```ts
  return result.join("").trimEnd()
}
```
to:
```ts
  return result.join("").trimEnd() + EOL + "\x1b[90m" + (pad ?? "") + subtitle + reset
}
```

> `reset` (`"\x1b[0m"`) is already in scope in the TTY branch (defined at the top of it). `\x1b[90m` = gray, matching the logo's left-half color.

---

### Task 5: Verify

- [ ] **Step 1: Non-interactive boot still works**

Run: `bun dev --version`
Expected: prints `local` (or a version) and exits 0.

- [ ] **Step 2: `graph-vibe` alias launches the same CLI**

Run: `bun run graph-vibe --version`
Expected: same as Step 1.

- [ ] **Step 3: Typecheck passes**

Run: `bun typecheck`
Expected: all tasks successful (the only `.ts` change is a string append in `ui.ts`).

- [ ] **Step 4: TUI still renders (optional, tmux)**

```bash
tmux new-session -d -s oc 'bun dev'
sleep 8
tmux capture-pane -pt oc | tail -15
tmux kill-session -t oc
```
Expected: the opencode ASCII logo with a gray "Graph Vibe OpenCode · forked from anomalyco/opencode" line beneath it.

---

### Task 6: Commit + push

- [ ] **Step 1: Commit the status doc separately (already written)**

```bash
git add docs/STATUS.md
git commit -m "docs: add project status and setup guide"
```

- [ ] **Step 2: Commit the rename**

```bash
git add package.json packages/opencode/package.json README.md packages/opencode/src/cli/ui.ts
git commit -m "chore: rebrand to Graph Vibe OpenCode (dual-name)"
```

- [ ] **Step 3: Push the branch**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git push -u origin rename-branding
```
(pre-push hook runs `bun typecheck`; bun must be on PATH)

---

## Self-Review

- **Spec coverage:** spec change-set items 1–5 → Tasks 1–4; acceptance (bun dev, graph-vibe alias, --version, build bin entries, git diff scope) → Task 5 + commit scope in Task 6. ✓
- **Placeholders:** none; all edits show exact strings. ✓
- **Type consistency:** `subtitle` constant defined once, used identically in both branches; `reset` already in scope. ✓
- **Scope:** touches exactly the 4 files listed in the spec + STATUS.md. ✓
