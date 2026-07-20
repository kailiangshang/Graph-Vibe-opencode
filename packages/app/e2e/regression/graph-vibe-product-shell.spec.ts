import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/GraphVibe/ProductShell"
const draftID = "draft_graph_vibe_product_shell"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const remoteServer = "http://127.0.0.1:4097"
const remoteDirectory = "/home/graph-vibe/product-shell"
const graphSessionID = "ses_graph_smoke"

test("Graph Vibe health presents the Graph Vibe home and new-session shell", async ({ page }) => {
  await setup(page, {
    healthy: true,
    product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
  })

  await page.goto("/")

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByText("Graph-guided development", { exact: true })).toBeVisible()
  const start = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await expect(start).toBeVisible()
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByRole("img", { name: "OpenCode", exact: true })).toHaveCount(0)

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toBeVisible()
  await expect(page.getByText("Graph-guided development", { exact: true })).toBeVisible()
  await expect(page.getByRole("img", { name: "OpenCode", exact: true })).toHaveCount(0)
})

test("production legacy layout setting still selects the Graph Vibe Home", async ({ page }) => {
  await setup(
    page,
    { healthy: true, product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" } },
    { draft: false, newLayoutDesigns: false, projects: false },
  )
  await page.goto("/")

  expect(
    await page.evaluate(() => ({
      applied: document.body.hasAttribute("data-new-layout"),
      stored: JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general?.newLayoutDesigns,
    })),
  ).toEqual({ applied: true, stored: false })
  await expect(page).toHaveURL(/\/$/)
  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toBeVisible()
  await expect(page.getByText("Graph-guided development", { exact: true })).toBeVisible()
  await expect(page.locator('svg[viewBox="0 0 234 42"]')).toHaveCount(0)
})

test("production legacy layout setting keeps the OpenCode Home for OpenCode", async ({ page }) => {
  await setup(
    page,
    { healthy: true, product: { id: "opencode", name: "OpenCode", capability: "ignored" } },
    { draft: false, newLayoutDesigns: false, projects: false },
  )
  await page.goto("/")

  await expect(page).toHaveURL(/\/$/)
  await expect(page).toHaveTitle("OpenCode")
  await expect(page.locator('svg[viewBox="0 0 234 42"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toHaveCount(0)
})

test("production legacy preference keeps Graph layout through launch and composer return", async ({ page }) => {
  const launch = await setupGraphLaunch(page, { newLayoutDesigns: false })
  await page.goto("/")

  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()
  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()

  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Describe a goal", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}$`))
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
  expect(launch.sessionCreates).toBe(1)
})

test("Graph Vibe creates an empty session and opens Graph without a model request", async ({ page }) => {
  const launch = await setupGraphLaunch(page)
  await page.goto("/")

  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()
  const start = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await expect(start).toBeVisible()
  await start.click()

  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("No Current Plan nodes yet")
  await expect(page.getByRole("button", { name: "Describe a goal", exact: true })).toBeVisible()
  expect(launch.sessionCreates).toBe(1)
  expect(launch.createBodies).toEqual([{ title: "Graph workflow" }])
  expect(launch.endpointRequests.historyGet).toBe(1)
  expect(launch.endpointRequests.messagePromptPost).toBe(0)
  expect(launch.endpointRequests.promptAsyncPost).toBe(0)
  expect(launch.endpointRequests.v2PromptPost).toBe(0)
  expect(launch.endpointRequests.modelPost).toBe(0)
  expect(launch.endpointRequests.providerPost).toBe(0)

  await page.getByRole("button", { name: "Describe a goal", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}$`))
})

test("mobile Graph composer does not overlap the global help control", async ({ page }) => {
  await setupGraphLaunch(page)
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()
  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()
  await page.getByRole("button", { name: "Describe a goal", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })

  const help = await page.getByRole("link", { name: "Open the OpenCode website" }).boundingBox()
  const submit = await page.locator('[data-action="prompt-submit"]').boundingBox()
  if (!help || !submit) throw new Error("Expected visible help and prompt submit controls")
  const overlap =
    Math.max(0, Math.min(help.x + help.width, submit.x + submit.width) - Math.max(help.x, submit.x)) *
    Math.max(0, Math.min(help.y + help.height, submit.y + submit.height) - Math.max(help.y, submit.y))

  expect(overlap).toBe(0)
})

test("Graph Vibe continues workflow creation after selecting a project from the picker", async ({ page }) => {
  const launch = await setupGraphLaunch(page)
  await page.goto("/")

  const shell = page.getByRole("region", { name: "Graph Vibe workflow" })
  await expect(shell).not.toContainText("Selected project")
  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()

  await expect(page.getByRole("dialog")).toContainText("Open project")
  await page.getByRole("dialog").getByRole("button", { name: /ProductShell/ }).click()

  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  await expect(page.getByRole("button", { name: "Describe a goal", exact: true })).toBeVisible()
  expect(launch.sessionCreates).toBe(1)
  expect(launch.endpointRequests.historyGet).toBe(1)
  expect(launch.endpointRequests.messagePromptPost).toBe(0)
  expect(launch.endpointRequests.promptAsyncPost).toBe(0)
  expect(launch.endpointRequests.v2PromptPost).toBe(0)
  expect(launch.endpointRequests.modelPost).toBe(0)
  expect(launch.endpointRequests.providerPost).toBe(0)
})

test("cancelling the Graph Vibe project picker remains on Home without creating a session", async ({ page }) => {
  const launch = await setupGraphLaunch(page)
  await page.goto("/")

  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Open project")
  await page.keyboard.press("Escape")

  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  expect(launch.sessionCreates).toBe(0)
})

test("Graph Vibe prevents duplicate session creation while launch is pending", async ({ page }) => {
  let releaseCreate = () => {}
  const waitForCreate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  const launch = await setupGraphLaunch(page, { beforeCreate: () => waitForCreate })
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()

  const start = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await start.click()
  const pending = page.getByRole("button", { name: "Creating workflow…", exact: true })
  await expect(pending).toBeDisabled()
  await pending.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  expect(launch.sessionCreates).toBe(1)

  releaseCreate()
  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  expect(launch.sessionCreates).toBe(1)
})

test("Graph Vibe remains pending while the target route is suspended", async ({ page }) => {
  let releaseTarget = () => {}
  const waitForTarget = new Promise<void>((resolve) => {
    releaseTarget = resolve
  })
  const launch = await setupGraphLaunch(page, { beforeTargetSession: () => waitForTarget })
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()

  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()
  await expect.poll(() => launch.targetSessionReads).toBeGreaterThan(0)
  const pending = page.getByRole("button", { name: "Creating workflow…", exact: true })
  await expect(pending).toBeDisabled()
  await pending.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  await page.waitForTimeout(100)
  expect(launch.sessionCreates).toBe(1)

  releaseTarget()
  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  expect(launch.sessionCreates).toBe(1)
})

test("Graph Vibe adopts the created session when target preload fails transiently", async ({ page }) => {
  const launch = await setupGraphLaunch(page, { failTargetSessionOnce: true })
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()

  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()

  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(server)}/session/${graphSessionID}/graph$`),
  )
  await expect(page.getByRole("button", { name: "Describe a goal", exact: true })).toBeVisible()
  await expect.poll(() => launch.targetSessionReads).toBeGreaterThanOrEqual(2)
  expect(launch.sessionCreates).toBe(1)
  await expect(page.locator('[data-component="toast-v2"]').filter({ hasText: "Request failed" })).toHaveCount(0)
})

test("Graph Vibe launch failure remains atomic and allows retry", async ({ page }) => {
  const launch = await setupGraphLaunch(page, { failCreate: true })
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Product Shell" }).click()

  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toBeEnabled()
  await expect(page.locator('[data-component="toast-v2"]')).toContainText("Request failed")
  await expect(page.locator('[data-component="toast-v2"]')).toContainText("Graph launch failed")
  expect(launch.sessionCreates).toBe(1)
  expect(launch.endpointRequests.historyGet).toBe(0)
  expect(launch.endpointRequests.messagePromptPost).toBe(0)
  expect(launch.endpointRequests.promptAsyncPost).toBe(0)
  expect(launch.endpointRequests.v2PromptPost).toBe(0)
  expect(launch.endpointRequests.modelPost).toBe(0)
  expect(launch.endpointRequests.providerPost).toBe(0)
  expect(
    await page.evaluate((sessionID) => localStorage.getItem("opencode.window.browser.dat:tabs")?.includes(sessionID), graphSessionID),
  ).toBe(false)
})

test("retained Graph Vibe identity disables workflow actions while its server is unavailable", async ({ page }) => {
  let pickerRequests = 0
  let sessionCreates = 0
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/session") sessionCreates++
  })
  await setup(
    page,
    { healthy: false, product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" } },
    {
      projects: false,
      findFiles: () => {
        pickerRequests++
        return []
      },
    },
  )
  await page.goto("/")

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByText("Server unavailable", { exact: true })).toBeVisible()
  const start = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await expect(start).toBeVisible()
  await expect(start).toBeDisabled()
  await start.evaluate((button: HTMLButtonElement) => button.click())

  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(pickerRequests).toBe(0)
  expect(sessionCreates).toBe(0)
})

test("Graph Vibe product shell remains bounded at a mobile viewport", async ({ page }) => {
  await setup(page, {
    healthy: true,
    product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const action = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await expect(action).toBeVisible()
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expectNoHorizontalOverflow(page, '[aria-label="Graph Vibe workflow"]')

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toBeVisible()
  await expect(page.getByText("Graph-guided development", { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page, '[data-component="graph-vibe-lockup"]')
})

for (const health of [{ healthy: true, product: { id: "opencode", name: "OpenCode", capability: "ignored" } }, { healthy: true }]) {
  test(`${"product" in health ? "explicit" : "missing"} OpenCode product retains the OpenCode shell`, async ({ page }) => {
    await setup(page, health)

    await page.goto("/")

    await expect(page).toHaveTitle("OpenCode")
    await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toHaveCount(0)

    await page.goto(`/new-session?draftId=${draftID}`)

    await expect(page).toHaveTitle("OpenCode")
    await expect(page.getByRole("img", { name: "OpenCode", exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toHaveCount(0)
  })
}

test("mixed-server home hides the Graph CTA when its focused target is OpenCode", async ({ page }) => {
  await setupMixedServers(page, {
    local: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    remote: undefined,
  })
  await page.goto("/")

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toBeVisible()

  await page.getByText("127.0.0.1:4097", { exact: true }).click()

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toHaveCount(0)
})

test("mixed-server home opens Graph using its focused Graph Vibe server", async ({ page }) => {
  let sessionCreates = 0
  await setupMixedServers(page, {
    local: undefined,
    remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== remoteServer) return route.fallback()
    if (url.pathname === "/session" && route.request().method() === "POST") {
      sessionCreates++
      return json(route, graphSession(remoteDirectory, "project-remote"))
    }
    if (url.pathname === `/session/${graphSessionID}`)
      return json(route, graphSession(remoteDirectory, "project-remote"))
    if (url.pathname === "/graph/current-plan" || url.pathname === "/graph/main")
      return json(route, { nodes: [], edges: [] })
    if (url.pathname === "/graph/workflow") return json(route, emptyWorkflow)
    return route.fallback()
  })
  await page.goto("/")

  await expect(page).toHaveTitle("OpenCode")
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toHaveCount(0)

  await page.getByText("127.0.0.1:4097", { exact: true }).click()
  await page.locator('[data-component="home-project-row"]').filter({ hasText: "Remote Product" }).click()
  await page.getByRole("button", { name: "Start Graph Workflow", exact: true }).click()

  await expect(page).toHaveURL(
    new RegExp(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}/graph$`),
  )
  await expect(page).toHaveTitle("Graph Vibe")
  expect(sessionCreates).toBe(1)
})

test("stable OpenCode active server waits for a persisted Graph Vibe draft product", async ({ page }) => {
  const health = Promise.withResolvers<void>()
  await setupMixedServers(
    page,
    {
      local: undefined,
      remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { draft: true, newLayoutDesigns: false, remoteHealth: health.promise },
  )

  await page.goto(`/new-session?draftId=${draftID}`)
  await page.waitForTimeout(100)
  expect(new URL(page.url()).pathname).toBe("/new-session")
  health.resolve()

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toBeVisible()
  await expect(page.getByText("Graph-guided development", { exact: true })).toBeVisible()
})

test("trailing-slash Graph Vibe draft owns one target shell", async ({ page }) => {
  await setup(
    page,
    {
      healthy: true,
      product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { newLayoutDesigns: false },
  )

  await page.goto(`/new-session/?draftId=${draftID}`)

  await expect(page).toHaveTitle("Graph Vibe")
  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(1)
  await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toHaveCount(1)
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(1)
})

test("stable OpenCode active server waits for a direct Graph Vibe target route", async ({ page }) => {
  const health = Promise.withResolvers<void>()
  await setupMixedServers(
    page,
    {
      local: undefined,
      remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { newLayoutDesigns: false, remoteHealth: health.promise, remoteSession: true, localProjects: false },
  )
  const graphURL = `/server/${base64Encode(remoteServer)}/session/${graphSessionID}/graph`

  await page.goto("/")
  await expect(page).toHaveTitle("OpenCode")
  await expectBodyDesign(page, false)
  await navigateClient(page, graphURL)
  await page.waitForTimeout(100)
  expect(new URL(page.url()).pathname).toBe(graphURL)
  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toHaveCount(0)
  health.resolve()

  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toBeVisible()
  await expectBodyDesign(page, true)

  await page.goBack()
  await expect(page).toHaveURL("/")
  await expectBodyDesign(page, false)
  await expect(page).toHaveTitle("OpenCode")

  await navigateClient(page, graphURL)
  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Describe a goal", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}$`))
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})

test("stable OpenCode target session renders directly in the target legacy shell", async ({ page }) => {
  await setupMixedServers(page, { local: undefined, remote: undefined }, { newLayoutDesigns: false, remoteSession: true })
  const targetURL = `/server/${base64Encode(remoteServer)}/session/${graphSessionID}`

  await page.goto(targetURL)

  await expect(page).toHaveURL(targetURL)
  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Start Graph Workflow", exact: true })).toHaveCount(0)
})

test("Graph Vibe root renders a delayed OpenCode target in one target-scoped legacy shell", async ({ page }) => {
  const health = Promise.withResolvers<void>()
  const mixed = await setupMixedServers(
    page,
    {
      local: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
      remote: undefined,
    },
    { newLayoutDesigns: false, remoteHealth: health.promise, remoteSession: true },
  )
  const targetURL = `/server/${base64Encode(remoteServer)}/session/${graphSessionID}`

  await page.goto("/")
  await expect(page).toHaveTitle("Graph Vibe")
  await expectBodyDesign(page, true)
  await navigateClient(page, targetURL)
  await page.waitForTimeout(100)
  expect(new URL(page.url()).pathname).toBe(targetURL)
  health.resolve()

  await expect(page).toHaveURL(targetURL)
  await expect(page).toHaveTitle("OpenCode")
  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(1)
  await expect(page.getByText("Graph workflow", { exact: true }).first()).toBeVisible()
  await expectBodyDesign(page, false)
  expect(mixed.requests.filter((url) => url.includes(`/session/${graphSessionID}`)).every((url) => url.startsWith(remoteServer))).toBe(true)

  await page.goBack()
  await expect(page).toHaveURL("/")
  await expect(page).toHaveTitle("Graph Vibe")
  await expectBodyDesign(page, true)

  await navigateClient(page, targetURL)
  await expect(page.getByText("Graph workflow", { exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  const targetProject = page.getByRole("button", { name: "Remote Product", exact: true }).first()
  await expect(targetProject).toBeVisible()
  await targetProject.click()
  await expect(page).toHaveURL(targetURL)
  await expect(page).toHaveTitle("OpenCode")
  expect(mixed.requests.filter((url) => url.includes(`/session/${graphSessionID}`)).every((url) => url.startsWith(remoteServer))).toBe(true)
  expect(mixed.requests.some((url) => url.startsWith(server) && url.includes(encodeURIComponent(remoteDirectory)))).toBe(false)
})

test("Graph Vibe root renders an OpenCode persisted draft through the target legacy shell", async ({ page }) => {
  const health = Promise.withResolvers<void>()
  const mixed = await setupMixedServers(
    page,
    {
      local: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
      remote: undefined,
    },
    { draft: true, newLayoutDesigns: false, remoteHealth: health.promise },
  )

  await page.goto(`/new-session?draftId=${draftID}`)
  await page.waitForTimeout(100)
  expect(new URL(page.url()).pathname).toBe("/new-session")
  health.resolve()

  await expect(page).toHaveURL(`/new-session?draftId=${draftID}`)
  await expect(page).toHaveTitle("OpenCode")
  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(1)
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
  await expect(page.getByRole("heading", { name: "Graph Vibe", exact: true })).toHaveCount(0)
  expect(mixed.requests.filter((url) => url.includes(`directory=${encodeURIComponent(remoteDirectory)}`)).every((url) => url.startsWith(remoteServer))).toBe(true)
})

test("target provider state survives a reactive product health refresh", async ({ page }) => {
  const mixed = await setupMixedServers(
    page,
    {
      local: undefined,
      remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { newLayoutDesigns: false, remoteSession: true },
  )

  await page.goto(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}`)
  const input = page.locator('[data-component="prompt-input"]')
  await expect(input).toBeVisible()
  await input.focus()
  await page.keyboard.type("state survives health")
  await expect(input).toHaveText("state survives health")
  await input.evaluate((element) => element.setAttribute("data-health-marker", "mounted"))

  mixed.setRemoteProduct({ id: "graph-vibe", name: "Graph Vibe Refreshed", capability: "Updated capability" })
  await expect.poll(() => mixed.remoteHealthReads(), { timeout: 15_000 }).toBeGreaterThan(1)

  await expect(page).toHaveTitle("Graph Vibe Refreshed")
  await expect(input).toHaveAttribute("data-health-marker", "mounted")
  await expect(input).toHaveText("state survives health")
  await expectBodyDesign(page, true)
})

test("Graph Vibe target session uses the target new-layout error fallback", async ({ page }) => {
  await setupMixedServers(
    page,
    {
      local: undefined,
      remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { newLayoutDesigns: false, remoteSessionError: true },
  )

  await page.goto(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}`)

  await expect(page.getByText("This session cannot be found", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toHaveCount(0)
  await expectBodyDesign(page, true)
})

test("OpenCode target session uses the target legacy error fallback", async ({ page }) => {
  await setupMixedServers(
    page,
    {
      local: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
      remote: undefined,
    },
    { newLayoutDesigns: false, remoteSessionError: true },
  )

  await page.goto(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}`)

  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toHaveCount(0)
  await expectBodyDesign(page, false)
})

test("Graph Vibe target Graph URL keeps target ownership for lineage errors", async ({ page }) => {
  await setupMixedServers(
    page,
    {
      local: undefined,
      remote: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { newLayoutDesigns: false, remoteSessionError: true },
  )

  await page.goto(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}/graph`)

  await expect(page).toHaveTitle("Graph Vibe")
  await expectBodyDesign(page, true)
  await expect(page.getByText("This session cannot be found", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toHaveCount(0)
})

test("OpenCode target Graph URL keeps inverse target ownership for lineage errors", async ({ page }) => {
  await setupMixedServers(
    page,
    {
      local: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
      remote: undefined,
    },
    { newLayoutDesigns: false, remoteSessionError: true },
  )

  await page.goto(`/server/${base64Encode(remoteServer)}/session/${graphSessionID}/graph`)

  await expect(page).toHaveTitle("OpenCode")
  await expectBodyDesign(page, false)
  await expect(page.getByRole("heading", { name: "Something went wrong", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toHaveCount(0)
})

async function setup(
  page: Page,
  health: object,
  options: { draft?: boolean; projects?: boolean; findFiles?: () => unknown; newLayoutDesigns?: boolean } = {},
) {
  await page.addInitScript(
    ({ directory, draft, draftID, server, projects, newLayoutDesigns }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: projects ? [{ worktree: directory, expanded: true }] : [] },
          lastProject: projects ? { local: directory } : {},
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(draft ? [{ type: "draft", draftID, server, directory }] : []),
      )
    },
    {
      directory,
      draft: options.draft !== false,
      draftID,
      server,
      projects: options.projects !== false,
      newLayoutDesigns: options.newLayoutDesigns ?? true,
    },
  )
  await mockOpenCodeServer(page, {
    health,
    directory,
    project: {
      id: "project-product-shell",
      worktree: directory,
      vcs: "git",
      name: "Product Shell",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    findFiles: options.findFiles,
    pageMessages: () => ({ items: [] }),
  })
  if (options.projects === false) {
    await page.route("**/project**", (route) => {
      const url = new URL(route.request().url())
      if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
      return json(route, url.pathname === "/project" ? [] : {})
    })
  }
  await page.route("**/global/product-migration**", (route) => unavailable(route))
}

async function setupGraphLaunch(
  page: Page,
  options: {
    beforeCreate?: () => Promise<void>
    beforeTargetSession?: () => Promise<void>
    failCreate?: boolean
    failTargetSessionOnce?: boolean
    newLayoutDesigns?: boolean
  } = {},
) {
  let sessionCreates = 0
  let targetSessionReads = 0
  let created = false
  const createBodies: unknown[] = []
  const endpointRequests = {
    historyGet: 0,
    messagePromptPost: 0,
    promptAsyncPost: 0,
    v2PromptPost: 0,
    modelPost: 0,
    providerPost: 0,
  }
  const session = graphSession(directory, "project-product-shell")
  await setup(
    page,
    {
      healthy: true,
      product: { id: "graph-vibe", name: "Graph Vibe", capability: "Graph-guided development" },
    },
    { findFiles: () => [], newLayoutDesigns: options.newLayoutDesigns },
  )
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== server) return route.fallback()
    if (request.method() === "GET" && url.pathname === `/session/${graphSessionID}/message`)
      endpointRequests.historyGet++
    if (request.method() === "POST" && url.pathname === `/session/${graphSessionID}/message`)
      endpointRequests.messagePromptPost++
    if (request.method() === "POST" && url.pathname === `/session/${graphSessionID}/prompt_async`)
      endpointRequests.promptAsyncPost++
    if (request.method() === "POST" && url.pathname === `/api/session/${graphSessionID}/prompt`)
      endpointRequests.v2PromptPost++
    if (
      request.method() === "POST" &&
      (url.pathname === `/api/session/${graphSessionID}/model` || url.pathname.startsWith("/api/model"))
    )
      endpointRequests.modelPost++
    if (
      request.method() === "POST" &&
      (url.pathname.startsWith("/api/provider") || url.pathname.startsWith("/provider/"))
    )
      endpointRequests.providerPost++
    if (url.pathname === "/session" && request.method() === "POST") {
      sessionCreates++
      createBodies.push(request.postDataJSON())
      await options.beforeCreate?.()
      if (options.failCreate) return json(route, { message: "Graph launch failed" }, 500)
      created = true
      return json(route, session)
    }
    if (url.pathname === "/session" && request.method() === "GET") return json(route, created ? [session] : [])
    if (url.pathname === `/session/${graphSessionID}`) {
      targetSessionReads++
      await options.beforeTargetSession?.()
      if (options.failTargetSessionOnce && targetSessionReads === 1)
        return json(route, { message: "Target session temporarily unavailable" }, 503)
      return json(route, session)
    }
    if (url.pathname === "/graph/current-plan" || url.pathname === "/graph/main")
      return json(route, { nodes: [], edges: [] })
    if (url.pathname === "/graph/workflow") return json(route, emptyWorkflow)
    return route.fallback()
  })
  return {
    get sessionCreates() {
      return sessionCreates
    },
    get targetSessionReads() {
      return targetSessionReads
    },
    createBodies,
    endpointRequests,
  }
}

function graphSession(worktree: string, projectID: string) {
  return {
    id: graphSessionID,
    slug: graphSessionID,
    projectID,
    directory: worktree,
    title: "Graph workflow",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

const emptyWorkflow = {
  mode: null,
  revision: 1,
  activeOperationKind: null,
  phase: "planning",
  checkpoint: { status: "none", kind: null, scopeNodeID: null, scopeName: null, reason: null },
  currentTask: null,
  progress: { total: 0, verified: 0, failed: 0, percent: 0 },
  tasks: [],
  modules: [],
  rollups: [],
}

function unavailable(route: Route) {
  return route.fulfill({
    status: 404,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ _tag: "ProductMigrationUnavailable" }),
  })
}

async function setupMixedServers(
  page: Page,
  products: {
    local?: { id: string; name: string; capability: string }
    remote?: { id: string; name: string; capability: string }
  },
  options: {
    draft?: boolean
    newLayoutDesigns?: boolean
    remoteHealth?: Promise<void>
    remoteSession?: boolean
    remoteSessionError?: boolean
    localProjects?: boolean
  } = {},
) {
  const requests: string[] = []
  let remoteHealthReads = 0
  let remoteProduct = products.remote
  await page.addInitScript(
    ({ directory, draft, draftID, localProjects, newLayoutDesigns, remoteDirectory, remoteServer }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [remoteServer],
          projects: {
            local: localProjects ? [{ worktree: directory, expanded: true }] : [],
            [remoteServer]: [{ worktree: remoteDirectory, expanded: true }],
          },
          lastProject: { ...(localProjects ? { local: directory } : {}), [remoteServer]: remoteDirectory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(draft ? [{ type: "draft", draftID, server: remoteServer, directory: remoteDirectory }] : []),
      )
    },
    {
      directory,
      draft: options.draft === true,
      draftID,
      localProjects: options.localProjects !== false,
      newLayoutDesigns: options.newLayoutDesigns ?? true,
      remoteDirectory,
      remoteServer,
    },
  )
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server && url.origin !== remoteServer) return route.fallback()
    requests.push(url.toString())
    const local = url.origin === server
    const worktree = local ? directory : remoteDirectory
    const product = local ? products.local : remoteProduct
    if (url.pathname === "/global/event" || url.pathname === "/event")
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
    if (url.pathname === "/global/health") {
      if (!local) {
        remoteHealthReads++
        await options.remoteHealth
      }
      return json(route, { healthy: true, product })
    }
    if (url.pathname === "/global/product-migration")
      return json(route, { _tag: "ProductMigrationUnavailable" }, 404)
    if (url.pathname === "/experimental/capabilities") return json(route, { backgroundSubagents: false })
    if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      if (local && options.localProjects === false) return json(route, url.pathname === "/project" ? [] : {})
      const project = {
        id: local ? "project-local" : "project-remote",
        worktree,
        vcs: "git",
        name: local ? "Local Product" : "Remote Product",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, { state: worktree, config: worktree, worktree, directory: worktree, home: worktree })
    const session = graphSession(remoteDirectory, "project-remote")
    if (url.pathname === "/session") return json(route, !local && options.remoteSession ? [session] : [])
    if (!local && options.remoteSessionError && url.pathname === `/session/${graphSessionID}`)
      return json(route, { _tag: "SessionNotFoundError", sessionID: graphSessionID }, 404)
    if (!local && options.remoteSession && url.pathname === `/session/${graphSessionID}`) return json(route, session)
    if (!local && options.remoteSession && url.pathname === `/session/${graphSessionID}/message`) return json(route, [])
    if (!local && options.remoteSession && /^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname))
      return json(route, [])
    if (!local && options.remoteSession && (url.pathname === "/graph/current-plan" || url.pathname === "/graph/main"))
      return json(route, { nodes: [], edges: [] })
    if (!local && options.remoteSession && url.pathname === "/graph/workflow") return json(route, emptyWorkflow)
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff", "/permission", "/question"].includes(url.pathname))
      return json(route, [])
    return json(route, {})
  })
  return {
    requests,
    remoteHealthReads: () => remoteHealthReads,
    setRemoteProduct(product: { id: string; name: string; capability: string }) {
      remoteProduct = product
    },
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

async function expectNoHorizontalOverflow(page: Page, selector: string) {
  expect(
    await page.locator(selector).evaluate((element) => ({
      component: element.scrollWidth <= element.clientWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      bounds: element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth,
    })),
  ).toEqual({ component: true, document: true, bounds: true })
}

async function expectBodyDesign(page: Page, enabled: boolean) {
  expect(
    await page.locator("body").evaluate((body) => ({
      enabled: body.hasAttribute("data-new-layout"),
      legacy: body.classList.contains("text-12-regular"),
      family: body.classList.contains("font-(family-name:--font-family-text)"),
      size: body.classList.contains("text-[13px]"),
      weight: body.classList.contains("font-[440]"),
    })),
  ).toEqual({ enabled, legacy: !enabled, family: enabled, size: enabled, weight: enabled })
}

async function navigateClient(page: Page, pathname: string) {
  await page.evaluate((next) => {
    const anchor = document.createElement("a")
    anchor.href = next
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }, pathname)
}
