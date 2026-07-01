import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphDomain from "@opencode-ai/core/graph/domain"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.defaultLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const domainLayer = GraphDomain.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphDomain.Service
>

const PID = "proj_test" as any
const SID = "ses_test" as any

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID, project_id: PID, slug: "test", directory: "/tmp/test" as any, title: "test", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphDomain.Service>) =>
  Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* effect }).pipe(Effect.provide(domainLayer), Effect.scoped))

describe("GraphDomain write-time validation", () => {
  test("valid node creates successfully", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const id = yield* d.node.create({ projectID: PID, type: "atomic", name: "Svc", level: "L2" })
      expect(typeof id).toBe("string")
    }))
  })

  test("confidence out of range -> ValidationError", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const result = yield* d.node.create({ projectID: PID, type: "atomic", name: "Bad", level: "L2", confidence: 5 } as any).pipe(
        Effect.map(() => "success" as const),
        Effect.catchTag("GraphV2.ValidationError", () => Effect.succeed("validation-error" as const)),
      )
      expect(result).toBe("validation-error")
    }))
  })

  test("node.update validates merged result", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const id = yield* d.node.create({ projectID: PID, type: "atomic", name: "N", level: "L2" })
      const exit = yield* Effect.exit(d.node.update(id, { confidence: 99 }))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
  })

  test("valid edge creates successfully", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const a = yield* d.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
      const b = yield* d.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
      const eid = yield* d.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "blocks" })
      expect(typeof eid).toBe("string")
    }))
  })

  test("self-loop edge -> ValidationError", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const a = yield* d.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
      const exit = yield* Effect.exit(d.edge.create({ projectID: PID, sourceID: a, targetID: a, relation: "blocks" }))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
  })

  test("invalid edge type -> ValidationError", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const a = yield* d.node.create({ projectID: PID, type: "prd", name: "A", level: "L1" })
      const b = yield* d.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
      const exit = yield* Effect.exit(d.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "uses" }))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
  })
})

describe("GraphDomain queries", () => {
  test("validateSubgraph delegates to pure function", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      yield* d.storage.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "A", level: "L2" })
      const result = yield* d.validateSubgraph({ projectID: PID, sessionID: SID })
      expect(result.valid).toBe(true)
    }))
  })

  test("detectConflicts loads from DB and delegates", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      yield* d.storage.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "P", level: "L2" })
      const conflicts = yield* d.detectConflicts({ projectID: PID, sessionID: SID })
      expect(Array.isArray(conflicts)).toBe(true)
    }))
  })

  test("assessImpact loads from DB and delegates", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const a = yield* d.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
      const b = yield* d.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
      yield* d.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "blocks" })
      const r = yield* d.assessImpact({ projectID: PID, nodeID: a })
      expect(r.direct.length).toBe(1)
      expect(r.risk).toBe("low")
    }))
  })

  test("findPath loads from DB and delegates", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      const a = yield* d.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
      const b = yield* d.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
      yield* d.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "blocks" })
      const path = yield* d.findPath({ projectID: PID, sourceID: a, targetID: b })
      expect(path).not.toBeNull()
      expect(path!.length).toBe(2)
    }))
  })
})

describe("GraphDomain pass-through", () => {
  test("main/currentPlan/promote/version delegate to storage", async () => {
    await run(Effect.gen(function* () {
      const d = yield* GraphDomain.Service
      yield* d.storage.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "P", level: "L2" })
      const cp = yield* d.currentPlan({ sessionID: SID })
      expect(cp.nodes.length).toBe(1)
      const res = yield* d.promote({ projectID: PID, sessionID: SID, message: "test" })
      expect(res.versionNumber).toBe(1)
      const m = yield* d.main({ projectID: PID })
      expect(m.nodes.length).toBe(1)
      const vs = yield* d.version.list({ projectID: PID })
      expect(vs.length).toBe(1)
    }))
  })
})
