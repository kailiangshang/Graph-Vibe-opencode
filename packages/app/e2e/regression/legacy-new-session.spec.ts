import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_legacy_new_session"
const directory = "C:/OpenCode/LegacyNewSession"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("redirects a same-server OpenCode draft to the legacy new-session route", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_legacy_new_session",
      worktree: directory,
      vcs: "git",
      name: "legacy-new-session",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  const migration = page.waitForResponse((response) => new URL(response.url()).pathname === "/global/product-migration")
  await page.goto(`/new-session?draftId=${draftID}`)

  const migrationResponse = await migration
  expect(migrationResponse.status()).toBe(404)
  await expect(migrationResponse.json()).resolves.toEqual({ _tag: "ProductMigrationUnavailable" })
  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toHaveCount(1)
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})
