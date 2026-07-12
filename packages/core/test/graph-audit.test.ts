import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import * as GraphStorage from "@opencode-ai/core/graph/storage"
import * as GraphAudit from "@opencode-ai/core/graph/workflow/audit"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const auditLayer = GraphAudit.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service
>

const PID = "proj_test" as any
const SID = "ses_test"
const SID_OTHER = "ses_other"

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: PID, worktree: "/tmp/test" as any, vcs: "git", sandboxes: [] as any, time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID, project_id: PID, slug: "test", directory: "/tmp/test" as any, title: "test", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: SID_OTHER, project_id: PID, slug: "other", directory: "/tmp/test" as any, title: "other", version: "0", time_created: 0, time_updated: 0 } as any).run().pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphAudit.Service>) =>
  Effect.runPromise(Effect.gen(function* () { yield* seed; return yield* effect }).pipe(Effect.provide(auditLayer), Effect.scoped))

describe("GraphAudit", () => {
  test("bounds aggregate artifact path evidence deterministically", () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/${String(index).padStart(2, "0")}-${"x".repeat(1_000)}.ts`)
    const evidence = GraphAudit.sanitizeEvidence({ kind: "artifact", nodeID: "node", artifactPaths: paths })
    expect(JSON.stringify(evidence.artifactPaths).length).toBeLessThanOrEqual(16_384)
    expect(evidence.artifactPaths).toEqual(paths.slice(0, evidence.artifactPaths.length))
    expect(evidence.artifactPaths.length).toBeLessThan(paths.length)
  })
  test("records and lists tool runs by session", async () => {
    await run(Effect.gen(function* () {
      const audit = yield* GraphAudit.Service
      yield* audit.tool.record({ projectID: PID, sessionID: SID, toolName: "graph.build.gate", toolType: "graph", status: "blocked", inputSummary: "target" })
      yield* audit.tool.record({ projectID: PID, sessionID: SID_OTHER, toolName: "graph.plan.admit", toolType: "graph", status: "succeeded" })

      const rows = yield* audit.tool.list({ projectID: PID, sessionID: SID })
      expect(rows.length).toBe(1)
      expect(rows[0].toolName).toBe("graph.build.gate")
      expect(rows[0].status).toBe("blocked")
      expect(rows[0].inputSummary).toBe("target")
    }))
  })

  test("records and lists generation runs by node", async () => {
    await run(Effect.gen(function* () {
      const storage = yield* GraphStorage.Service
      const nodeID = yield* storage.node.create({ projectID: PID, sessionID: SID, type: "atomic", name: "BuildMe", level: "L2" })
      const audit = yield* GraphAudit.Service
      yield* audit.generation.record({
        projectID: PID,
        sessionID: SID,
        nodeID,
        executor: "manual",
        status: "dry_run",
        gateResult: { allowed: true, issues: [], requiredPermissions: [] },
        artifactSummary: "full src/a.ts",
      })

      const rows = yield* audit.generation.list({ projectID: PID, nodeID })
      expect(rows.length).toBe(1)
      expect(rows[0].nodeID).toBe(nodeID)
      expect(rows[0].status).toBe("dry_run")
      expect(rows[0].gateResult).toEqual({ allowed: true, issues: [], requiredPermissions: [] })
    }))
  })
})
