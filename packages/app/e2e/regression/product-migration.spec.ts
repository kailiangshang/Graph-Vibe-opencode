import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import type { ProductMigrationDraftPayload, ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/GraphVibe/MigrationFixture"
const sessionID = "ses_migration_fixture"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

for (const route of ["source", "embedded"] as const) {
  test(`${route} route gates navigation through explicit finalization`, async ({ page }) => {
    const fixture = await setup(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(routeUrl(route))

    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toBeVisible()
    await expect(page.getByRole("button", { name: /new session/i })).toHaveCount(0)
    const discover = page.getByRole("button", { name: "Discover OpenCode data" })
    await expect(discover).toBeVisible()
    await expect(discover).toHaveAttribute("data-variant", "primary")
    expect((await discover.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await discover.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/)
    const discovered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/product-migration/discover"))
    await discover.click()
    await expect.poll(() => fixture.network).toContain("POST /global/product-migration/discover")
    expect(await (await discovered).json()).toMatchObject({ status: "draft" })

    await expect(page.getByText("OpenCode source")).toBeVisible()
    await expect(page.getByText("2.6 GB / 2 sessions")).toBeVisible()
    await expect(page.getByLabel("Configuration")).toBeChecked()
    await expect(page.getByLabel("Credentials")).toBeChecked()
    await expect(page.getByLabel("MCP connections")).toBeChecked()
    await expect(page.getByRole("checkbox", { name: "Import", exact: true })).not.toBeChecked()
    await expect(page.getByText("Inspect telemetry")).toBeVisible()
    await expect(page.getByText("12.1 KB", { exact: false })).toBeVisible()
    expect(await page.textContent("body")).not.toContain(fixture.secret)
    expect(fixture.discoveredProject).toBe(directory)

    fixture.blockNextAction("draft")
    const sessionImport = page.getByRole("checkbox", { name: "Import", exact: true })
    await sessionImport.focus()
    await page.keyboard.press("Space")
    await expect(page.getByText("Saving migration selection…", { exact: true })).toBeVisible()
    await expect(sessionImport).toBeDisabled()
    fixture.releaseAction()
    await expect(page.getByText("Saving migration selection…", { exact: true })).toHaveCount(0)
    await expect(sessionImport).toBeFocused()

    await page.goto("/new-session")
    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toBeVisible()

    fixture.blockNextAction("execute")
    await page.getByRole("button", { name: "Begin transfer" }).click()
    await expect(page.getByText("Beginning transfer…", { exact: true })).toBeVisible()
    fixture.releaseAction()
    await expect(page.getByRole("status")).toContainText("Copy complete; validation required")
    await expect(page.getByText("Beginning transfer…", { exact: true })).toHaveCount(0)
    fixture.blockNextAction("validate")
    const validate = page.getByRole("button", { name: "Validate copied data" })
    await validate.click()
    await expect(page.getByText("Validating copied data…", { exact: true })).toBeVisible()
    await expect(page.getByRole("status")).toContainText("Copy complete; validation required")
    await expect(validate).toBeVisible()
    await expect(validate).toBeDisabled()
    await expect(page.getByRole("button", { name: "Pause transfer" })).toHaveCount(0)
    await expect(page.getByRole("status")).not.toContainText("Transfer in progress")
    fixture.releaseAction()
    await expect(page.getByRole("status")).toContainText("Ready to finalize")
    await expect(page.getByText("Validating copied data…", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /new session/i })).toHaveCount(0)
    await page.getByRole("button", { name: "Finalize validated import" }).click()
    await expect(page.getByRole("dialog")).toContainText("Finalize this import?")
    fixture.blockNextAction("finalize")
    await page.getByRole("button", { name: "Confirm and unlock" }).click()
    await expect(page.getByText("Finalizing import…", { exact: true })).toBeVisible()
    fixture.releaseAction()

    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /new session/i })).toBeVisible()
    await page.goto("/new-session")
    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
    expect(fixture.finalized).toBe(1)
  })
}

test("mobile migration uses step panels, 44px controls, and confirmed fresh start", async ({ page }) => {
  const fixture = await setup(page, "undiscovered", true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const discover = page.getByRole("button", { name: "Discover OpenCode data" })
  const freshStart = page.getByRole("button", { name: "Start Graph Vibe fresh" })
  await expect(discover).toBeVisible()
  await expect(discover).toHaveAttribute("data-variant", "primary")
  expect((await discover.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect(await discover.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(/^(?:transparent|rgba\(0, 0, 0, 0\))$/)
  await discover.click()
  await expect(discover).toBeDisabled()
  await expect(freshStart).toBeDisabled()
  await expect(page.getByText("Discovering OpenCode data…", { exact: true })).toBeVisible()
  fixture.releaseDiscovery()
  await expect(page.getByText("OpenCode source")).toBeVisible()
  await expect(page.getByText("Discovering OpenCode data…", { exact: true })).toHaveCount(0)
  const reviewPanel = page.locator('[data-mobile-panel="review"]')
  await expect(reviewPanel).toBeHidden()
  fixture.blockNextAction("draft")
  const configuration = page.getByLabel("Configuration")
  await expect(configuration).toHaveAttribute("data-migration-category", "config")
  const originalConfiguration = await configuration.elementHandle()
  await configuration.focus()
  await page.keyboard.press("Space")
  await expect(page.getByText("Saving migration selection…", { exact: true })).toBeVisible()
  fixture.releaseAction()
  await expect(page.getByText("Saving migration selection…", { exact: true })).toHaveCount(0)
  expect(await originalConfiguration!.evaluate((input) => input.isConnected)).toBe(false)
  await expect(configuration).toBeFocused()

  await page.getByRole("button", { name: "Sessions" }).click()
  fixture.blockNextAction("draft")
  const sessionImport = page.getByRole("checkbox", { name: "Import", exact: true })
  await sessionImport.focus()
  await page.keyboard.press("Space")
  await expect(page.getByText("Saving migration selection…", { exact: true })).toBeVisible()
  await expect(sessionImport).toBeDisabled()
  await expect(reviewPanel).toBeHidden()
  fixture.releaseAction()
  await expect(page.getByText("Saving migration selection…", { exact: true })).toHaveCount(0)
  await expect(sessionImport).toBeEnabled()
  await expect(sessionImport).toBeFocused()

  fixture.blockNextAction("draft")
  const session = page.getByRole("checkbox", { name: /Inspect telemetry/ })
  await expect(session).toHaveAttribute("data-migration-project", "project-a")
  await expect(session).toHaveAttribute("data-migration-session", sessionID)
  const originalSession = await session.elementHandle()
  await session.focus()
  await page.keyboard.press("Space")
  await expect(page.getByText("Saving migration selection…", { exact: true })).toBeVisible()
  fixture.releaseAction()
  await expect(page.getByText("Saving migration selection…", { exact: true })).toHaveCount(0)
  expect(await originalSession!.evaluate((input) => input.isConnected)).toBe(false)
  await expect(session).toBeFocused()
  for (const name of ["Manifest", "Projects", "Sessions", "Review"]) {
    const step = page.getByRole("button", { name })
    expect((await step.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
  await page.getByRole("button", { name: "Sessions" }).click()
  await expect(page.getByText("Explicit import enabled")).toBeVisible()
  await page.getByRole("button", { name: "Review" }).click()
  const fresh = page.getByRole("button", { name: "Start fresh instead" })
  expect((await fresh.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await fresh.click()
  await expect(page.getByRole("dialog")).toContainText("Start without importing?")
  fixture.blockNextAction("fresh-start")
  await page.getByRole("button", { name: "Confirm and unlock" }).click()
  await expect(page.getByText("Starting Graph Vibe fresh…", { exact: true })).toBeVisible()
  fixture.releaseAction()
  await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /new session/i })).toBeVisible()
  expect(fixture.freshStarts).toBe(1)
})

test("stale revision refreshes the SDK projection before another action", async ({ page }) => {
  const fixture = await setup(page, "draft")
  fixture.conflictNextDraft()
  await page.goto("/")

  await page.getByLabel("Configuration").uncheck()
  const conflict = page.getByRole("dialog")
  await expect(conflict).toContainText("The transfer plan changed")
  await expect(conflict).toContainText("revision 3")
  await expect(conflict).toContainText("latest SDK projection")
  const review = conflict.getByRole("button")
  await expect(review).toHaveText("Review refreshed plan")
  await expect(review).toBeEnabled()
  await expect.poll(() => conflict.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true)
  fixture.blockNextRefresh()
  const refreshes = fixture.requests.filter((request) => request === "GET /global/product-migration").length
  await review.click()
  await expect(review).toBeDisabled()
  await expect(review).toHaveText("Refreshing checkpoint…")
  await expect.poll(() => fixture.requests.filter((request) => request === "GET /global/product-migration").length).toBe(refreshes + 1)
  await review.evaluate((button) => button.click())
  expect(fixture.requests.filter((request) => request === "GET /global/product-migration")).toHaveLength(refreshes + 1)
  fixture.releaseRefresh()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(fixture.gets).toBeGreaterThanOrEqual(2)
})

test("OpenCode unavailable response skips migration onboarding", async ({ page }) => {
  await setup(page, "unavailable")
  await page.goto("/")
  await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /new session/i })).toBeVisible()
})

test("legacy direct new-session route remains gated before finalization", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
  })
  await setup(page)
  await page.goto("/new-session")
  await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toBeVisible()
})

function routeUrl(route: "source" | "embedded") {
  if (route === "source") return "/"
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

async function setup(page: Page, initial: "undiscovered" | "draft" | "unavailable" = "undiscovered", delayDiscovery = false) {
  const network: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.includes("product-migration")) network.push(`${request.method()} ${url.pathname}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-a", worktree: directory, vcs: "git", name: "Migration Fixture" },
    sessions: [{ id: sessionID, title: "Existing session", directory, time: { created: 0, updated: 0 } }],
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })

  const secret = "sk-live-never-render"
  let projection = initial === "draft" ? draft(2) : undiscovered
  let conflict = false
  let finalized = 0
  let freshStarts = 0
  let gets = 0
  let discoveredProject: string | undefined
  let releaseDiscovery = () => {}
  const discoveryBlocked = delayDiscovery
    ? new Promise<void>((resolve) => {
        releaseDiscovery = resolve
      })
    : undefined
  let refreshBlocked: Promise<void> | undefined
  let resolveRefresh = () => {}
  let blockedAction: string | undefined
  let actionBlocked: Promise<void> | undefined
  let resolveAction = () => {}
  const requests: string[] = []

  await page.route("**/global/product-migration**", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "content-type",
        },
      })
    const path = new URL(route.request().url()).pathname
    if (initial === "unavailable")
      return json(route, { _tag: "ProductMigrationUnavailable" }, 404)
    if (path === "/global/product-migration") {
      const blocked = refreshBlocked
      refreshBlocked = undefined
      await blocked
      gets++
      return json(route, projection)
    }
    if (blockedAction && path.endsWith(`/${blockedAction}`)) {
      blockedAction = undefined
      const blocked = actionBlocked
      actionBlocked = undefined
      await blocked
    }
    if (path.endsWith("/discover")) {
      discoveredProject = (route.request().postDataJSON() as { currentProject?: string }).currentProject
      await discoveryBlocked
      projection = draft(1)
      return json(route, projection)
    }
    if (path.endsWith("/draft") && conflict) {
      conflict = false
      projection = draft(3)
      return json(route, { _tag: "ProductMigrationRevisionConflict", expectedRevision: 2, actualRevision: 3 }, 409)
    }
    if (path.endsWith("/draft")) {
      const payload = route.request().postDataJSON() as ProductMigrationDraftPayload
      const sessions = new Set(payload.sessions.filter((session) => session.selected).map((session) => `${session.projectID}\0${session.sessionID}`))
      projection = {
        ...projection,
        plan: projection.plan
          ? {
              ...projection.plan,
              categories: projection.plan.categories.map((item) => ({
                ...item,
                selected: payload.categories.find((candidate) => candidate.category === item.category)?.selected ?? item.selected,
              })),
              sessionsEnabled: payload.sessionsEnabled,
              projects: projection.plan.projects.map((project) => ({
                ...project,
                sessions: project.sessions.map((session) => ({
                  ...session,
                  selected: sessions.has(`${project.id}\0${session.id}`),
                })),
              })),
            }
          : null,
      }
      return json(route, projection)
    }
    if (path.endsWith("/execute")) {
      projection = { ...projection, status: "copying", completedItems: 4 }
      return json(route, projection)
    }
    if (path.endsWith("/validate")) {
      projection = { ...projection, status: "ready_to_finalize", canFinalize: true, validation: { valid: true, issues: [] } }
      return json(route, projection)
    }
    if (path.endsWith("/finalize")) {
      finalized++
      projection = { ...projection, status: "completed", canFinalize: false }
      return json(route, projection)
    }
    if (path.endsWith("/fresh-start")) {
      freshStarts++
      projection = { ...projection, status: "completed", canFinalize: false }
      return json(route, projection)
    }
    return json(route, projection)
  })

  return {
    secret,
    get finalized() {
      return finalized
    },
    get freshStarts() {
      return freshStarts
    },
    get gets() {
      return gets
    },
    get discoveredProject() {
      return discoveredProject
    },
    get requests() {
      return requests
    },
    get network() {
      return network
    },
    releaseDiscovery,
    blockNextAction(action: string) {
      blockedAction = action
      actionBlocked = new Promise<void>((resolve) => {
        resolveAction = resolve
      })
    },
    releaseAction() {
      resolveAction()
    },
    blockNextRefresh() {
      refreshBlocked = new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
    },
    releaseRefresh() {
      resolveRefresh()
    },
    conflictNextDraft() {
      conflict = true
    },
  }
}

const undiscovered: ProductMigrationProjection = {
  status: "undiscovered",
  revision: 0,
  source: null,
  plan: null,
  items: [],
  validation: null,
  completedItems: 0,
  totalItems: 0,
  canFinalize: false,
}

function draft(revision: number): ProductMigrationProjection {
  return {
    status: "draft",
    revision,
    source: { database: "C:/Users/test/.local/share/opencode/opencode.db", databaseBytes: 2_800_000_000, mixedGraph: true, sessionCount: 2 },
    plan: {
      revision,
      sourceFingerprint: "fixture-fingerprint",
      categories: [
        { category: "config", available: true, selected: true, estimatedBytes: 1_024 },
        { category: "credentials", available: true, selected: true, estimatedBytes: 2_048 },
        { category: "mcp", available: true, selected: true, estimatedBytes: 4_096 },
        { category: "project", available: true, selected: true, estimatedBytes: 8_192 },
        { category: "session", available: true, selected: false, estimatedBytes: 32_000 },
        { category: "graph", available: true, selected: false, estimatedBytes: 16_000 },
      ],
      sessionsEnabled: false,
      projects: [{ id: "project-a", path: directory, sessionCount: 2, estimatedBytes: 48_000, current: true, sessions: [{ id: sessionID, title: "Inspect telemetry", updatedAt: 1, estimatedBytes: 12_400, hasGraph: true, selected: false }] }],
      requiredBytes: 15_360,
    },
    items: [],
    validation: null,
    completedItems: 0,
    totalItems: 4,
    canFinalize: false,
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
