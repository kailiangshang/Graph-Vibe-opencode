import { expect, test } from "bun:test"
import { ProductMigration } from "../src/v2/gen/sdk.gen"
import { createClient } from "../src/v2/gen/client/index"
import type {
  ProductMigrationExecuteError,
  ProductMigrationItem,
  ProductMigrationProjection,
  ProductMigrationRevisionConflict,
} from "../src/v2/gen/types.gen"

test("preserves the nullable migration projection contract", () => {
  const projection = {
    status: "undiscovered",
    revision: 0,
    source: null,
    plan: null,
    items: [],
    validation: null,
    completedItems: 0,
    totalItems: 0,
    canFinalize: false,
  } satisfies ProductMigrationProjection
  const item = {
    itemID: "category:config",
    category: "config",
    sourceID: null,
    targetID: null,
    status: "pending",
    selected: true,
    estimatedBytes: 0,
    error: null,
  } satisfies ProductMigrationItem
  const conflict = {
    _tag: "ProductMigrationRevisionConflict",
    expectedRevision: 1,
    actualRevision: 2,
  } satisfies ProductMigrationRevisionConflict
  const executeError: ProductMigrationExecuteError = conflict

  expect(projection.source).toBeNull()
  expect(item.error).toBeNull()
  expect(executeError._tag).toBe("ProductMigrationRevisionConflict")
})

test("generates every product migration command", () => {
  const migration = new ProductMigration()

  expect(typeof migration.get).toBe("function")
  expect(typeof migration.discover).toBe("function")
  expect(typeof migration.updateDraft).toBe("function")
  expect(typeof migration.execute).toBe("function")
  expect(typeof migration.pause).toBe("function")
  expect(typeof migration.retry).toBe("function")
  expect(typeof migration.skip).toBe("function")
  expect(typeof migration.validate).toBe("function")
  expect(typeof migration.finalize).toBe("function")
  expect(typeof migration.freshStart).toBe("function")
})

test("serializes required migration request bodies", async () => {
  let request: Request | undefined
  const client = createClient({
    baseUrl: "http://migration.test",
    fetch: async (input, init) => {
      request = new Request(input, init)
      return new Response(
        JSON.stringify({
          status: "copying",
          revision: 3,
          source: null,
          plan: null,
          items: [],
          validation: null,
          completedItems: 0,
          totalItems: 0,
          canFinalize: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })
  const migration = new ProductMigration({ client })

  await migration.execute({ productMigrationRevisionPayload: { expectedRevision: 2 } })

  expect(request?.url).toBe("http://migration.test/global/product-migration/execute")
  expect(await request?.json()).toEqual({ expectedRevision: 2 })
})

test("strictly compiles nullable migration projections", async () => {
  const check = Bun.spawn(
    [
      "bunx",
      "tsgo",
      "--noEmit",
      "--ignoreConfig",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "test/fixtures/product-migration.ts",
    ],
    {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    check.exited,
    new Response(check.stdout).text(),
    new Response(check.stderr).text(),
  ])

  expect(`${stdout}${stderr}`).toBe("")
  expect(exitCode).toBe(0)
})
