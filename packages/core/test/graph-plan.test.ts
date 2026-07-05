import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphDomain from "@opencode-ai/core/graph/domain"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphPlan from "@opencode-ai/core/graph/workflow/plan"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const domainLayer = GraphDomain.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphDomain.Service
>
const planLayer = GraphPlan.layer.pipe(Layer.provideMerge(domainLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphDomain.Service | GraphPlan.Service
>

const PID = "proj_test" as any
const SID = "ses_test"
const A = "gnd_plan_a" as GraphStorage.NodeID
const B = "gnd_plan_b" as GraphStorage.NodeID

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID, project_id: PID, slug: "test", directory: "/tmp/test" as any, title: "test", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphDomain.Service | GraphPlan.Service>) =>
  Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* effect }).pipe(Effect.provide(planLayer), Effect.scoped))

describe("GraphPlan.admit", () => {
  test("dry-run validates but does not write CurrentPlan", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const result = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        dryRun: true,
        nodes: [
          { id: A, type: "atomic", name: "A", level: "L2" },
          { id: B, type: "atomic", name: "B", level: "L2" },
        ],
        edges: [{ sourceID: A, targetID: B, relation: "blocks" }],
      })

      expect(result).toEqual({ nodesCreated: 2, edgesCreated: 1, dryRun: true })
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID: SID })
      expect(currentPlan.nodes.length).toBe(0)
      expect(currentPlan.edges.length).toBe(0)
    }))
  })

  test("persists nodes and edges as session-scoped CurrentPlan", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const result = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        nodes: [
          { id: A, type: "atomic", name: "A", level: "L2" },
          { id: B, type: "atomic", name: "B", level: "L2" },
        ],
        edges: [{ sourceID: A, targetID: B, relation: "blocks" }],
      })

      expect(result).toEqual({ nodesCreated: 2, edgesCreated: 1, dryRun: false })
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID: SID })
      expect(currentPlan.nodes.map((node) => node.sessionID)).toEqual([SID, SID])
      expect(currentPlan.edges.map((edge) => edge.sessionID)).toEqual([SID])
    }))
  })

  test("does not persist partial CurrentPlan when edge validation fails", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const exit = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        nodes: [{ id: A, type: "atomic", name: "A", level: "L2" }],
        edges: [{ sourceID: A, targetID: B, relation: "blocks" }],
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID: SID })
      expect(currentPlan.nodes.length).toBe(0)
      expect(currentPlan.edges.length).toBe(0)
    }))
  })

  test("index-based edge references (@N) resolve to created node IDs", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const result = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        nodes: [
          { type: "composite", name: "Parent", level: "L1" },
          { type: "atomic", name: "Child", level: "L2" },
        ],
        edges: [{ sourceID: "@0", targetID: "@1", relation: "contains" }],
      })

      expect(result.nodesCreated).toBe(2)
      expect(result.edgesCreated).toBe(1)
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID: SID })
      expect(currentPlan.nodes.length).toBe(2)
      expect(currentPlan.edges.length).toBe(1)
      expect(currentPlan.edges[0].sourceID).toBe(currentPlan.nodes[0].id)
      expect(currentPlan.edges[0].targetID).toBe(currentPlan.nodes[1].id)
    }))
  })

  test("index references work in dry-run validation", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const result = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        dryRun: true,
        nodes: [
          { type: "prd", name: "PRD", level: "L1" },
          { type: "composite", name: "Feature", level: "L1" },
        ],
        edges: [{ sourceID: "@0", targetID: "@1", relation: "contains" }],
      })

      expect(result.dryRun).toBe(true)
      expect(result.edgesCreated).toBe(1)
    }))
  })

  test("mixing index references and explicit IDs", async () => {
    await run(Effect.gen(function* () {
      const plan = yield* GraphPlan.Service
      const result = yield* plan.admit({
        projectID: PID,
        sessionID: SID,
        nodes: [
          { id: "mix_root", type: "prd", name: "Root", level: "L1" },
          { type: "composite", name: "Branch", level: "L1" },
        ],
        edges: [
          { sourceID: "mix_root", targetID: "@1", relation: "contains" },
        ],
      })

      expect(result.nodesCreated).toBe(2)
      const storage = yield* GraphStorage.Service
      const currentPlan = yield* storage.currentPlan({ sessionID: SID })
      expect(currentPlan.edges[0].sourceID).toBe("mix_root" as GraphStorage.NodeID)
      expect(currentPlan.edges[0].targetID).toBe(currentPlan.nodes[1].id)
    }))
  })
})
