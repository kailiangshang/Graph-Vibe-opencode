import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphAudit from "@opencode-ai/core/graph/workflow/audit"
import * as GraphBuild from "@opencode-ai/core/graph/workflow/build"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const auditLayer = GraphAudit.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service
>
const buildLayer = GraphBuild.layer.pipe(Layer.provideMerge(auditLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service | GraphBuild.Service
>

const PID = "proj_test" as any
const SID = "ses_test"

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID, project_id: PID, slug: "test", directory: "/tmp/test" as any, title: "test", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphAudit.Service | GraphBuild.Service>) =>
  Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* effect }).pipe(Effect.provide(buildLayer), Effect.scoped))

describe("GraphBuild.evaluate", () => {
  test("loads graph state, blocks target outside CurrentPlan, and records audit", async () => {
    await run(Effect.gen(function* () {
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({ projectID: PID, type: "atomic", name: "MainOnly", level: "L2" })
      const build = yield* GraphBuild.Service
      const result = yield* build.evaluate({ projectID: PID, sessionID: SID, targetNodeID, executor: "manual" })

      expect(result.allowed).toBe(false)
      expect(result.issues.map((issue) => issue.code)).toContain("target_not_in_current_plan")

      const audit = yield* GraphAudit.Service
      const generations = yield* audit.generation.list({ projectID: PID, nodeID: targetNodeID })
      const tools = yield* audit.tool.list({ projectID: PID, nodeID: targetNodeID })
      expect(generations.map((run) => run.status)).toEqual(["blocked"])
      expect(tools.map((run) => run.status)).toEqual(["blocked"])
      expect(tools[0].toolName).toBe("graph.build.gate")
    }))
  })

  test("returns allowed dry-run result for buildable node and records dry_run", async () => {
    await run(Effect.gen(function* () {
      const storage = yield* GraphStorage.Service
      const targetNodeID = yield* storage.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "BuildMe", level: "L2" })
      const build = yield* GraphBuild.Service
      const result = yield* build.evaluate({
        projectID: PID,
        sessionID: SID,
        targetNodeID,
        executor: "manual",
        dryRun: true,
        artifact: { mode: "full", path: "src/a.ts", code: "export {}\n", test: "test\n" },
      })

      expect(result.allowed).toBe(true)
      expect(result.requiredPermissions).toEqual(["artifact_write"])

      const audit = yield* GraphAudit.Service
      const generations = yield* audit.generation.list({ projectID: PID, nodeID: targetNodeID })
      const tools = yield* audit.tool.list({ projectID: PID, nodeID: targetNodeID })
      expect(generations.map((run) => run.status)).toEqual(["dry_run"])
      expect(generations[0].artifactSummary).toBe("full src/a.ts")
      expect(tools.map((run) => run.status)).toEqual(["dry_run"])
    }))
  })
})
