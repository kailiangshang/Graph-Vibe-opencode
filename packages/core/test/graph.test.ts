import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"

// Database.defaultLayer uses OPENCODE_DB=:memory: (set by test/preload.ts).
// provideMerge keeps Database.Service in the output while feeding it to GraphStorage.
// (cast: Layer.unwrap inside Database.defaultLayer defeats the pipe overload resolver; runtime is correct.)
const layer = GraphStorage.layer.pipe(Layer.provideMerge(Database.defaultLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service
>

const PID = "proj_test" as any
const SID = "ses_test" as any

// Seed project + session rows so graph FK constraints are satisfied.
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: PID,
      worktree: "/tmp/test" as any,
      vcs: "git",
      sandboxes: [] as any,
      time_created: 0,
      time_updated: 0,
    } as any)
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SID,
      project_id: PID,
      slug: "test",
      directory: "/tmp/test" as any,
      title: "test",
      version: "0",
      time_created: 0,
      time_updated: 0,
    } as any)
    .run()
    .pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      return yield* effect
    }).pipe(Effect.provide(layer), Effect.scoped),
  )

describe("GraphStorage.node", () => {
  test("create/get/update/delete with defaults", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const id = yield* g.node.create({ projectID: PID, type: "atomic", name: "UserSvc", level: "L2" })
        let n = yield* g.node.get(id)
        expect(n.status).toBe("pending")
        expect(n.testStatus).toBe("none")
        expect(n.confidence).toBe(1)
        expect(n.sessionID).toBe(null)
        yield* g.node.update(id, { status: "implemented" })
        n = yield* g.node.get(id)
        expect(n.status).toBe("implemented")
        yield* g.node.delete(id)
        const exit = yield* Effect.exit(g.node.get(id))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("list filters by project_id and type", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        yield* g.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
        yield* g.node.create({ projectID: PID, type: "composite", name: "B", level: "L2" })
        const all = yield* g.node.list({ projectID: PID })
        expect(all.length).toBe(2)
        const atomics = yield* g.node.list({ projectID: PID, type: "atomic" })
        expect(atomics.length).toBe(1)
        expect(atomics[0].name).toBe("A")
      }),
    )
  })
})
