import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/GraphWorkflowCockpit"
const projectID = "proj_graph_workflow_cockpit"
const sessionID = "ses_graph_workflow_cockpit"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

for (const route of ["source", "embedded"] as const) {
  test(`${route} route renders intentional loading state while workflow is delayed`, async ({ page }) => {
    const state = await setup(page, route === "embedded", "loading")
    await page.goto(routeUrl(route))

    await expect(page.getByRole("status")).toContainText("Calibrating workflow")
    await expect(page.getByRole("status")).toContainText("Loading tasks, authority, and verification evidence.")
    await expect(page.getByRole("region", { name: "Graph workflow cockpit" })).toHaveCount(0)
    state.releaseWorkflow()
    await expect(page.getByRole("region", { name: "Graph workflow cockpit" })).toBeVisible()
  })

  test(`${route} route renders explicit empty-plan guidance without execution actions`, async ({ page }) => {
    await setup(page, route === "embedded", "empty")
    await page.goto(routeUrl(route))

    await expect(page.getByRole("status")).toContainText("No plan admitted")
    await expect(page.getByRole("status")).toContainText(
      "No Current Plan nodes yet. Describe your goal in Graph Vibe to create a plan.",
    )
    await expect(page.getByLabel("Execution mode")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0)
    const describe = page.getByRole("button", { name: "Describe a goal", exact: true })
    await expect(describe).toBeVisible()
    expect((await describe.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await describe.click()
    await expect(page).toHaveURL(routeUrl(route).replace(/\/graph$/, ""))
  })

  test(`${route} route renders the complete Graph workflow cockpit state matrix`, async ({ page }) => {
    const state = await setup(page, route === "embedded")
    const url =
      route === "embedded"
        ? `/server/${base64Encode(server)}/session/${sessionID}/graph`
        : `/${base64Encode(directory)}/session/${sessionID}/graph`
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(url)

    await expect(page.getByRole("region", { name: "Graph workflow cockpit" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("button", { name: "Main" })).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByRole("button", { name: "Back to session" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Interface" })).toBeVisible()
    await expect(page.getByRole("button").filter({ hasText: "Build rail" })).toHaveAttribute("aria-current", "step")
    await expect(page.getByRole("button", { name: "Continue" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0)
    await expect(page.getByText("Rail remains visible at mobile width")).toBeVisible()
    expect(
      await page.evaluate(() => ({
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        cockpit:
          document.querySelector(".graph-cockpit")!.scrollWidth <=
          document.querySelector(".graph-cockpit")!.clientWidth,
      })),
    ).toEqual({ document: true, cockpit: true })

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.reload()
      await expect(page.getByRole("region", { name: "Graph workflow cockpit" })).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", colorScheme)
      expect(
        await page.evaluate((scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme),
      ).toBe(true)
    }

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.reload()
    await expect(page.getByLabel("Workflow graph canvas. Use the task rail for keyboard navigation.")).toHaveAttribute(
      "data-animation-active",
      "false",
    )

    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-reduced-transparency", value: "reduce" },
      ],
    })
    await page.reload()
    await expect(page.locator(".graph-page")).toHaveAttribute("data-reduced-transparency", "true")
    expect(
      await page
        .locator(".graph-glass")
        .first()
        .evaluate((element) => getComputedStyle(element).backdropFilter),
    ).not.toContain("blur")

    await cdp.send("Emulation.setEmulatedMedia", { features: [] })
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" })

    state.set("checkpoint")
    await page.setViewportSize({ width: 767, height: 900 })
    await page.reload()
    await page.getByRole("tab", { name: "Details" }).click()
    const continueAction = page.getByLabel("Details").getByRole("button", { name: "Continue" })
    await expect(continueAction).toBeEnabled()
    await continueAction.click()
    await expect.poll(() => state.approvals).toBe(1)
    await expect(page.getByRole("button", { name: "Pause" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 900 })

    await assertState(page, state, "mode-required", "Execution mode required", { mode: true })
    await assertState(page, state, "paused", "Workflow paused", { mode: true, continue: true })
    await assertState(page, state, "checkpoint", "Checkpoint waiting", { mode: true, continue: true })
    await assertState(page, state, "failed", "Workflow failed", {})
    await assertState(page, state, "complete", "Workflow complete", {})
    await assertState(page, state, "network-error", "Workflow unavailable", { retry: true })

    state.set("checkpoint")
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole("button", { name: "Main" }).click()
    await page.locator(".graph-task").filter({ hasText: "Released capability" }).click()
    await expect(page.getByRole("heading", { name: "Released capability" })).toBeVisible()
    await expect(page.getByText("Visible only in Main")).toBeVisible()
    await expect(page.getByRole("button", { name: "Build rail" })).toHaveCount(0)
    await expect(page.getByLabel("Execution mode")).toHaveCount(0)
    await page.getByRole("button", { name: "Plan" }).click()

    state.set("checkpoint")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    const tasks = page.getByRole("tab", { name: "Tasks" })
    await tasks.focus()
    await tasks.press("ArrowRight")
    await expect(page.getByRole("tab", { name: "Graph" })).toBeFocused()
    await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true")
    const canvas = page.getByLabel("Workflow graph canvas. Use the task rail for keyboard navigation.")
    await expect(canvas).toBeVisible()
    expect((await canvas.boundingBox())?.width).toBeGreaterThan(0)
    expect((await canvas.boundingBox())?.height).toBeGreaterThan(0)
    expect(
      await canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]),
    ).toEqual([expect.any(Number), expect.any(Number)])
    for (const tab of await page.getByRole("tab").all()) {
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    for (const action of await page
      .locator(".graph-cockpit button:visible, .graph-source-switch button:visible")
      .all()) {
      expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
  })
}

function routeUrl(route: "source" | "embedded") {
  return route === "embedded"
    ? `/server/${base64Encode(server)}/session/${sessionID}/graph`
    : `/${base64Encode(directory)}/session/${sessionID}/graph`
}

async function setup(page: Page, embedded: boolean, initialView: WorkflowView = "checkpoint") {
  let view = initialView
  let approvals = 0
  let releaseWorkflow = () => {}
  const workflowReady = new Promise<void>((resolve) => {
    releaseWorkflow = resolve
  })
  const state = {
    get approvals() {
      return approvals
    },
    set(next: WorkflowView) {
      view = next
    },
    releaseWorkflow,
  }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "graph-workflow-cockpit",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Graph workflow cockpit",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/global/product-migration")
      return route.fulfill(json({ _tag: "ProductMigrationUnavailable" }, 404))
    if (url.pathname === "/graph/workflow") {
      if (route.request().method() === "GET") {
        if (view === "loading") {
          await workflowReady
          view = "checkpoint"
        }
        if (view === "network-error")
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "offline" }),
          })
        return route.fulfill(json(projection(view)))
      }
    }
    if (url.pathname === "/graph/workflow/approve") {
      approvals++
      view = "building"
      return route.fulfill(json(projection(view)))
    }
    if (url.pathname === "/graph/current-plan")
      return route.fulfill(json(view === "empty" ? { nodes: [], edges: [] } : graph))
    if (url.pathname === "/graph/main") return route.fulfill(json(mainGraph))
    return route.fallback()
  })
  await page.addInitScript(
    ({ directory, embedded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: embedded } }))
      if (!embedded) return
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { [server]: [{ worktree: directory, expanded: true }] },
          lastProject: { [server]: directory },
        }),
      )
    },
    { directory, embedded, server },
  )
  return state
}

type WorkflowView =
  | "loading"
  | "empty"
  | "mode-required"
  | "paused"
  | "checkpoint"
  | "building"
  | "failed"
  | "complete"
  | "network-error"

function projection(view: Exclude<WorkflowView, "loading" | "network-error">) {
  if (view === "empty")
    return {
      mode: null,
      revision: 2,
      activeOperationKind: null,
      phase: "planning",
      checkpoint: { status: "none", kind: null, scopeNodeID: null, scopeName: null, reason: null },
      currentTask: null,
      progress: { total: 0, verified: 0, failed: 0, percent: 0 },
      tasks: [],
      modules: [],
      rollups: [],
    }
  const pending = view === "paused" || view === "checkpoint"
  const complete = view === "complete"
  const failed = view === "failed"
  const phase = view === "mode-required" ? "planning" : view === "building" ? "building" : pending ? "checkpoint" : view
  return {
    mode: view === "mode-required" ? null : "module",
    revision: 2,
    activeOperationKind: null,
    phase,
    checkpoint: {
      status: pending ? "pending" : "approved",
      kind: view === "paused" ? "pause" : view === "checkpoint" ? "module" : null,
      scopeNodeID: pending ? "module" : null,
      scopeName: pending ? "Interface" : null,
      reason: view === "paused" ? "Paused for review" : view === "checkpoint" ? "Review the verified module" : null,
    },
    currentTask: { ...task, current: true },
    progress: { total: 1, verified: complete ? 1 : 0, failed: failed ? 1 : 0, percent: complete ? 100 : 0 },
    tasks: [
      {
        ...task,
        current: true,
        status: complete ? "verified" : failed ? "implemented" : "pending",
        testStatus: complete ? "passed" : failed ? "failed" : "none",
      },
    ],
    modules: [
      {
        id: "module",
        name: "Interface",
        status: complete ? "verified" : failed ? "failed" : "implemented",
        taskIDs: ["task"],
      },
    ],
    rollups: [],
  }
}

async function assertState(
  page: Page,
  state: Awaited<ReturnType<typeof setup>>,
  view: WorkflowView,
  label: string,
  actions: { mode?: boolean; continue?: boolean; retry?: boolean },
) {
  state.set(view)
  await page.reload()
  await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
  if (actions.retry) {
    await expect(page.getByLabel("Execution mode")).toHaveCount(0)
  } else {
    await expect(page.getByLabel("Execution mode")).toBeEnabled({ enabled: actions.mode ?? false })
  }
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(actions.continue ? 2 : 0)
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(actions.retry ? 1 : 0)
}

const task = {
  id: "task",
  name: "Build rail",
  order: 1,
  moduleID: "module",
  moduleName: "Interface",
  status: "pending",
  testStatus: "none",
  buildable: true,
  verification: { criteria: ["Rail remains visible at mobile width"], diagnostics: [{ name: "test" }] },
  latestEvidence: null,
}

const graph = {
  nodes: [
    {
      id: "goal",
      name: "Workflow cockpit",
      type: "prd",
      level: "L1",
      status: "implemented",
      testStatus: "none",
      priority: null,
      sessionID,
      desc: "Keep workflow authority visible",
    },
    {
      id: "module",
      name: "Interface",
      type: "composite",
      level: "L1",
      status: "implemented",
      testStatus: "none",
      priority: null,
      sessionID,
    },
    {
      id: "task",
      name: "Build rail",
      type: "atomic",
      level: "L2",
      status: "pending",
      testStatus: "none",
      priority: null,
      sessionID,
    },
  ],
  edges: [
    { id: "contains-goal", sourceID: "goal", targetID: "module", relation: "contains" },
    { id: "contains-task", sourceID: "module", targetID: "task", relation: "contains" },
  ],
}

const mainGraph = {
  nodes: [
    {
      id: "main-only",
      name: "Released capability",
      type: "atomic",
      level: "L2",
      status: "verified",
      testStatus: "passed",
      priority: null,
      sessionID: null,
      desc: "Visible only in Main",
    },
  ],
  edges: [],
}

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) }
}
