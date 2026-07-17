import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import type { ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"
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
    const discovered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/product-migration/discover"))
    await page.getByRole("button", { name: "Discover OpenCode data" }).click()
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

    await page.goto("/new-session")
    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toBeVisible()

    await page.getByRole("button", { name: "Begin transfer" }).click()
    await expect(page.getByRole("status")).toContainText("Copy complete; validation required")
    await page.getByRole("button", { name: "Validate copied data" }).click()
    await expect(page.getByRole("status")).toContainText("Ready to finalize")
    await expect(page.getByRole("button", { name: /new session/i })).toHaveCount(0)
    await page.getByRole("button", { name: "Finalize validated import" }).click()
    await expect(page.getByRole("dialog")).toContainText("Finalize this import?")
    await page.getByRole("button", { name: "Confirm and unlock" }).click()

    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /new session/i })).toBeVisible()
    await page.goto("/new-session")
    await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
    expect(fixture.finalized).toBe(1)
  })
}

test("mobile migration uses step panels, 44px controls, and confirmed fresh start", async ({ page }) => {
  const fixture = await setup(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await page.getByRole("button", { name: "Discover OpenCode data" }).click()
  for (const name of ["Manifest", "Projects", "Sessions", "Review"]) {
    const step = page.getByRole("button", { name })
    expect((await step.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
  await page.getByRole("button", { name: "Sessions" }).click()
  await expect(page.getByText("Sessions are off")).toBeVisible()
  await page.getByRole("button", { name: "Review" }).click()
  const fresh = page.getByRole("button", { name: "Start fresh instead" })
  expect((await fresh.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await fresh.click()
  await expect(page.getByRole("dialog")).toContainText("Start without importing?")
  await page.getByRole("button", { name: "Confirm and unlock" }).click()
  await expect(page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /new session/i })).toBeVisible()
  expect(fixture.freshStarts).toBe(1)
})

test("stale revision refreshes the SDK projection before another action", async ({ page }) => {
  const fixture = await setup(page, "draft")
  fixture.conflictNextDraft()
  await page.goto("/")

  await page.getByLabel("Configuration").uncheck()
  await expect(page.getByRole("dialog")).toContainText("The transfer plan changed")
  await expect(page.getByRole("dialog")).toContainText("revision 3")
  await expect(page.getByRole("dialog")).toContainText("latest SDK projection")
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

async function setup(page: Page, initial: "undiscovered" | "draft" | "unavailable" = "undiscovered") {
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
      gets++
      return json(route, projection)
    }
    if (path.endsWith("/discover")) {
      discoveredProject = (route.request().postDataJSON() as { currentProject?: string }).currentProject
      projection = draft(1)
      return json(route, projection)
    }
    if (path.endsWith("/draft") && conflict) {
      conflict = false
      projection = draft(3)
      return json(route, { _tag: "ProductMigrationRevisionConflict", expectedRevision: 2, actualRevision: 3 }, 409)
    }
    if (path.endsWith("/draft")) return json(route, projection)
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
