import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import { GraphVersionTable } from "@opencode-ai/core/graph/sql"

// layerFromPath(":memory:") provides an in-memory sqlite DB (test/preload.ts sets OPENCODE_DB=:memory:).
// provideMerge keeps Database.Service in the output while feeding it to GraphStorage.
// (cast: Layer.unwrap inside layerFromPath defeats the pipe overload resolver; runtime is correct.)
const layer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
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

describe("GraphStorage.edge", () => {
  test("create/get/delete edge + list by relation", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const a = yield* g.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
        const b = yield* g.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
        const eid = yield* g.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "uses" })
        const e = yield* g.edge.get(eid)
        expect(e.relation).toBe("uses")
        expect(e.sourceID).toBe(a)
        const all = yield* g.edge.list({ projectID: PID })
        expect(all.length).toBe(1)
        yield* g.edge.delete(eid)
        const exit = yield* Effect.exit(g.edge.get(eid))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("duplicate (source,target,relation) is rejected by UNIQUE", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const a = yield* g.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
        const b = yield* g.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
        yield* g.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "uses" })
        const exit = yield* Effect.exit(g.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "uses" }))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("delete node cascades to its edges", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const a = yield* g.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
        const b = yield* g.node.create({ projectID: PID, type: "atomic", name: "B", level: "L2" })
        yield* g.edge.create({ projectID: PID, sourceID: a, targetID: b, relation: "uses" })
        yield* g.node.delete(a)
        const remaining = yield* g.edge.list({ projectID: PID })
        expect(remaining.length).toBe(0)
      }),
    )
  })
})

describe("GraphStorage.main / currentPlan", () => {
  test("session_id null = main; session_id set = currentPlan; mutually exclusive", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const mainNode = yield* g.node.create({ projectID: PID, type: "atomic", name: "M", level: "L2" })
        const planNode = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "P", level: "L2" })
        const m = yield* g.main({ projectID: PID })
        expect(m.nodes.map((n) => n.id)).toContain(mainNode)
        expect(m.nodes.map((n) => n.id)).not.toContain(planNode)
        const cp = yield* g.currentPlan({ sessionID: SID })
        expect(cp.nodes.map((n) => n.id)).toContain(planNode)
        expect(cp.nodes.map((n) => n.id)).not.toContain(mainNode)
      }),
    )
  })

  test("project_id scoping: project B nodes invisible", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const { db } = yield* Database.Service
        const otherPID = "proj_other" as any
        yield* db.insert(ProjectTable).values({ id: otherPID, worktree: "/tmp/other" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
        yield* g.node.create({ projectID: PID, type: "atomic", name: "A", level: "L2" })
        yield* g.node.create({ projectID: otherPID, type: "atomic", name: "X", level: "L2" })
        const mine = yield* g.node.list({ projectID: PID })
        expect(mine.length).toBe(1)
        expect(mine[0].name).toBe("A")
        const theirs = yield* g.node.list({ projectID: otherPID })
        expect(theirs.length).toBe(1)
        expect(theirs[0].name).toBe("X")
      }),
    )
  })
})

describe("GraphStorage.promote + version", () => {
  test("promote moves plan to main + writes version snapshot; currentPlan emptied", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const n1 = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "A", level: "L2" })
        const n2 = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "B", level: "L2" })
        yield* g.edge.create({ projectID: PID, sessionID: SID, sourceID: n1, targetID: n2, relation: "uses" })
        const res = yield* g.promote({ projectID: PID, sessionID: SID, message: "merge 1" })
        expect(res.versionNumber).toBe(1)
        expect(res.nodes).toBe(2)
        expect(res.edges).toBe(1)
        const m = yield* g.main({ projectID: PID })
        expect(m.nodes.length).toBe(2)
        expect(m.edges.length).toBe(1)
        const cp = yield* g.currentPlan({ sessionID: SID })
        expect(cp.nodes.length).toBe(0)
        const plan = yield* g.planView({ projectID: PID, sessionID: SID })
        expect(plan.source).toBe("version")
        expect(plan.versionNumber).toBe(1)
        expect(plan.publishedAt).toBeNumber()
        expect(plan.nodes.map((node) => node.id)).toEqual([n1, n2])
        expect(plan.edges[0]).toMatchObject({ sourceID: n1, targetID: n2, relation: "uses" })
        const vs = yield* g.version.list({ projectID: PID })
        expect(vs.length).toBe(1)
        const v1 = yield* g.version.get({ projectID: PID, versionNumber: 1 })
        expect(v1.message).toBe("merge 1")
      }),
    )
  })

  test("version_number increments per promote", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const SID2 = "ses_two" as any
        const { db } = yield* Database.Service
        yield* db.insert(SessionTable).values({ id: SID2, project_id: PID, slug: "two", directory: "/tmp", title: "two", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
        yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "A", level: "L2" })
        const r1 = yield* g.promote({ projectID: PID, sessionID: SID })
        yield* g.node.create({ projectID: PID, sessionID: SID2, type: "atomic", name: "B", level: "L2" })
        const r2 = yield* g.promote({ projectID: PID, sessionID: SID2 })
        expect(r1.versionNumber).toBe(1)
        expect(r2.versionNumber).toBe(2)
      }),
    )
  })

  test("planView prefers a non-empty live plan over the latest published version", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "Published", level: "L2" })
        yield* g.promote({ projectID: PID, sessionID: SID })
        const liveID = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "Live", level: "L2" })

        const plan = yield* g.planView({ projectID: PID, sessionID: SID })
        expect(plan).toMatchObject({ source: "currentPlan", versionNumber: null, publishedAt: null })
        expect(plan.nodes.map((node) => node.id)).toEqual([liveID])
      }),
    )
  })

  test("latestForSession decodes the newest matching canonical snapshot only", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const database = yield* Database.Service
        const otherSID = SessionSchema.ID.make("ses_other")
        yield* database.db.insert(SessionTable).values({
          id: otherSID,
          project_id: PID,
          slug: "other",
          directory: "/tmp/other",
          title: "other",
          version: "0",
          time_created: 0,
          time_updated: 0,
        }).run().pipe(Effect.orDie)
        const first = canonicalNode("gnd_canonical_first", "First")
        const second = canonicalNode("gnd_canonical_second", "Second")
        const linked = canonicalEdge("ged_canonical", first.id, second.id)
        const enhancement = canonicalNode("gnd_enhancement", "Enhancement")
        yield* database.db.insert(GraphVersionTable).values([
          {
            id: "gvr_malformed_old" as GraphStorage.VersionID,
            project_id: PID,
            session_id: SID,
            version_number: 1,
            snapshot: { nodes: [{ id: "incomplete" }], edges: [] },
          },
          {
            id: "gvr_canonical" as GraphStorage.VersionID,
            project_id: PID,
            session_id: SID,
            version_number: 2,
            snapshot: { nodes: [first, second], edges: [linked] },
          },
          {
            id: "gvr_enhancement" as GraphStorage.VersionID,
            project_id: PID,
            session_id: SID,
            version_number: 3,
            message: "product-migration:enhancement:geh_test",
            snapshot: { nodes: [enhancement], edges: [] },
          },
          {
            id: "gvr_other_session" as GraphStorage.VersionID,
            project_id: PID,
            session_id: otherSID,
            version_number: 4,
            snapshot: { nodes: [{ id: "also-incomplete" }], edges: [] },
          },
        ]).run().pipe(Effect.orDie)

        const version = yield* g.version.latestForSession({ projectID: PID, sessionID: SID })
        expect(version?.versionNumber).toBe(2)
        expect(version?.snapshot.nodes).toEqual([first, second])
        expect(version?.snapshot.edges).toEqual([linked])
      }),
    )
  })

  test("latestForSession fails with SnapshotDecodeError for a malformed selected snapshot", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const database = yield* Database.Service
        yield* database.db.insert(GraphVersionTable).values({
          id: "gvr_malformed" as GraphStorage.VersionID,
          project_id: PID,
          session_id: SID,
          version_number: 1,
          snapshot: { nodes: [{ id: "incomplete" }], edges: [] },
        }).run().pipe(Effect.orDie)

        const error = yield* g.version.latestForSession({ projectID: PID, sessionID: SID }).pipe(Effect.flip)
        expect(error._tag).toBe("GraphV2.SnapshotDecodeError")
        expect(error.message.length).toBeGreaterThan(0)
      }),
    )
  })

  test("planView returns an empty currentPlan view when no live or published plan exists", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        expect(yield* g.planView({ projectID: PID, sessionID: SID })).toEqual({
          nodes: [],
          edges: [],
          source: "currentPlan",
          versionNumber: null,
          publishedAt: null,
        })
      }),
    )
  })
})

describe("GraphStorage.cascade", () => {
  test("delete session cascades to its graph nodes/edges", async () => {
    await run(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const a = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "A", level: "L2" })
        const b = yield* g.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "B", level: "L2" })
        yield* g.edge.create({ projectID: PID, sessionID: SID, sourceID: a, targetID: b, relation: "uses" })
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, SID)).run().pipe(Effect.orDie)
        const cp = yield* g.currentPlan({ sessionID: SID })
        expect(cp.nodes.length).toBe(0)
        expect(cp.edges.length).toBe(0)
      }),
    )
  })
})

function canonicalNode(id: string, name: string): GraphStorage.NodeRow {
  return {
    id: id as GraphStorage.NodeID,
    projectID: PID,
    sessionID: SID,
    type: "atomic",
    name,
    level: "L2",
    priority: null,
    category: null,
    status: "pending",
    desc: null,
    content: null,
    verification: null,
    codeHash: null,
    testStatus: "none",
    confidence: 1,
    timeCreated: 1,
    timeUpdated: 2,
  }
}

function canonicalEdge(id: string, sourceID: GraphStorage.NodeID, targetID: GraphStorage.NodeID): GraphStorage.EdgeRow {
  return {
    id: id as GraphStorage.EdgeID,
    projectID: PID,
    sessionID: SID,
    sourceID,
    targetID,
    relation: "contains",
    confidence: 1,
    timeCreated: 3,
  }
}
