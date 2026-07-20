# Graph Vibe Frontend Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Graph Vibe an authoritative Web identity, visible migration controls, and a no-model path from Home to an empty Graph workflow while preserving OpenCode behavior.

**Architecture:** The server publishes product identity through the existing health contract. The app derives a small product presentation from per-server health, reuses the existing product shell and UI Button system, and adds one Graph Vibe-only Home action that creates an empty session with a directory-scoped SDK client before navigating to Graph.

**Tech Stack:** TypeScript, Effect HttpApi, SolidJS, TanStack Solid Query, generated OpenCode Client/SDK, Bun test, Playwright.

---

## File Map

- `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`: health response schema.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`: authoritative product projection.
- `packages/opencode/test/server/httpapi-global.test.ts`: health contract coverage.
- `packages/client/src/generated/{client,types}.ts`: generated public Client output.
- `packages/sdk/js/src/v2/gen/{sdk.gen,types.gen}.ts`: generated legacy SDK output.
- `packages/app/src/utils/server-health.ts`: retain product identity per server.
- `packages/app/src/utils/product-presentation.ts`: pure fallback and Graph Vibe presentation rules.
- `packages/app/src/utils/product-presentation.test.ts`: presentation unit tests.
- `packages/app/src/context/product.tsx`: selected-server product accessor and document title.
- `packages/app/src/app.tsx`: install product presentation within the selected-server shell.
- `packages/app/src/pages/product-migration.tsx`: use supported button components and pending states.
- `packages/app/e2e/regression/product-migration.spec.ts`: visual and pending migration assertions.
- `packages/app/src/components/session/session-new-design-view.tsx`: product-aware new-session wordmark.
- `packages/app/src/pages/home-graph-vibe.tsx`: focused Graph Vibe Home call-to-action.
- `packages/app/src/pages/home-graph-vibe.test.ts`: pure Home action state tests.
- `packages/app/src/pages/home.tsx`: directory selection, empty-session creation, Graph navigation.
- `packages/app/src/pages/graph.tsx`: actionable empty Graph state.
- `packages/app/e2e/regression/graph-vibe-product-shell.spec.ts`: product identity and no-model flow.
- `packages/opencode/test/integration/product-isolation.test.ts`: live Graph Vibe health identity assertion.

### Task 1: Publish Product Identity Through Health

**Files:**

- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:12-15`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:69-77`
- Modify: `packages/opencode/test/server/httpapi-global.test.ts`
- Regenerate: `packages/client/src/generated/client.ts`
- Regenerate: `packages/client/src/generated/types.ts`
- Regenerate: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Regenerate: `packages/sdk/js/src/v2/gen/types.gen.ts`

- [ ] **Step 1: Write the failing health contract test**

Add an assertion to the existing health endpoint test:

```ts
expect(response.status).toBe(200)
expect(await response.json()).toEqual({
  healthy: true,
  version: expect.any(String),
  product: {
    id: "opencode",
    name: "OpenCode",
    capability: "The AI coding agent built for the terminal",
  },
})
```

Add a focused Graph Vibe process/layer assertion using `Product.layerWith(Product.GraphVibe)` when the existing test harness permits layer replacement; otherwise add it to `product-isolation.test.ts` where product-specific child processes already exist:

```ts
expect(await response.json()).toMatchObject({
  product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `packages/opencode`:

```bash
bun test test/server/httpapi-global.test.ts
```

Expected: FAIL because `product` is absent.

- [ ] **Step 3: Extend the schema and handler minimally**

In the group schema, add:

```ts
const GlobalProduct = Schema.Struct({
  id: Schema.Union([Schema.Literal("opencode"), Schema.Literal("graph-vibe")]),
  name: Schema.String,
  capability: Schema.String,
})

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  product: GlobalProduct,
})
```

In the handler, bind the service once and return the public projection:

```ts
const product = yield * Product.Service

const health = Effect.fn("GlobalHttpApi.health")(function* () {
  return {
    healthy: true as const,
    version: InstallationVersion,
    product: {
      id: product.profile.id,
      name: product.profile.name,
      capability: product.profile.capability,
    },
  }
})
```

- [ ] **Step 4: Regenerate public clients**

Run:

```bash
bun run generate
```

from `packages/client`, then:

```bash
./packages/sdk/js/script/build.ts
```

from the workspace root.

- [ ] **Step 5: Verify generated output and focused tests**

Run:

```bash
bun test test/server/httpapi-global.test.ts
bun typecheck
```

from `packages/opencode`, then `bun typecheck` from `packages/client` and `packages/sdk/js`.

Expected: all commands pass and generated types expose `product`.

- [ ] **Step 6: Commit when authorized**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/global.ts packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts packages/opencode/test/server/httpapi-global.test.ts packages/client/src/generated packages/sdk/js/src/v2/gen
git commit -m "feat(opencode): expose product health identity"
```

### Task 2: Derive the Selected-Server Product Shell

**Files:**

- Create: `packages/app/src/utils/product-presentation.ts`
- Create: `packages/app/src/utils/product-presentation.test.ts`
- Create: `packages/app/src/context/product.tsx`
- Modify: `packages/app/src/utils/server-health.ts:7,85-94`
- Modify: `packages/app/src/app.tsx`

- [ ] **Step 1: Write presentation and health propagation tests**

Cover explicit Graph Vibe and old-server fallback:

```ts
expect(resolveProductPresentation(undefined)).toEqual({
  id: "opencode",
  name: "OpenCode",
  capability: "The AI coding agent built for the terminal",
})

expect(
  resolveProductPresentation({
    id: "graph-vibe",
    name: "Graph Vibe",
    capability: "Graph-guided development",
  }),
).toEqual({
  id: "graph-vibe",
  name: "Graph Vibe",
  capability: "Graph-guided development",
})
```

Extend `server-health` tests so a successful SDK response retains `product`, while an old response without it remains healthy with `product === undefined`.

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/app`:

```bash
bun test src/utils/product-presentation.test.ts src/utils/server-health.test.ts
```

Expected: FAIL because the resolver and health product field do not exist.

- [ ] **Step 3: Implement the pure resolver**

Use one explicit fallback:

```ts
export type ProductPresentation = {
  id: "opencode" | "graph-vibe"
  name: string
  capability: string
}

const openCode: ProductPresentation = {
  id: "opencode",
  name: "OpenCode",
  capability: "The AI coding agent built for the terminal",
}

export function resolveProductPresentation(product?: ProductPresentation): ProductPresentation {
  if (product?.id === "graph-vibe") return product
  return openCode
}
```

- [ ] **Step 4: Preserve product in health state**

Change `ServerHealth` to include the optional generated health product type and map `x.data?.product` in `checkServerHealth`. Do not infer from the URL.

- [ ] **Step 5: Add the selected-server product accessor**

Create a small context that reads `global.servers.health[server.key]?.product`, resolves it, exposes `product()` and `graphVibe()`, and updates `document.title` reactively. Mount it inside the existing selected-server provider boundary so server changes update identity without remounting unrelated app state.

- [ ] **Step 6: Verify focused tests and App typecheck**

Run from `packages/app`:

```bash
bun test src/utils/product-presentation.test.ts src/utils/server-health.test.ts
bun typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit when authorized**

```bash
git add packages/app/src/utils/product-presentation.ts packages/app/src/utils/product-presentation.test.ts packages/app/src/context/product.tsx packages/app/src/utils/server-health.ts packages/app/src/app.tsx
git commit -m "feat(app): derive server product presentation"
```

### Task 3: Make Migration Actions Visibly Interactive

**Files:**

- Modify: `packages/app/src/pages/product-migration.tsx`
- Modify: `packages/app/e2e/regression/product-migration.spec.ts`
- Modify: `packages/app/test-browser/product-migration.test.ts`

- [ ] **Step 1: Add failing visual interaction assertions**

For `Discover OpenCode data`, assert semantic and computed visibility:

```ts
const discover = page.getByRole("button", { name: "Discover OpenCode data" })
await expect(discover).toBeVisible()
expect((await discover.boundingBox())?.height).toBeGreaterThanOrEqual(44)
await expect(discover).toHaveAttribute("data-variant", "primary")
expect(await discover.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
```

Delay the mocked discovery response and assert both actions are disabled and `Applying checkpoint action` is visible while pending.

- [ ] **Step 2: Run the regression test and verify RED**

Run from `packages/app`:

```bash
bunx playwright test e2e/regression/product-migration.spec.ts --project chromium
```

Expected: FAIL because the native button lacks `data-variant` and has transparent background.

- [ ] **Step 3: Replace unsupported primary classes with `Button`**

Import `Button` from `@opencode-ai/ui/button`. Convert discovery, confirmation, transfer, validation, resume, and finalization primary actions to:

```tsx
<Button
  type="button"
  size="large"
  variant="primary"
  disabled={props.controller.pending()}
  onClick={() => void props.controller.discover()}
>
  Discover OpenCode data
</Button>
```

Use `variant="secondary"` for fresh start, cancel, pause, retry, skip, and return-to-draft actions. Preserve `data-action`, ARIA labels, focus management, and confirmation behavior.

- [ ] **Step 4: Verify component and browser tests GREEN**

Run from `packages/app`:

```bash
bun test src/pages/product-migration.test.ts test-browser/product-migration.test.ts
bunx playwright test e2e/regression/product-migration.spec.ts --project chromium
bun typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit when authorized**

```bash
git add packages/app/src/pages/product-migration.tsx packages/app/e2e/regression/product-migration.spec.ts packages/app/test-browser/product-migration.test.ts
git commit -m "fix(app): restore migration action visibility"
```

### Task 4: Brand Graph Vibe New-Session and Home Surfaces

**Files:**

- Modify: `packages/app/src/components/session/session-new-design-view.tsx`
- Create: `packages/app/src/pages/home-graph-vibe.tsx`
- Create: `packages/app/src/pages/home-graph-vibe.test.ts`
- Modify: `packages/app/src/pages/home.tsx`
- Modify: `packages/app/e2e/regression/graph-vibe-product-shell.spec.ts`

- [ ] **Step 1: Write failing product-shell browser assertions**

Mock Graph Vibe health and assert:

```ts
await expect(page).toHaveTitle("Graph Vibe")
await expect(page.getByRole("heading", { name: "Graph Vibe" })).toBeVisible()
await expect(page.getByText("Graph-guided development")).toBeVisible()
await expect(page.getByRole("button", { name: "Start Graph Workflow" })).toBeVisible()
await expect(page.getByText("OpenCode", { exact: true })).toHaveCount(0)
```

Repeat with missing/explicit OpenCode product and assert the existing OpenCode wordmark remains and the Graph CTA is absent.

- [ ] **Step 2: Run the browser test and verify RED**

Run from `packages/app`:

```bash
bunx playwright test e2e/regression/graph-vibe-product-shell.spec.ts --project chromium
```

Expected: FAIL because the product shell and CTA do not exist.

- [ ] **Step 3: Add the Graph Vibe lockup**

In `session-new-design-view.tsx`, use the product accessor:

```tsx
<Show when={product.graphVibe()} fallback={<WordmarkV2 class="h-auto w-full text-v2-icon-icon-base" />}>
  <div aria-label="Graph Vibe" class="flex flex-col items-center text-center">
    <h1 class="text-32-medium tracking-tight text-text-strong">Graph Vibe</h1>
    <p class="mt-2 font-mono text-11-medium uppercase tracking-[0.2em] text-text-weak">Graph-guided development</p>
  </div>
</Show>
```

Keep the shared composer and layout unchanged.

- [ ] **Step 4: Add a focused Home CTA component**

Create `GraphVibeHomeAction` with only presentation props:

```ts
type GraphVibeHomeActionProps = {
  visible: boolean
  pending: boolean
  projectName?: string
  onStart: () => void
}
```

Render a primary `Start Graph Workflow` button, capability copy, selected-project context, and a pending `Creating workflow…` label. Unit-test hidden, ready, and pending states.

- [ ] **Step 5: Verify product shell tests GREEN before wiring navigation**

Run from `packages/app`:

```bash
bun test src/pages/home-graph-vibe.test.ts
bunx playwright test e2e/regression/graph-vibe-product-shell.spec.ts --project chromium
```

Expected: identity assertions pass; navigation assertions remain pending for Task 5.

- [ ] **Step 6: Commit when authorized**

```bash
git add packages/app/src/components/session/session-new-design-view.tsx packages/app/src/pages/home-graph-vibe.tsx packages/app/src/pages/home-graph-vibe.test.ts packages/app/src/pages/home.tsx packages/app/e2e/regression/graph-vibe-product-shell.spec.ts
git commit -m "feat(app): add graph vibe product shell"
```

### Task 5: Wire Home to an Empty Graph Session

**Files:**

- Modify: `packages/app/src/pages/home.tsx:431-465,542-665`
- Modify: `packages/app/src/pages/graph.tsx:183-185,246-257`
- Modify: `packages/app/e2e/regression/graph-vibe-product-shell.spec.ts`

- [ ] **Step 1: Add failing no-model navigation coverage**

Mock `POST /session`, count prompt/model endpoints, click the CTA, and assert:

```ts
await page.getByRole("button", { name: "Start Graph Workflow" }).click()
await expect(page).toHaveURL(/\/session\/ses_graph_smoke\/graph$/)
await expect(page.getByRole("heading", { name: "No plan admitted" })).toBeVisible()
await expect(page.getByRole("button", { name: "Describe a goal" })).toBeVisible()
expect(promptRequests).toBe(0)
```

Click `Describe a goal` and assert navigation returns to `/session/ses_graph_smoke`.

- [ ] **Step 2: Run the browser test and verify RED**

Run from `packages/app`:

```bash
bunx playwright test e2e/regression/graph-vibe-product-shell.spec.ts --project chromium
```

Expected: FAIL because the CTA is not wired and empty Graph has no action.

- [ ] **Step 3: Create the session with a directory-scoped client**

In Home, use the selected project or invoke the existing picker. For a resolved directory:

```ts
const ctx = global.ensureServerCtx(conn)
const client = ctx.sdk.createClient({ directory, throwOnError: true })
const session = await client.session.create({ title: "Graph workflow" })
ctx.projects.open(directory)
ctx.projects.touch(directory)
tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.data.id })
navigate(`${sessionHref(ServerConnection.key(conn), session.data.id)}/graph`)
```

Use the actual generated return shape after Task 1 regeneration. Guard duplicate clicks with one pending store field. On failure, clear pending and use the existing `showToast`/`errorMessage` pattern.

- [ ] **Step 4: Make the empty Graph actionable**

Pass an action to `GraphState`:

```tsx
<GraphState title="No plan admitted" detail={CURRENT_PLAN_EMPTY_MESSAGE}>
  <Button size="large" variant="primary" onClick={() => navigate(location.pathname.replace(/\/graph\/?$/, ""))}>
    Describe a goal
  </Button>
</GraphState>
```

Change `GraphState` so the action wrapper is rendered only when `children` exists, avoiding empty spacing.

- [ ] **Step 5: Verify the complete browser flow GREEN**

Run from `packages/app`:

```bash
bun test src/pages/home-graph-vibe.test.ts src/pages/graph-helpers.test.ts
bunx playwright test e2e/regression/graph-vibe-product-shell.spec.ts --project chromium
bun typecheck
```

Expected: PASS with zero prompt/model requests.

- [ ] **Step 6: Commit when authorized**

```bash
git add packages/app/src/pages/home.tsx packages/app/src/pages/graph.tsx packages/app/e2e/regression/graph-vibe-product-shell.spec.ts
git commit -m "feat(app): launch graph workflows from home"
```

### Task 6: Live Acceptance and Regression Gates

**Files:**

- Modify: `packages/opencode/test/integration/product-isolation.test.ts`
- Modify: `docs/graph-vibe/installation.md`
- Add evidence screenshots under: `artifacts/graph-vibe/frontend-usability/`

- [ ] **Step 1: Extend isolated runtime acceptance**

Assert the Graph Vibe process health response includes Graph Vibe product identity while the concurrent OpenCode process reports OpenCode. Preserve the existing distinct roots and ports.

- [ ] **Step 2: Run focused package tests**

Run:

```bash
bun test test/integration/product-isolation.test.ts test/server/httpapi-global.test.ts
bun typecheck
```

from `packages/opencode`, and:

```bash
bun test src/utils/product-presentation.test.ts src/pages/home-graph-vibe.test.ts src/pages/product-migration.test.ts
bunx playwright test e2e/regression/product-migration.spec.ts e2e/regression/graph-vibe-product-shell.spec.ts --project chromium
bun typecheck
```

from `packages/app`.

- [ ] **Step 3: Verify generation determinism**

Run Client and SDK generation a second time and assert:

```bash
git diff --exit-code -- packages/client/src/generated packages/sdk/js/src/v2/gen
```

Expected: no new diff after the second generation.

- [ ] **Step 4: Run a live no-model browser acceptance**

Start Graph Vibe with isolated XDG roots. Prefer loopback; exercise `0.0.0.0` only on a trusted host-private WSL network with firewall restrictions and a generated temporary password. This proves authentication, not transport confidentiality:

```bash
export OPENCODE_SERVER_PASSWORD="$(openssl rand -base64 48)"
graph-vibe web --hostname 0.0.0.0
```

Basic auth does not encrypt HTTP traffic. Never use this binding on an untrusted LAN; remote or non-private access requires a TLS-terminating authenticated reverse proxy or secure tunnel.

Use Playwright to:

1. Complete fresh start.
2. Confirm Graph Vibe title, lockup, and capability.
3. Select the current project.
4. Click `Start Graph Workflow`.
5. Confirm empty Graph and `Describe a goal`.
6. Return to the same session composer.
7. Capture 1440x900 and 390x844 screenshots.
8. Assert no `console.error`, page error, or model/prompt request.

- [ ] **Step 5: Update operator documentation**

Document the Home Graph entry and constrained WSL fallback:

```md
Prefer localhost forwarding. If it is unavailable, use `0.0.0.0` only with a temporary password on a trusted host-private, firewall-restricted WSL network; Basic auth does not encrypt traffic, and remote access requires TLS or a secure tunnel.
```

- [ ] **Step 6: Run final diff and package gates**

Run:

```bash
git diff --check
```

Then run `bun typecheck` from `packages/opencode`, `packages/client`, `packages/sdk/js`, and `packages/app`. Run the focused tests from Step 2 once more after documentation and generation.

Expected: all commands pass with zero failures.

- [ ] **Step 7: Commit when authorized**

```bash
git add packages/opencode/test/integration/product-isolation.test.ts docs/graph-vibe/installation.md artifacts/graph-vibe/frontend-usability
git commit -m "test: verify graph vibe frontend usability"
```
