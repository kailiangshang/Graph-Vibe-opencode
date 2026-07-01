import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphDerivation from "@opencode-ai/core/graph/derivation/derive"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const deriveLayer = GraphDerivation.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphDerivation.Service
>

const PID = "proj_test" as any

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "derive-test-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = <A, E>(dir: string, effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphDerivation.Service>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      return yield* effect
    }).pipe(Effect.provide(deriveLayer), Effect.scoped),
  ).then(() => undefined)

describe("GraphDerivation.scan", () => {
  test("scans TS files and returns expected graph", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.ts"), "function foo() {}\nconst bar = 1\n")
      await writeFile(join(dir, "b.ts"), "class Baz {}\n")

      await run(dir, Effect.gen(function* () {
        const d = yield* GraphDerivation.Service
        const result = yield* d.scan({ projectID: PID, directory: dir })
        expect(result.filesScanned).toBe(2)
        expect(result.expected.nodes.length).toBeGreaterThan(0)
        const names = result.expected.nodes.map((n) => n.name)
        expect(names).toContain("a.ts")
        expect(names).toContain("foo")
        expect(names).toContain("bar")
        expect(names).toContain("Baz")
      }))
    })
  })
})

describe("GraphDerivation.sync", () => {
  test("sync creates imported-code nodes in DB", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "svc.ts"), "function serve() {}\n")

      await run(dir, Effect.gen(function* () {
        const d = yield* GraphDerivation.Service
        const result = yield* d.sync({ projectID: PID, directory: dir })
        expect(result.nodesAdded).toBeGreaterThan(0)

        const storage = yield* GraphStorage.Service
        const main = yield* storage.main({ projectID: PID })
        expect(main.nodes.length).toBeGreaterThan(0)
        const names = main.nodes.map((n) => n.name)
        expect(names).toContain("svc.ts")
        expect(names).toContain("serve")
      }))
    })
  })

  test("second sync is idempotent (no changes)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "svc.ts"), "function serve() {}\n")

      await run(dir, Effect.gen(function* () {
        const d = yield* GraphDerivation.Service
        yield* d.sync({ projectID: PID, directory: dir })
        const result2 = yield* d.sync({ projectID: PID, directory: dir })
        expect(result2.nodesAdded).toBe(0)
        expect(result2.nodesRemoved).toBe(0)
        expect(result2.nodesUpdated).toBe(0)
      }))
    })
  })

  test("sync detects code changes (hash_mismatch)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "svc.ts"), "function serve() { return 1 }\n")

      await run(dir, Effect.gen(function* () {
        const d = yield* GraphDerivation.Service
        yield* d.sync({ projectID: PID, directory: dir })
        yield* Effect.promise(() => writeFile(join(dir, "svc.ts"), "function serve() { return 2 }\n"))
        const result = yield* d.sync({ projectID: PID, directory: dir })
        expect(result.nodesUpdated).toBeGreaterThan(0)
      }))
    })
  })

  test("sync removes stale nodes when code is deleted", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.ts"), "function foo() {}\n")
      await writeFile(join(dir, "b.ts"), "function bar() {}\n")

      await run(dir, Effect.gen(function* () {
        const d = yield* GraphDerivation.Service
        yield* d.sync({ projectID: PID, directory: dir })
        yield* Effect.promise(() => rm(join(dir, "b.ts")))
        const result = yield* d.sync({ projectID: PID, directory: dir })
        expect(result.nodesRemoved).toBeGreaterThan(0)
      }))
    })
  })
})
