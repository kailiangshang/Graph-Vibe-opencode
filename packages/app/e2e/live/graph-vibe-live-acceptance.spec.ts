import { expect, test } from "@playwright/test"
import path from "node:path"

const input = {
  uiUrl: process.env.GRAPH_VIBE_LIVE_UI_URL,
  backendUrl: process.env.GRAPH_VIBE_LIVE_BACKEND_URL,
  directory: process.env.GRAPH_VIBE_LIVE_DIRECTORY,
  password: process.env.GRAPH_VIBE_LIVE_PASSWORD,
  artifacts: process.env.GRAPH_VIBE_LIVE_ARTIFACTS,
}
const enabled = Object.values(input).every(Boolean)

test.use({ trace: "off", video: "off", screenshot: "off" })
test.describe.configure({ retries: 0 })
test.skip(!enabled, "requires explicit GRAPH_VIBE_LIVE_* acceptance environment")

test("authenticated isolated non-loopback Graph Vibe workflow", async ({ page }) => {
  if (!input.uiUrl || !input.backendUrl || !input.directory || !input.password || !input.artifacts) {
    throw new Error("Missing GRAPH_VIBE_LIVE_* acceptance environment")
  }
  const directory = path.resolve(input.directory)

  const unauthenticatedHealthStatus = await healthStatus(input.backendUrl)
  const authenticatedHealthStatus = await healthStatus(input.backendUrl, input.password)
  expect(unauthenticatedHealthStatus).toBe(401)
  expect(authenticatedHealthStatus).toBe(200)

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const requests = new Map<string, number>()
  const posts: string[] = []
  const execution = {
    messagePromptPost: 0,
    promptAsyncPost: 0,
    v2PromptPost: 0,
    modelPost: 0,
    providerPost: 0,
  }
  let backendBrowserRequests = 0
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url())
    if (url.origin !== input.backendUrl) return
    backendBrowserRequests++
    const pathname = url.pathname
    const key = `${browserRequest.method()} ${pathname}`
    requests.set(key, (requests.get(key) ?? 0) + 1)
    if (browserRequest.method() !== "POST") return
    posts.push(key)
    if (/\/session\/[^/]+\/message$/.test(pathname)) execution.messagePromptPost++
    if (/\/session\/[^/]+\/prompt_async$/.test(pathname)) execution.promptAsyncPost++
    if (/\/api\/session\/[^/]+\/prompt$/.test(pathname)) execution.v2PromptPost++
    if (/\/api\/session\/[^/]+\/model$|\/api\/model(?:\/|$)/.test(pathname)) execution.modelPost++
    if (/\/api\/provider(?:\/|$)|\/provider\//.test(pathname)) execution.providerPost++
  })

  await page.addInitScript(
    (token) => {
      const marker = "graph-vibe-live-auth-seeded"
      if (sessionStorage.getItem(marker)) return
      sessionStorage.setItem(marker, "1")
      const url = new URL(location.href)
      url.searchParams.set("auth_token", token)
      history.replaceState(null, "", url)
    },
    Buffer.from(`opencode:${input.password}`).toString("base64"),
  )
  const startUrl = new URL(`/${Buffer.from(directory).toString("base64url")}`, input.uiUrl)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(startUrl.toString())
  await expect(page).toHaveTitle("Graph Vibe")
  expect(new URL(page.url()).searchParams.has("auth_token")).toBe(false)
  const reloadedHealth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/global/health" && response.request().method() === "GET",
  )
  const reloadedMigration = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/global/product-migration" && response.request().method() === "GET",
  )
  await page.reload()
  expect((await reloadedHealth).status()).toBe(200)
  expect((await reloadedMigration).status()).toBe(200)
  expect(new URL(page.url()).searchParams.has("auth_token")).toBe(false)
  const checkpoint = page.getByRole("main", { name: "Graph Vibe data transfer checkpoint" })
  await expect(checkpoint).toBeVisible()
  await page.getByRole("button", { name: "Start Graph Vibe fresh" }).click()
  await expect(page.getByRole("dialog")).toContainText("Start without importing?")
  const freshResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/global/product-migration/fresh-start",
  )
  await page.getByRole("button", { name: "Confirm and unlock" }).click()
  const freshStartStatus = (await (await freshResponse).json()).status
  expect(freshStartStatus).toBe("completed")
  await expect(checkpoint).toHaveCount(0)

  await page.getByRole("banner").getByRole("button", { name: "Home", exact: true }).click()
  await expect(page).toHaveTitle("Graph Vibe")
  const dismissTabs = page.getByRole("button", { name: "Dismiss Tabs information" })
  await expect(dismissTabs).toBeVisible()
  await dismissTabs.click()
  await expect(dismissTabs).toHaveCount(0)

  const projects = page.getByRole("complementary", { name: "Projects" })
  await projects.getByRole("button", { name: "Add project" }).last().click()
  const picker = page.getByRole("dialog", { name: "Open project" })
  await picker.getByRole("textbox", { name: "Search folders" }).fill(directory)
  await picker.locator(`[data-key$="/${path.basename(directory)}"]`).click()
  await expect(picker).toHaveCount(0)

  const workflow = page.getByRole("region", { name: "Graph Vibe workflow" })
  await expect(workflow).toContainText("Graph Vibe")
  await expect(workflow).toContainText("Graph-guided development")
  await expect(workflow).toContainText("Selected project")
  await expect(workflow).toContainText(path.basename(directory))
  await expect(page.getByText("Loading", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Nothing here yet", { exact: true })).toBeVisible()
  const start = page.getByRole("button", { name: "Start Graph Workflow", exact: true })
  await expect(start).toBeVisible()
  await page.screenshot({ path: path.join(input.artifacts, "final-desktop-home-1440x900.png") })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(workflow).toBeVisible()
  await expect(start).toBeVisible()
  await page.screenshot({ path: path.join(input.artifacts, "final-mobile-home-390x844.png") })

  await page.setViewportSize({ width: 1440, height: 900 })
  await start.click()
  await expect(page).toHaveURL(/\/session\/[^/]+\/graph$/)
  const graphUrl = page.url()
  const graphSession = sessionID(graphUrl)
  await expect(page.getByRole("heading", { name: "No plan admitted", exact: true })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("No Current Plan nodes yet")
  const describe = page.getByRole("button", { name: "Describe a goal", exact: true })
  await expect(describe).toBeVisible()
  await page.screenshot({ path: path.join(input.artifacts, "final-desktop-empty-graph-1440x900.png") })

  await describe.click()
  await expect(page).toHaveURL(graphUrl.slice(0, -"/graph".length))
  expect(sessionID(page.url())).toBe(graphSession)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
  const help = await page.getByRole("link", { name: "Open the OpenCode website" }).boundingBox()
  const submit = await page.locator('[data-action="prompt-submit"]').boundingBox()
  if (!help || !submit) throw new Error("Expected visible help and prompt submit controls")
  const overlap =
    Math.max(0, Math.min(help.x + help.width, submit.x + submit.width) - Math.max(help.x, submit.x)) *
    Math.max(0, Math.min(help.y + help.height, submit.y + submit.height) - Math.max(help.y, submit.y))
  expect(overlap).toBe(0)
  await page.screenshot({ path: path.join(input.artifacts, "final-mobile-same-session-composer-390x844.png") })

  expect(backendBrowserRequests).toBeGreaterThan(0)
  console.log(
    `LIVE_ACCEPTANCE_RESULT=${JSON.stringify({
      title: await page.title(),
      unauthenticatedHealthStatus,
      authenticatedHealthStatus,
      backendBrowserRequests,
      freshStartStatus,
      sameSession: sessionID(page.url()) === graphSession,
      mobileInteractiveOverlap: overlap,
      checkpoints: ["home", "empty-graph", "same-session-composer"],
      requests: Object.fromEntries([...requests.entries()].toSorted(([left], [right]) => left.localeCompare(right))),
      posts,
      execution,
      consoleErrors,
      pageErrors,
    })}`,
  )
  expect(execution).toEqual({
    messagePromptPost: 0,
    promptAsyncPost: 0,
    v2PromptPost: 0,
    modelPost: 0,
    providerPost: 0,
  })
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

function sessionID(url: string) {
  const match = new URL(url).pathname.match(/\/session\/([^/]+)/)
  if (!match?.[1]) throw new Error("Session ID missing from browser URL")
  return match[1]
}

async function healthStatus(backendUrl: string, password?: string) {
  const headers = password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    : undefined
  return fetch(`${backendUrl}/global/health`, { headers }).then(
    (response) => response.status,
    () => {
      throw new Error("Graph Vibe health probe failed")
    },
  )
}
