import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/GraphWorkflowCockpit"
const projectID = "proj_graph_workflow_cockpit"
const sessionID = "ses_graph_workflow_cockpit"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

for (const route of ["source", "embedded"] as const) {
  test(`${route} route renders and updates the Graph workflow cockpit`, async ({ page }) => {
    const state = await setup(page, route === "embedded")
    await page.goto(
      route === "embedded"
        ? `/server/${base64Encode(server)}/session/${sessionID}/graph`
        : `/${base64Encode(directory)}/session/${sessionID}/graph`,
    )

    await expect(page.getByRole("region", { name: "Graph workflow cockpit" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Interface" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Build rail" })).toHaveAttribute("aria-current", "step")
    await expect(page.getByRole("button", { name: "Continue" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0)
    await expect(page.getByText("Rail remains visible at mobile width")).toBeVisible()

    await page.getByRole("button", { name: "Continue" }).first().click()
    await expect.poll(() => state.approvals).toBe(1)
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    const tasks = page.getByRole("tab", { name: "Tasks" })
    await tasks.focus()
    await tasks.press("ArrowRight")
    await expect(page.getByRole("tab", { name: "Graph" })).toBeFocused()
    await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true")
    for (const tab of await page.getByRole("tab").all()) {
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
  })
}

async function setup(page: Page, embedded: boolean) {
  let workflow = projection("checkpoint", "pending", 2)
  const state = { approvals: 0 }
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
    if (url.pathname === "/graph/workflow") {
      if (route.request().method() === "GET") return route.fulfill(json(workflow))
    }
    if (url.pathname === "/graph/workflow/approve") {
      state.approvals++
      workflow = projection("building", "approved", 3)
      return route.fulfill(json(workflow))
    }
    if (url.pathname === "/graph/current-plan" || url.pathname === "/graph/main") return route.fulfill(json(graph))
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

function projection(phase: "checkpoint" | "building", checkpoint: "pending" | "approved", revision: number) {
  return {
    mode: "module",
    revision,
    phase,
    checkpoint: {
      status: checkpoint,
      kind: checkpoint === "pending" ? "module" : null,
      scopeNodeID: checkpoint === "pending" ? "module" : null,
      scopeName: checkpoint === "pending" ? "Interface" : null,
      reason: checkpoint === "pending" ? "Review the verified module" : null,
    },
    currentTask: { ...task, current: true },
    progress: { total: 1, verified: 0, failed: 0, percent: 0 },
    tasks: [{ ...task, current: true }],
    modules: [{ id: "module", name: "Interface", status: "implemented", taskIDs: ["task"] }],
  }
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

function json(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) }
}
