import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Product } from "@opencode-ai/core/product"
import { ProductMigrationGraph } from "@opencode-ai/core/product-migration/graph"
import { ProductMigrationSource } from "@opencode-ai/core/product-migration/source"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { tmpdir } from "./fixture/tmpdir"

const sqlite = await import("bun:sqlite")
const enhancementSecrets = [
  "sk-proj-4JvZx9Qm2Lp7Nc5Rt8Yw",
  "service-token-G8k2mP9vQ4xL7nR5",
  "database-secret-N4p8W2y6K0m3",
  "admin password with spaces",
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
  "hf_abcdefghijklmnopqrstuvwxyz123456",
  "npm_abcdefghijklmnopqrstuvwxyz123456",
  "url-password-realistic",
  "Q7v9Lm2Kx8Rp4Tn6Yw3Hs5Df1Gj0BcZa",
] as const

test("imports a known legacy graph with durable remapping, upgrades, and evidence-safe status", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedKnownLegacyGraph(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const before = await databaseHash(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-known",
        sourceDatabase: sourcePath,
        sourceFingerprint: "full-source-fingerprint",
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-known", "ses_source", false, "ready"),
      })
      const migration = yield* ProductMigrationGraph.Service
      const input = {
        migrationID: "migration-known",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceFingerprint: "full-source-fingerprint",
        sourceSessionIDs: ["ses_source"],
      }
      const imported = yield* migration.import(input)
      const retry = yield* migration.import(input)
      return {
        imported,
        retry,
        nodes: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_node WHERE session_id = 'ses_target' ORDER BY name
        `),
        edges: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_edge WHERE session_id = 'ses_target' ORDER BY id
        `),
        versions: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_version WHERE session_id = 'ses_target' ORDER BY version_number
        `),
        evidence: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_tool_run WHERE session_id = 'ses_target' ORDER BY tool_name
        `),
        workflow: yield* db.get<Record<string, unknown>>(sql`
          SELECT * FROM graph_workflow_state WHERE session_id = 'ses_target'
        `),
        generation: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_generation_run WHERE session_id = 'ses_target'
        `),
        mappings: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM product_migration_entity
          WHERE migration_id = 'migration-known' AND entity_type LIKE 'graph_%'
          ORDER BY entity_type, source_id
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported).toEqual(result.retry)
  expect(result.imported.sessions).toEqual([
    expect.objectContaining({
      sourceSessionID: "ses_source",
      targetSessionID: "ses_target",
      strategy: "legacy",
      status: "ready",
      nodeCount: 6,
      edgeCount: 2,
    }),
  ])
  expect(result.nodes).toHaveLength(6)
  expect(result.edges).toHaveLength(2)
  expect(result.versions).toHaveLength(1)
  expect(result.evidence).toHaveLength(6)
  expect(result.mappings.filter((row) => row.entity_type === "graph_node")).toHaveLength(6)
  expect(result.mappings.filter((row) => row.entity_type === "graph_edge")).toHaveLength(2)
  expect(result.mappings.filter((row) => row.entity_type === "graph_version")).toHaveLength(1)
  expect(result.mappings.filter((row) => row.entity_type === "graph_evidence")).toHaveLength(6)
  expect(result.nodes.every((row) => row.project_id === "project-target" && row.session_id === "ses_target")).toBe(true)
  expect(result.edges.every((row) => row.project_id === "project-target" && row.session_id === "ses_target")).toBe(true)
  const sourceIDs = new Set(["node-root", "node-verified", "node-claimed", "node-implemented"])
  expect(result.nodes.every((row) => !sourceIDs.has(String(row.id)))).toBe(true)
  expect(
    result.edges.every((row) => !sourceIDs.has(String(row.source_id)) && !sourceIDs.has(String(row.target_id))),
  ).toBe(true)

  const verified = result.nodes.find((row) => row.name === "Evidence verified")
  const claimed = result.nodes.find((row) => row.name === "Prose verified")
  const implemented = result.nodes.find((row) => row.name === "Artifact implemented")
  const wrongType = result.nodes.find((row) => row.name === "Wrong evidence type")
  const wrongReference = result.nodes.find((row) => row.name === "Wrong evidence node")
  expect(verified).toMatchObject({ status: "verified", test_status: "passed" })
  expect(implemented).toMatchObject({ status: "implemented", test_status: "pending" })
  expect(claimed).toMatchObject({ status: "pending", test_status: "none" })
  expect(wrongType).toMatchObject({ status: "pending", test_status: "none" })
  expect(wrongReference).toMatchObject({ status: "pending", test_status: "none" })
  expect(JSON.parse(String(verified?.verification))).toEqual({
    criteria: ["Verify Evidence verified"],
    diagnostics: [{ name: "test" }],
  })
  const evidence = result.evidence.find((row) => row.tool_name === "graph.diagnostics.run")
  expect(JSON.parse(String(evidence?.evidence))).toMatchObject({
    kind: "diagnostics",
    nodeID: verified?.id,
    complete: true,
    passed: true,
  })
  expect(evidence?.id).not.toBe("evidence-verified")
  expect(result.evidence.find((row) => row.tool_name === "graph.diagnostics.failed")).toMatchObject({
    status: "failed",
  })
  expect(result.evidence.find((row) => row.tool_name === "product_migration.graph_artifact_draft")).toMatchObject({
    status: "blocked",
  })
  expect(result.workflow).toMatchObject({
    project_id: "project-target",
    session_id: "ses_target",
    mode: "atomic",
    active_operation_id: null,
    active_operation_kind: null,
  })
  expect(result.workflow?.current_node_id).toBe(verified?.id)
  expect(result.generation).toHaveLength(1)
  expect(result.generation[0]).toMatchObject({ project_id: "project-target", session_id: "ses_target" })
  expect(result.generation[0]?.node_id).toBe(verified?.id)
  const gate = JSON.parse(String(result.generation[0]?.gate_result)) as {
    allowed: boolean
    issues: Array<{ code: string; severity: string; nodeID?: string; message: string }>
    requiredPermissions: string[]
  }
  expect(Object.keys(gate).sort()).toEqual(["allowed", "issues", "requiredPermissions"])
  expect(Buffer.byteLength(String(result.generation[0]?.gate_result), "utf8")).toBeLessThanOrEqual(32_768)
  expect(gate.issues).toHaveLength(32)
  expect(
    gate.issues.every(
      (issue) =>
        issue.code === "invalid_artifact" &&
        issue.severity === "block" &&
        Buffer.byteLength(issue.message, "utf8") <= 512 &&
        (issue.nodeID === undefined || Buffer.byteLength(issue.nodeID, "utf8") <= 256),
    ),
  ).toBe(true)
  expect(gate.requiredPermissions).toEqual(["artifact_write", "diagnostics_run"])
  const serializedAudit = JSON.stringify({ evidence: result.evidence, generation: result.generation })
  expect(serializedAudit).not.toContain("audit-secret-token")
  expect(serializedAudit).not.toContain("multi word audit password")
  expect(serializedAudit).not.toContain("url-password")
  expect(
    result.evidence.every((row) =>
      ["input_summary", "output_summary", "error"].every(
        (key) => row[key] === null || String(row[key]).length <= 1_024,
      ),
    ),
  ).toBe(true)
  expect(await databaseHash(sourcePath)).toBe(before)
})

test("reconstructs deterministically from copied target history when Graph schema is absent, unknown, or corrupt", async () => {
  for (const sourceKind of ["absent", "unknown", "corrupt"] as const) {
    await using tmp = await tmpdir()
    const sourceDatabase = path.join(tmp.path, sourceKind, "opencode.db")
    const targetDatabase = path.join(tmp.path, sourceKind, "graph-vibe.db")
    await mkdir(path.dirname(sourceDatabase), { recursive: true })
    seedUnsupportedGraph(sourceDatabase, sourceKind)
    const sourcePath = await realpath(sourceDatabase)
    const identity = await sourceIdentity(sourcePath)
    const before = await databaseHash(sourcePath)
    const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedTarget(db, {
          migrationID: `migration-${sourceKind}`,
          sourceDatabase: sourcePath,
          sourceFingerprint: identity.fingerprint,
          sourceSessionID: "ses_source",
          targetSessionID: "ses_target",
          sourceProjectID: "project-source",
          targetProjectID: "project-target",
          metadata: migrationMetadata(`migration-${sourceKind}`, "ses_source", false, "ready"),
        })
        yield* seedCopiedHistory(db, "ses_target")
        const migration = yield* ProductMigrationGraph.Service
        const input = {
          migrationID: `migration-${sourceKind}`,
          sourceDatabase: sourcePath,
          databaseFingerprint: identity.fingerprint,
          sourceSessionIDs: ["ses_source"],
        }
        const imported = yield* migration.import(input)
        const first = yield* db.all<Record<string, unknown>>(sql`
          SELECT id, type, name, status, test_status, verification, content
          FROM graph_node WHERE session_id = 'ses_target' ORDER BY id
        `)
        const firstEdges = yield* db.all<Record<string, unknown>>(sql`
          SELECT id, source_id, target_id, relation FROM graph_edge WHERE session_id = 'ses_target' ORDER BY id
        `)
        const retry = yield* migration.import(input)
        return {
          imported,
          retry,
          first,
          firstEdges,
          nodes: yield* db.all<Record<string, unknown>>(sql`
            SELECT id, type, name, status, test_status, verification, content
            FROM graph_node WHERE session_id = 'ses_target' ORDER BY id
          `),
          edges: yield* db.all<Record<string, unknown>>(sql`
            SELECT id, source_id, target_id, relation FROM graph_edge WHERE session_id = 'ses_target' ORDER BY id
          `),
          versions: yield* db.all<Record<string, unknown>>(sql`
            SELECT * FROM graph_version WHERE session_id = 'ses_target'
          `),
          session: yield* db.get<{ metadata: string }>(sql`SELECT metadata FROM session WHERE id = 'ses_target'`),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.imported).toEqual(result.retry)
    expect(result.imported.sessions[0]).toMatchObject({ strategy: "reconstructed", status: "ready" })
    expect(result.nodes).toEqual(result.first)
    expect(result.edges).toEqual(result.firstEdges)
    expect(result.versions).toHaveLength(1)
    expect(result.nodes.map((row) => row.name).sort()).toEqual(
      ["Build storage migration", "Import graph", "Parse known graph", "Reconstruct history"].sort(),
    )
    expect(result.nodes.every((row) => row.status === "pending" && row.test_status === "none")).toBe(true)
    const task = result.nodes.find((row) => row.name === "Reconstruct history")
    expect(JSON.parse(String(task?.verification))).toEqual({
      criteria: ["Complete Reconstruct history"],
      diagnostics: [{ name: "test", paths: ["test/product-migration-graph.test.ts"] }],
    })
    expect(JSON.parse(String(task?.content))).toMatchObject({
      artifact_paths: ["packages/core/src/product-migration/graph.ts"],
      diagnostic_commands: ["bun test test/product-migration-graph.test.ts"],
      migration: {
        source_message_ids: ["msg_source_history"],
        provenance: "deterministic",
        confidence: 1,
      },
    })
    expect(result.edges.some((row) => row.relation === "blocks")).toBe(true)
    expect(JSON.parse(result.session?.metadata ?? "{}").productMigration.status).toBe("ready")
    expect(await databaseHash(sourcePath)).toBe(before)
  }
})

test("isolates reconstructed mappings and rows for selected sessions with equivalent fallback content", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTargetBatch(db, {
        migrationID: "migration-reconstructed-sessions",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        targetProjectID: "project-target",
        sessions: [
          { sourceID: "ses_first", targetID: "ses_target_first" },
          { sourceID: "ses_second", targetID: "ses_target_second" },
        ],
      })
      yield* db.run(sql`
        INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
        VALUES
          ('ses_target_first', 'Review the migration', 'pending', 'medium', 0, 1, 1),
          ('ses_target_second', 'Review the migration', 'pending', 'medium', 0, 1, 1)
      `)
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration.import({
        migrationID: "migration-reconstructed-sessions",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_first", "ses_second"],
      })
      return {
        imported,
        nodes: yield* db.all<{ id: string; session_id: string; content: string }>(sql`
          SELECT id, session_id, content FROM graph_node
          WHERE session_id IN ('ses_target_first', 'ses_target_second') ORDER BY session_id, id
        `),
        edges: yield* db.all<{ id: string; session_id: string }>(sql`
          SELECT id, session_id FROM graph_edge
          WHERE session_id IN ('ses_target_first', 'ses_target_second') ORDER BY session_id, id
        `),
        versions: yield* db.all<{ id: string; session_id: string | null }>(sql`
          SELECT id, session_id FROM graph_version
          WHERE session_id IN ('ses_target_first', 'ses_target_second') ORDER BY session_id
        `),
        mappings: yield* db.all<{ entity_type: string; source_id: string; target_id: string }>(sql`
          SELECT entity_type, source_id, target_id FROM product_migration_entity
          WHERE migration_id = 'migration-reconstructed-sessions'
            AND entity_type IN ('graph_node', 'graph_edge', 'graph_version')
          ORDER BY entity_type, source_id
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported.sessions).toHaveLength(2)
  expect(result.imported.sessions.every((session) => session.strategy === "reconstructed")).toBe(true)
  const firstNodes = result.nodes.filter((row) => row.session_id === "ses_target_first")
  const secondNodes = result.nodes.filter((row) => row.session_id === "ses_target_second")
  const firstEdges = result.edges.filter((row) => row.session_id === "ses_target_first")
  const secondEdges = result.edges.filter((row) => row.session_id === "ses_target_second")
  expect(firstNodes).toHaveLength(3)
  expect(secondNodes).toHaveLength(3)
  expect(firstEdges).toHaveLength(2)
  expect(secondEdges).toHaveLength(2)
  expect(new Set(result.nodes.map((row) => row.id)).size).toBe(6)
  expect(new Set(result.edges.map((row) => row.id)).size).toBe(4)
  expect(result.versions).toHaveLength(2)
  expect(new Set(result.versions.map((row) => row.id)).size).toBe(2)
  expect(result.mappings.filter((row) => row.entity_type === "graph_node")).toHaveLength(6)
  expect(result.mappings.filter((row) => row.entity_type === "graph_edge")).toHaveLength(4)
  expect(
    result.mappings
      .filter((row) => row.entity_type === "graph_node" || row.entity_type === "graph_edge")
      .every((row) => row.source_id.startsWith("reconstructed:")),
  ).toBe(true)
  const generatedBySession = new Map(
    ["ses_target_first", "ses_target_second"].map((sessionID) => [
      sessionID,
      result.nodes
        .filter((row) => row.session_id === sessionID)
        .map((row) => JSON.parse(row.content).migration.source_id as string),
    ]),
  )
  expect(generatedBySession.get("ses_target_first")?.every((sourceID) => sourceID.length <= 256)).toBe(true)
  expect(generatedBySession.get("ses_target_second")?.every((sourceID) => sourceID.length <= 256)).toBe(true)
  expect(
    generatedBySession
      .get("ses_target_first")
      ?.every((sourceID) => !generatedBySession.get("ses_target_second")?.includes(sourceID)),
  ).toBe(true)
})

test("bounds reconstructed source IDs for max-length message provenance and accepts generated task references", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const sourceMessageID = "m".repeat(256)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-bounded-identity",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-bounded-identity", "ses_source", false, "ready"),
      })
      yield* db.run(sql`
        UPDATE product_migration_entity SET source_id = ${sourceMessageID}
        WHERE migration_id = 'migration-bounded-identity'
          AND entity_type = 'session_message' AND target_id = 'msg_history'
      `)
      yield* seedCopiedHistory(db, "ses_target")
      const graph = yield* ProductMigrationGraph.Service
      const input = {
        migrationID: "migration-bounded-identity",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_source"],
      }
      yield* graph.import(input)
      const nodes = yield* db.all<{ name: string; content: string }>(sql`
        SELECT name, content FROM graph_node WHERE session_id = 'ses_target' ORDER BY id
      `)
      const task = nodes.find((node) => node.name === "Parse known graph")
      const taskContent = JSON.parse(task?.content ?? "{}") as {
        migration?: { source_id?: string; source_message_ids?: string[] }
      }
      const queued = yield* graph.queueEnhancement({
        migrationID: "migration-bounded-identity",
        sourceSessionID: "ses_source",
      })
      const enhanced = yield* graph.applyEnhancement({
        enhancementID: queued.enhancementID,
        model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
        modules: [
          {
            name: "Bounded module",
            taskSourceIDs: taskContent.migration?.source_id ? [taskContent.migration.source_id] : [],
            sourceMessageIDs: [sourceMessageID],
            confidence: 0.8,
          },
        ],
        dependencies: [],
      })
      const retry = yield* graph.import(input)
      return {
        taskContent,
        enhanced,
        retry,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity
          WHERE migration_id = 'migration-bounded-identity' AND entity_type LIKE 'graph_%'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.taskContent.migration?.source_message_ids).toEqual([sourceMessageID])
  expect(result.taskContent.migration?.source_id?.length).toBeLessThanOrEqual(256)
  expect(result.mappings.every((mapping) => mapping.source_id.length <= 256)).toBe(true)
  expect(result.enhanced.replaced).toBe(false)
  expect(result.retry.sessions[0]?.strategy).toBe("reconstructed")
})

test("keeps a reconstructed session detached when Task 8 metadata says its directory is absent", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-detached",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-detached", "ses_source", true, "needs_attention"),
      })
      yield* seedCopiedHistory(db, "ses_target")
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration.import({
        migrationID: "migration-detached",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_source"],
      })
      return {
        imported,
        session: yield* db.get<{ metadata: string }>(sql`SELECT metadata FROM session WHERE id = 'ses_target'`),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported.sessions[0]?.status).toBe("needs_attention")
  expect(JSON.parse(result.session?.metadata ?? "{}").productMigration).toMatchObject({
    status: "needs_attention",
    checkpoint: "paused",
    detached: true,
  })
})

test("queues only minimal copied history and replaces a separate inferred enhancement version", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-enhance",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-enhance", "ses_source", false, "ready"),
      })
      yield* seedCopiedHistory(db, "ses_target")
      yield* seedLargeCopiedHistory(db, "migration-enhance", identity.fingerprint, "ses_target")
      const migration = yield* ProductMigrationGraph.Service
      yield* migration.import({
        migrationID: "migration-enhance",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_source"],
      })
      const beforeNodes = yield* db.all<Record<string, unknown>>(sql`
        SELECT id, name, content, status, test_status, verification
        FROM graph_node WHERE session_id = 'ses_target' ORDER BY id
      `)
      const sourceID = (name: string) => {
        const node = beforeNodes.find((row) => row.name === name)
        const migration = JSON.parse(String(node?.content ?? "{}")).migration as { source_id?: string } | undefined
        if (!migration?.source_id) throw new Error(`Missing reconstructed source ID for ${name}`)
        return migration.source_id
      }
      const parseTaskID = sourceID("Parse known graph")
      const reconstructTaskID = sourceID("Reconstruct history")
      const beforeEvidence = yield* db.all<Record<string, unknown>>(sql`
        SELECT * FROM graph_tool_run WHERE session_id = 'ses_target' ORDER BY id
      `)
      const queued = yield* migration.queueEnhancement({
        migrationID: "migration-enhance",
        sourceSessionID: "ses_source",
      })
      const unknownProvenance = yield* migration
        .applyEnhancement({
          enhancementID: queued.enhancementID,
          model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
          goal: { text: "Invalid", sourceMessageIDs: ["msg_unknown"], confidence: 0.8 },
          modules: [],
          dependencies: [],
        })
        .pipe(Effect.exit)
      const unknownTask = yield* migration
        .applyEnhancement({
          enhancementID: queued.enhancementID,
          model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
          modules: [
            {
              name: "Invalid",
              taskSourceIDs: ["task:missing:0"],
              sourceMessageIDs: ["msg_source_history"],
              confidence: 0.8,
            },
          ],
          dependencies: [],
        })
        .pipe(Effect.exit)
      const invalidConfidence = yield* migration
        .applyEnhancement({
          enhancementID: queued.enhancementID,
          model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
          goal: { text: "Invalid", sourceMessageIDs: ["msg_source_history"], confidence: 2 },
          modules: [],
          dependencies: [],
        })
        .pipe(Effect.exit)
      const truncatedProvenance = yield* migration
        .applyEnhancement({
          enhancementID: queued.enhancementID,
          model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
          goal: { text: "Invalid", sourceMessageIDs: ["msg_source_bulk_69"], confidence: 0.8 },
          modules: [],
          dependencies: [],
        })
        .pipe(Effect.exit)
      const oversizedShape = yield* migration
        .applyEnhancement({
          enhancementID: queued.enhancementID,
          model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
          modules: [
            {
              name: "m".repeat(2_000),
              taskSourceIDs: [parseTaskID],
              sourceMessageIDs: ["msg_source_history"],
              confidence: 0.8,
            },
          ],
          dependencies: [],
        })
        .pipe(Effect.exit)
      const first = yield* migration.applyEnhancement({
        enhancementID: queued.enhancementID,
        model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test") },
        goal: {
          text: "Build a resilient storage migration",
          sourceMessageIDs: ["msg_source_history"],
          confidence: 0.8,
        },
        modules: [
          {
            name: "Migration core",
            taskSourceIDs: [parseTaskID, reconstructTaskID],
            sourceMessageIDs: ["msg_source_history"],
            confidence: 0.75,
          },
        ],
        dependencies: [
          {
            sourceTaskID: parseTaskID,
            targetTaskID: reconstructTaskID,
            sourceMessageIDs: ["msg_source_history"],
            confidence: 0.7,
          },
        ],
      })
      const second = yield* migration.applyEnhancement({
        enhancementID: queued.enhancementID,
        model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-test-2") },
        goal: {
          text: "Build an isolated storage migration",
          sourceMessageIDs: ["msg_source_history"],
          confidence: 0.9,
        },
        modules: [],
        dependencies: [],
      })
      return {
        queued,
        first,
        second,
        afterNodes: yield* db.all<Record<string, unknown>>(sql`
          SELECT id, name, content, status, test_status, verification
          FROM graph_node WHERE session_id = 'ses_target' ORDER BY id
        `),
        afterEvidence: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_tool_run WHERE session_id = 'ses_target' ORDER BY id
        `),
        versions: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_version WHERE session_id = 'ses_target' ORDER BY version_number
        `),
        metadata: yield* db.get<{ metadata: string }>(sql`SELECT metadata FROM session WHERE id = 'ses_target'`),
        copiedHistory: yield* db.get<{ data: unknown }>(sql`
          SELECT data FROM session_message WHERE id = 'msg_history'
        `),
        beforeNodes,
        beforeEvidence,
        unknownProvenance,
        unknownTask,
        invalidConfidence,
        truncatedProvenance,
        oversizedShape,
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(
    result.queued.model && {
      providerID: String(result.queued.model.providerID),
      id: String(result.queued.model.id),
    },
  ).toEqual({ providerID: "provider-test", id: "model-test" })
  expect(result.queued.sourceMessageIDs.every((id) => id.startsWith("msg_source_"))).toBe(true)
  expect(result.queued.sourceMessageIDs).toContain("msg_source_history")
  expect(result.queued.bounds).toEqual({ maxMessages: 64, maxBytes: 65_536 })
  expect(result.queued.truncation.truncated).toBe(true)
  expect(result.queued.truncation.selectedMessages).toBeLessThanOrEqual(64)
  expect(result.queued.request.toolChoice).toBe("none")
  expect(result.queued.request.responseFormat).toMatchObject({ type: "json" })
  expect(JSON.stringify(result.queued.request)).toContain("structured goal, module, and dependency enrichment")
  expect(JSON.stringify(result.queued.request)).not.toContain("provider-secret")
  expect(JSON.stringify(result.queued.request)).not.toContain("tool-secret")
  expect(JSON.stringify(result.queued.request)).not.toContain("supersecretvalue")
  expect(JSON.stringify(result.queued.request)).not.toContain("queue-bearer-secret")
  expect(JSON.stringify(result.queued.request)).not.toContain("queue-url-password")
  expect(JSON.stringify(result.queued.request)).not.toContain("multi word queue password")
  expect(JSON.stringify(result.queued.request)).not.toContain("multi word queue token")
  enhancementSecrets.forEach((secret) => {
    expect(JSON.stringify(result.queued)).not.toContain(secret)
    expect(result.metadata?.metadata ?? "").not.toContain(secret)
    expect(JSON.stringify(result.copiedHistory?.data ?? "")).toContain(secret)
  })
  expect(Exit.isFailure(result.unknownProvenance)).toBe(true)
  expect(Exit.isFailure(result.unknownTask)).toBe(true)
  expect(Exit.isFailure(result.invalidConfidence)).toBe(true)
  expect(Exit.isFailure(result.truncatedProvenance)).toBe(true)
  expect(Exit.isFailure(result.oversizedShape)).toBe(true)
  expect(result.first.replaced).toBe(false)
  expect(result.second).toMatchObject({
    versionID: result.first.versionID,
    versionNumber: result.first.versionNumber,
    replaced: true,
  })
  expect(result.afterNodes).toEqual(result.beforeNodes)
  expect(result.afterEvidence).toEqual(result.beforeEvidence)
  expect(result.versions).toHaveLength(2)
  const enhancement = result.versions.find((row) => row.id === result.second.versionID)
  const snapshot = JSON.parse(String(enhancement?.snapshot)) as { nodes: Array<Record<string, unknown>> }
  const goal = snapshot.nodes.find((node) => node.type === "prd")
  expect(goal?.name).toBe("Build an isolated storage migration")
  expect(goal?.status).toBe("pending")
  expect(goal?.test_status).toBe("none")
  expect(goal?.content).toMatchObject({
    migration: {
      source_message_ids: ["msg_source_history"],
      provenance: "inferred",
      confidence: 0.9,
      model: { providerID: "provider-test", id: "model-test-2" },
    },
  })
})

test("applies a queued enhancement idempotently after finalization without source access or global mappings", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = Layer.merge(ProductMigrationGraph.layer, ProductMigrationState.layer).pipe(
    Layer.provide(Product.layerWith(Product.GraphVibe)),
    Layer.provideMerge(Database.layerFromPath(targetDatabase)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "opencode-first-import",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("opencode-first-import", "ses_source", false, "ready"),
      })
      yield* db.run(sql`
        UPDATE product_migration SET plan = 'source-only-plan' WHERE id = 'opencode-first-import'
      `)
      yield* seedCopiedHistory(db, "ses_target")
      const graph = yield* ProductMigrationGraph.Service
      yield* graph.import({
        migrationID: "opencode-first-import",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_source"],
      })
      const taskRows = yield* db.all<{ name: string; content: string }>(sql`
        SELECT name, content FROM graph_node WHERE session_id = 'ses_target' AND type = 'atomic'
      `)
      const taskSourceID = (name: string) => {
        const row = taskRows.find((task) => task.name === name)
        const migration = JSON.parse(row?.content ?? "{}").migration as { source_id?: string } | undefined
        if (!migration?.source_id) throw new Error(`Missing reconstructed source ID for ${name}`)
        return migration.source_id
      }
      const parseTaskID = taskSourceID("Parse known graph")
      const reconstructTaskID = taskSourceID("Reconstruct history")
      const queued = yield* graph.queueEnhancement({
        migrationID: "opencode-first-import",
        sourceSessionID: "ses_source",
      })
      const state = yield* ProductMigrationState.Service
      const validating = yield* state.validate({ expectedRevision: 1 })
      const ready = yield* state.validationSucceeded({ expectedRevision: validating.revision })
      const finalized = yield* state.finalize({ expectedRevision: ready.revision })
      yield* Effect.promise(() => rm(sourcePath))
      const enhancement = {
        enhancementID: queued.enhancementID,
        model: { providerID: Provider.ID.make("provider-test"), id: Model.ID.make("model-finalized") },
        goal: {
          text: "Continue entirely from destination data",
          sourceMessageIDs: ["msg_source_history"],
          confidence: 0.9,
        },
        modules: [
          {
            name: "Destination module",
            taskSourceIDs: [parseTaskID, reconstructTaskID],
            sourceMessageIDs: ["msg_source_history"],
            confidence: 0.8,
          },
        ],
        dependencies: [
          {
            sourceTaskID: parseTaskID,
            targetTaskID: reconstructTaskID,
            sourceMessageIDs: ["msg_source_history"],
            confidence: 0.75,
          },
        ],
      }
      const first = yield* graph.applyEnhancement(enhancement)
      const retry = yield* graph.applyEnhancement(enhancement)
      const version = yield* db.get<{ snapshot: string }>(sql`
        SELECT snapshot FROM graph_version WHERE id = ${first.versionID}
      `)
      return {
        queued,
        finalized,
        first,
        retry,
        version,
        journal: yield* db.get<Record<string, unknown>>(sql`
          SELECT source_path, source_fingerprint, plan, validation FROM product_migration
          WHERE id = 'opencode-first-import'
        `),
        mappings: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM product_migration_entity`),
        metadata: yield* db.get<{ metadata: string }>(sql`SELECT metadata FROM session WHERE id = 'ses_target'`),
        copiedMessages: yield* db.all<{ id: string }>(sql`
          SELECT id FROM session_message WHERE session_id = 'ses_target' ORDER BY seq
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.queued.enhancementID).toBeString()
  expect(result.finalized).toMatchObject({
    status: "completed",
    sourcePath: null,
    sourceFingerprint: null,
  })
  expect(result.journal).toMatchObject({
    source_path: null,
    source_fingerprint: null,
    plan: null,
    validation: null,
  })
  expect(result.mappings).toEqual([])
  expect(result.copiedMessages.length).toBeGreaterThan(0)
  expect(result.first.replaced).toBe(false)
  expect(result.retry).toMatchObject({
    versionID: result.first.versionID,
    versionNumber: result.first.versionNumber,
    replaced: true,
  })
  const snapshot = JSON.parse(result.version?.snapshot ?? "{}") as { nodes?: Array<Record<string, unknown>> }
  expect(snapshot.nodes?.find((node) => node.type === "prd")).toMatchObject({
    name: "Continue entirely from destination data",
    content: {
      migration: {
        source_message_ids: ["msg_source_history"],
        provenance: "inferred",
        model: { providerID: "provider-test", id: "model-finalized" },
      },
    },
  })
  expect(JSON.stringify(result.metadata)).not.toContain(sourcePath)
  expect(JSON.stringify(result.metadata)).not.toContain(identity.fingerprint)
  expect(JSON.stringify(result.metadata)).not.toContain("source-only-plan")
  expect(JSON.stringify(result.metadata)).not.toContain("queue-bearer-secret")
})

test("rejects a changed source identity before creating Graph mappings or readiness metadata", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedUnsupportedGraph(sourceDatabase, "absent")
  const sourcePath = await realpath(sourceDatabase)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-identity",
        sourceDatabase: sourcePath,
        sourceFingerprint: "stale-fingerprint",
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-identity", "ses_source", false, "ready"),
      })
      yield* seedCopiedHistory(db, "ses_target")
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration
        .import({
          migrationID: "migration-identity",
          sourceDatabase: sourcePath,
          databaseFingerprint: "stale-fingerprint",
          sourceSessionIDs: ["ses_source"],
        })
        .pipe(Effect.exit)
      return {
        imported,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity
          WHERE migration_id = 'migration-identity' AND entity_type LIKE 'graph_%'
        `),
        session: yield* db.get<{ metadata: string }>(sql`SELECT metadata FROM session WHERE id = 'ses_target'`),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result.imported)).toBe(true)
  expect(result.mappings).toEqual([])
  expect(JSON.parse(result.session?.metadata ?? "{}").productMigration.graphReconstructed).toBeUndefined()
})

test("rejects a WAL-only Graph mutation after planning", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedKnownLegacyGraph(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const writer = new sqlite.Database(sourcePath)
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
  const identity = await sourceIdentity(sourcePath)
  writer.run("UPDATE graph_node SET name = 'WAL-only Graph mutation' WHERE id = 'node-root'")
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-wal-graph",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-wal-graph", "ses_source", false, "ready"),
      })
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration
        .import({
          migrationID: "migration-wal-graph",
          sourceDatabase: sourcePath,
          databaseFingerprint: identity.fingerprint,
          sourceSessionIDs: ["ses_source"],
        })
        .pipe(Effect.exit)
      return {
        imported,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity
          WHERE migration_id = 'migration-wal-graph' AND entity_type LIKE 'graph_%'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result.imported)).toBe(true)
  expect(result.mappings).toEqual([])
  writer.close(false)
})

test("rejects an oversized selected Graph row family before materializing it", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedKnownLegacyGraph(sourceDatabase)
  const source = new sqlite.Database(sourceDatabase)
  source.run(`
    WITH RECURSIVE rows(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM rows WHERE value <= 100000
    )
    INSERT INTO graph_node (id, project_id, session_id, type, name, level)
    SELECT printf('node_limit_%06d', value), 'project-source', 'ses_source', 'atomic', 'Limit', 'L2' FROM rows
  `)
  source.close()
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-row-limit",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-row-limit", "ses_source", false, "ready"),
      })
      const migration = yield* ProductMigrationGraph.Service
      const error = yield* migration
        .import({
          migrationID: "migration-row-limit",
          sourceDatabase: sourcePath,
          databaseFingerprint: identity.fingerprint,
          sourceSessionIDs: ["ses_source"],
        })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
      return {
        error,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity
          WHERE migration_id = 'migration-row-limit' AND entity_type LIKE 'graph_%'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.error).toBeInstanceOf(ProductMigrationGraph.ImportError)
  expect(result.error?.message).toContain("graph_node row limit")
  expect(result.mappings).toEqual([])
})

test("imports promoted history snapshots distinctly in source project-wide order", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedPromotedHistory(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTargetBatch(db, {
        migrationID: "migration-promoted",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        targetProjectID: "project-target",
        sessions: [
          { sourceID: "ses_second", targetID: "ses_target_second" },
          { sourceID: "ses_first", targetID: "ses_target_first" },
        ],
      })
      yield* db.run(sql`
        INSERT INTO graph_version (id, project_id, session_id, version_number, message, snapshot, time_created)
        VALUES ('preexisting-version', 'project-target', NULL, 7, 'preexisting', '{"nodes":[],"edges":[]}', 1)
      `)
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration.import({
        migrationID: "migration-promoted",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_second", "ses_first"],
      })
      const retry = yield* migration.import({
        migrationID: "migration-promoted",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_first", "ses_second"],
      })
      return {
        imported,
        retry,
        liveNodes: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_node WHERE session_id IN ('ses_target_first', 'ses_target_second')
        `),
        versions: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_version WHERE project_id = 'project-target' ORDER BY version_number
        `),
        audits: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_tool_run
          WHERE session_id IN ('ses_target_first', 'ses_target_second')
          ORDER BY tool_name
        `),
        generations: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_generation_run
          WHERE session_id IN ('ses_target_first', 'ses_target_second')
        `),
        drafts: yield* db.all<Record<string, unknown>>(sql`
          SELECT * FROM graph_artifact_draft
          WHERE session_id IN ('ses_target_first', 'ses_target_second')
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported.sessions.every((session) => session.strategy === "legacy")).toBe(true)
  expect(result.retry.sessions.map((session) => session.versionID).sort()).toEqual(
    result.imported.sessions.map((session) => session.versionID).sort(),
  )
  expect(result.liveNodes).toEqual([])
  expect(result.versions.map((version) => version.version_number)).toEqual([7, 8, 9])
  expect(result.versions.map((version) => version.message)).toEqual([
    "preexisting",
    "first promoted",
    "second promoted",
  ])
  const snapshots = result.versions.slice(1).map(
    (version) =>
      JSON.parse(String(version.snapshot)) as {
        nodes: Array<Record<string, unknown>>
        edges: Array<Record<string, unknown>>
      },
  )
  expect(snapshots[0]?.nodes.map((node) => node.name)).toEqual(["First snapshot task"])
  expect(snapshots[1]?.nodes.map((node) => node.name)).toEqual(["Second snapshot goal", "Second snapshot task"])
  expect(snapshots[0]?.nodes[0]).toMatchObject({
    project_id: "project-target",
    session_id: "ses_target_first",
    status: "pending",
    test_status: "none",
  })
  expect(snapshots[1]?.nodes.find((node) => node.name === "Second snapshot task")).toMatchObject({
    status: "pending",
    test_status: "none",
  })
  expect(
    snapshots.flatMap((snapshot) => snapshot.nodes).every((node) => !String(node.id).startsWith("promoted-node")),
  ).toBe(true)
  expect(
    snapshots.flatMap((snapshot) => snapshot.edges).every((edge) => !String(edge.id).startsWith("promoted-edge")),
  ).toBe(true)
  expect(JSON.stringify(snapshots)).not.toContain("project-source")
  expect(JSON.stringify(snapshots)).not.toContain("ses_first")
  expect(JSON.stringify(snapshots)).not.toContain("ses_second")
  expect(result.drafts).toEqual([])
  expect(result.generations).toEqual([])
  const snapshotEvidence = result.audits.find((row) => row.tool_name === "graph.diagnostics.run")
  expect(snapshotEvidence?.node_id).toBeNull()
  expect(JSON.parse(String(snapshotEvidence?.evidence))).toMatchObject({ nodeID: "source:promoted-node-first" })
  expect(result.audits.find((row) => row.tool_name === "product_migration.graph_artifact_draft")).toMatchObject({
    node_id: null,
    status: "blocked",
  })
  expect(result.audits.find((row) => row.tool_name === "product_migration.graph_generation_run")).toMatchObject({
    node_id: null,
    status: "blocked",
  })
})

test("falls back only the corrupt selected session while importing compatible peers", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedPerSessionCorruption(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTargetBatch(db, {
        migrationID: "migration-isolated",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        targetProjectID: "project-target",
        sessions: [
          { sourceID: "ses_good", targetID: "ses_target_good" },
          { sourceID: "ses_bad", targetID: "ses_target_bad" },
        ],
      })
      const migration = yield* ProductMigrationGraph.Service
      return yield* migration.import({
        migrationID: "migration-isolated",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_good", "ses_bad"],
      })
    }).pipe(Effect.provide(layer)),
  )

  expect(result.sessions.find((session) => session.sourceSessionID === "ses_good")?.strategy).toBe("legacy")
  expect(result.sessions.find((session) => session.sourceSessionID === "ses_bad")?.strategy).toBe("reconstructed")
})

test("reserves legacy versions before caller-first reconstruction and preserves result order", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedPerSessionCorruption(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTargetBatch(db, {
        migrationID: "migration-reservation",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        targetProjectID: "project-target",
        sessions: [
          { sourceID: "ses_bad", targetID: "ses_target_bad" },
          { sourceID: "ses_good", targetID: "ses_target_good" },
        ],
      })
      const migration = yield* ProductMigrationGraph.Service
      const input = {
        migrationID: "migration-reservation",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_bad", "ses_good", "ses_bad"],
      }
      const imported = yield* migration.import(input)
      const retry = yield* migration.import(input)
      return {
        imported,
        retry,
        versions: yield* db.all<{ id: string; session_id: string | null; version_number: number }>(sql`
          SELECT id, session_id, version_number FROM graph_version
          WHERE project_id = 'project-target' ORDER BY version_number
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported.sessions.map((session) => session.sourceSessionID)).toEqual(["ses_bad", "ses_good"])
  expect(result.imported.sessions.map((session) => session.strategy)).toEqual(["reconstructed", "legacy"])
  expect(result.retry).toEqual(result.imported)
  expect(result.versions.map((version) => version.version_number)).toEqual([1, 2])
  expect(new Set(result.versions.map((version) => version.version_number)).size).toBe(result.versions.length)
  expect(result.versions.map((version) => version.session_id)).toEqual(["ses_target_good", "ses_target_bad"])
})

test("reconstructs with a bounded audit when a present mixed Graph table is incompatible", async () => {
  await using tmp = await tmpdir()
  const sourceDatabase = path.join(tmp.path, "source", "opencode.db")
  const targetDatabase = path.join(tmp.path, "target", "graph-vibe.db")
  await mkdir(path.dirname(sourceDatabase), { recursive: true })
  await mkdir(path.dirname(targetDatabase), { recursive: true })
  seedIncompatibleMixedGraph(sourceDatabase)
  const sourcePath = await realpath(sourceDatabase)
  const identity = await sourceIdentity(sourcePath)
  const layer = ProductMigrationGraph.layer.pipe(Layer.provideMerge(Database.layerFromPath(targetDatabase)))

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedTarget(db, {
        migrationID: "migration-incompatible",
        sourceDatabase: sourcePath,
        sourceFingerprint: identity.fingerprint,
        sourceSessionID: "ses_source",
        targetSessionID: "ses_target",
        sourceProjectID: "project-source",
        targetProjectID: "project-target",
        metadata: migrationMetadata("migration-incompatible", "ses_source", false, "ready"),
      })
      yield* seedCopiedHistory(db, "ses_target")
      const migration = yield* ProductMigrationGraph.Service
      const imported = yield* migration.import({
        migrationID: "migration-incompatible",
        sourceDatabase: sourcePath,
        databaseFingerprint: identity.fingerprint,
        sourceSessionIDs: ["ses_source"],
      })
      return {
        imported,
        warning: yield* db.get<Record<string, unknown>>(sql`
          SELECT * FROM graph_tool_run
          WHERE session_id = 'ses_target' AND tool_name = 'product_migration.graph_table_unsupported'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.imported.sessions[0]?.strategy).toBe("reconstructed")
  expect(result.warning).toMatchObject({ status: "blocked", node_id: null })
  expect(String(result.warning?.error)).toContain("graph_tool_run")
  expect(String(result.warning?.error).length).toBeLessThanOrEqual(1_024)
})

function seedKnownLegacyGraph(database: string) {
  const source = new sqlite.Database(database, { create: true })
  source.run(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    INSERT INTO session VALUES ('ses_source');
    CREATE TABLE graph_node (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, level TEXT NOT NULL, priority TEXT, category TEXT, status TEXT,
      desc TEXT, content TEXT, code_hash TEXT, test_status TEXT, confidence REAL,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_edge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL, time_created INTEGER
    );
    CREATE TABLE graph_version (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, version_number INTEGER,
      message TEXT, snapshot TEXT, time_created INTEGER
    );
    CREATE TABLE graph_tool_run (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, node_id TEXT,
      tool_name TEXT, tool_type TEXT, input_summary TEXT, output_summary TEXT,
      status TEXT, error TEXT, evidence TEXT, time_created INTEGER
    );
    CREATE TABLE graph_workflow_state (
      session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mode TEXT, current_node_id TEXT,
      checkpoint_kind TEXT, checkpoint_scope_node_id TEXT, checkpoint_status TEXT,
      checkpoint_reason TEXT, revision INTEGER, active_operation_id TEXT,
      active_operation_kind TEXT, active_operation_started_at INTEGER,
      active_operation_process_id INTEGER, active_operation_runtime_id TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_artifact_draft (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
      status TEXT NOT NULL, test TEXT NOT NULL, files TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_generation_run (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, node_id TEXT NOT NULL,
      executor TEXT NOT NULL, backend TEXT, model TEXT, context_snapshot_hash TEXT,
      status TEXT NOT NULL, gate_result TEXT NOT NULL, artifact_summary TEXT,
      diagnostics_summary TEXT, time_created INTEGER
    );
  `)
  const insertNode = source.prepare(`
    INSERT INTO graph_node
      (id, project_id, session_id, type, name, level, status, content, test_status, confidence,
       time_created, time_updated)
    VALUES (?, 'project-source', 'ses_source', ?, ?, ?, ?, ?, ?, 1, 1, 1)
  `)
  insertNode.run(
    "node-root",
    "prd",
    "Legacy goal",
    "L1",
    "pending",
    JSON.stringify({ source_message_ids: ["msg_source"] }),
    "none",
  )
  insertNode.run("node-verified", "atomic", "Evidence verified", "L2", "verified", "{}", "passed")
  insertNode.run(
    "node-claimed",
    "atomic",
    "Prose verified",
    "L2",
    "verified",
    JSON.stringify({ claim: "verified" }),
    "passed",
  )
  insertNode.run("node-implemented", "atomic", "Artifact implemented", "L2", "implemented", "{}", "pending")
  insertNode.run("node-wrong-type", "atomic", "Wrong evidence type", "L2", "verified", "{}", "passed")
  insertNode.run("node-wrong-reference", "atomic", "Wrong evidence node", "L2", "verified", "{}", "passed")
  source.run(`
    INSERT INTO graph_edge VALUES
      ('edge-contains', 'project-source', 'ses_source', 'node-root', 'node-verified', 'contains', 1, 1),
      ('edge-blocks', 'project-source', 'ses_source', 'node-verified', 'node-claimed', 'blocks', 1, 1)
  `)
  source
    .prepare(`INSERT INTO graph_version VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "version-legacy",
      "project-source",
      "ses_source",
      3,
      "legacy",
      JSON.stringify({ nodes: [{ id: "node-root" }], edges: [{ id: "edge-contains" }] }),
      1,
    )
  source.prepare(`INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evidence-verified",
    "project-source",
    "ses_source",
    "node-verified",
    "graph.diagnostics.run",
    "diagnostics",
    "test",
    "passed",
    "succeeded",
    null,
    JSON.stringify({
      kind: "diagnostics",
      nodeID: "node-verified",
      criteria: ["legacy check"],
      artifactPaths: ["packages/core/src/product-migration/graph.ts"],
      projectChecksOnly: false,
      complete: true,
      passed: true,
      commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true }],
    }),
    1,
  )
  source.prepare(`INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evidence-implemented",
    "project-source",
    "ses_source",
    "node-implemented",
    "graph.artifact.apply",
    "artifact",
    "write",
    "created",
    "succeeded",
    null,
    JSON.stringify({
      kind: "artifact",
      nodeID: "node-implemented",
      artifactPaths: ["packages/core/src/product-migration/graph.ts"],
    }),
    1,
  )
  source.prepare(`INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evidence-failed",
    "project-source",
    "ses_source",
    "node-claimed",
    "graph.diagnostics.failed",
    "diagnostics",
    `Authorization: Bearer audit-secret-token ${"x".repeat(2_000)}`,
    'password="multi word audit password"',
    "failed",
    "https://audit-user:url-password@example.com/private",
    JSON.stringify({
      kind: "diagnostics",
      nodeID: "node-claimed",
      criteria: ["legacy check"],
      artifactPaths: [],
      projectChecksOnly: false,
      complete: true,
      passed: false,
      commands: [
        { name: "test", command: "API_KEY=audit-secret-token bun test", exitCode: 1, timedOut: false, passed: false },
      ],
    }),
    2,
  )
  source.prepare(`INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evidence-wrong-type",
    "project-source",
    "ses_source",
    "node-wrong-type",
    "graph.diagnostics.run",
    "artifact",
    null,
    null,
    "succeeded",
    null,
    JSON.stringify({
      kind: "diagnostics",
      nodeID: "node-wrong-type",
      criteria: ["wrong type"],
      artifactPaths: [],
      projectChecksOnly: false,
      complete: true,
      passed: true,
      commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true }],
    }),
    3,
  )
  source.prepare(`INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evidence-wrong-node",
    "project-source",
    "ses_source",
    "node-wrong-reference",
    "graph.diagnostics.run",
    "diagnostics",
    null,
    null,
    "succeeded",
    null,
    JSON.stringify({
      kind: "diagnostics",
      nodeID: "node-verified",
      criteria: ["wrong node"],
      artifactPaths: [],
      projectChecksOnly: false,
      complete: true,
      passed: true,
      commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true }],
    }),
    4,
  )
  source.run(`
    INSERT INTO graph_workflow_state VALUES
      ('ses_source', 'project-source', 'atomic', 'node-verified', 'atomic', 'node-verified',
       'approved', NULL, 4, 'source-operation', 'artifact_apply', 1, 999999, 'source-runtime', 1, 2);
    INSERT INTO graph_artifact_draft VALUES
      ('draft-source', 'project-source', 'ses_source', 'node-implemented', 'sealed',
       'bun test', '[{"path":"src/unsafe.ts","chunks":[{"index":0,"content":"secret draft"}]}]', 1, 2);
    INSERT INTO graph_generation_run VALUES
      ('generation-source', 'project-source', 'ses_source', 'node-verified', 'agent', 'native',
       'https://model-user:url-password@example.com/model', 'snapshot-hash', 'blocked',
       '{"allowed":false,"issues":[{"message":"audit-secret-token"}],"requiredPermissions":[]}',
       'password="multi word audit password"', 'Authorization: Bearer audit-secret-token', 3);
  `)
  source.prepare("UPDATE graph_generation_run SET gate_result = ? WHERE id = 'generation-source'").run(
    JSON.stringify({
      allowed: false,
      issues: [
        ...Array.from({ length: 80 }, (_, index) => ({
          code: "invalid_artifact",
          severity: "block",
          nodeID: `node-${index}-${"n".repeat(400)}`,
          message: `Authorization: Bearer audit-secret-token ${"x".repeat(4_000)}`,
          nested: { secret: "audit-secret-token", payload: "y".repeat(4_000) },
        })),
        { code: "unknown", severity: "block", message: "invalid code" },
        { code: "invalid_artifact", severity: "fatal", message: "invalid severity" },
      ],
      requiredPermissions: ["artifact_write", "unknown", "diagnostics_run", "artifact_write"],
      nested: { secret: "audit-secret-token", payload: "z".repeat(100_000) },
    }),
  )
  source.close()
}

function seedPromotedHistory(database: string) {
  const source = new sqlite.Database(database, { create: true })
  source.run(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    INSERT INTO session VALUES ('ses_first'), ('ses_second');
    CREATE TABLE graph_node (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, level TEXT NOT NULL, priority TEXT, category TEXT, status TEXT,
      desc TEXT, content TEXT, verification TEXT, code_hash TEXT, test_status TEXT,
      confidence REAL, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_edge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL, time_created INTEGER
    );
    CREATE TABLE graph_version (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, version_number INTEGER,
      message TEXT, snapshot TEXT, time_created INTEGER
    );
    CREATE TABLE graph_tool_run (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, node_id TEXT,
      tool_name TEXT, tool_type TEXT, input_summary TEXT, output_summary TEXT,
      status TEXT, error TEXT, evidence TEXT, time_created INTEGER
    );
    CREATE TABLE graph_artifact_draft (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
      status TEXT NOT NULL, test TEXT NOT NULL, files TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_generation_run (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, node_id TEXT NOT NULL,
      executor TEXT NOT NULL, backend TEXT, model TEXT, context_snapshot_hash TEXT,
      status TEXT NOT NULL, gate_result TEXT NOT NULL, artifact_summary TEXT,
      diagnostics_summary TEXT, time_created INTEGER
    );
  `)
  const first = {
    nodes: [
      snapshotNode("promoted-node-first", "ses_first", "atomic", "First snapshot task", "L2", "implemented", "pending"),
    ],
    edges: [],
  }
  const second = {
    nodes: [
      snapshotNode("promoted-node-goal", "ses_second", "prd", "Second snapshot goal", "L1", "pending", "none"),
      snapshotNode("promoted-node-second", "ses_second", "atomic", "Second snapshot task", "L2", "verified", "passed"),
    ],
    edges: [
      {
        id: "promoted-edge-second",
        project_id: "project-source",
        session_id: "ses_second",
        source_id: "promoted-node-goal",
        target_id: "promoted-node-second",
        relation: "contains",
        confidence: 1,
        time_created: 20,
      },
    ],
  }
  source
    .prepare("INSERT INTO graph_version VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("version-second", "project-source", "ses_second", 2, "second promoted", JSON.stringify(second), 20)
  source
    .prepare("INSERT INTO graph_version VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("version-first", "project-source", "ses_first", 1, "first promoted", JSON.stringify(first), 10)
  source.prepare("INSERT INTO graph_tool_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "snapshot-evidence",
    "project-source",
    "ses_first",
    "promoted-node-first",
    "graph.diagnostics.run",
    "diagnostics",
    "test",
    "passed",
    "succeeded",
    null,
    JSON.stringify({
      kind: "diagnostics",
      nodeID: "promoted-node-first",
      criteria: ["historical"],
      artifactPaths: [],
      projectChecksOnly: false,
      complete: true,
      passed: true,
      commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true }],
    }),
    11,
  )
  source.run(`
    INSERT INTO graph_artifact_draft VALUES
      ('snapshot-draft', 'project-source', 'ses_first', 'promoted-node-first', 'sealed',
       'bun test', '[{"path":"src/history.ts","chunks":[{"index":0,"content":"historical"}]}]', 11, 12);
    INSERT INTO graph_generation_run VALUES
      ('snapshot-generation', 'project-source', 'ses_first', 'promoted-node-first', 'agent', 'native',
       'model', 'snapshot', 'blocked',
       '{"allowed":false,"issues":[],"requiredPermissions":[]}', NULL, 'historical', 12);
  `)
  source.close()
}

function seedPerSessionCorruption(database: string) {
  const source = new sqlite.Database(database, { create: true })
  source.run(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    INSERT INTO session VALUES ('ses_good'), ('ses_bad');
    CREATE TABLE graph_node (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, level TEXT NOT NULL, status TEXT, content TEXT, verification TEXT,
      test_status TEXT, confidence REAL, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE graph_edge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL, time_created INTEGER
    );
    CREATE TABLE graph_version (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, version_number INTEGER,
      message TEXT, snapshot TEXT, time_created INTEGER
    );
    INSERT INTO graph_node
      (id, project_id, session_id, type, name, level, status, content, test_status, confidence,
       time_created, time_updated)
    VALUES ('good-node', 'project-source', 'ses_good', 'atomic', 'Good current task', 'L2',
            'pending', '{}', 'none', 1, 1, 1);
  `)
  source.prepare("INSERT INTO graph_version VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "good-version",
    "project-source",
    "ses_good",
    1,
    "good",
    JSON.stringify({
      nodes: [snapshotNode("good-node", "ses_good", "atomic", "Good current task", "L2", "pending", "none")],
      edges: [],
    }),
    1,
  )
  source
    .prepare("INSERT INTO graph_version VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("bad-version", "project-source", "ses_bad", 2, "bad", "{", 2)
  source.close()
}

function seedIncompatibleMixedGraph(database: string) {
  const source = new sqlite.Database(database, { create: true })
  source.run(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    INSERT INTO session VALUES ('ses_source');
    CREATE TABLE graph_node (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, level TEXT NOT NULL
    );
    CREATE TABLE graph_edge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, relation TEXT NOT NULL
    );
    CREATE TABLE graph_tool_run (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, node_id TEXT,
      tool_name TEXT, tool_type TEXT
    );
    INSERT INTO graph_node VALUES
      ('incompatible-node', 'project-source', 'ses_source', 'atomic', 'Legacy incompatible task', 'L2');
  `)
  source.close()
}

function snapshotNode(
  id: string,
  sessionID: string,
  type: "prd" | "atomic",
  name: string,
  level: "L1" | "L2",
  status: string,
  testStatus: string,
) {
  return {
    id,
    project_id: "project-source",
    session_id: sessionID,
    type,
    name,
    level,
    priority: null,
    category: null,
    status,
    desc: null,
    content: {},
    verification: type === "atomic" ? { criteria: [`Verify ${name}`], diagnostics: [{ name: "test" }] } : null,
    code_hash: null,
    test_status: testStatus,
    confidence: 1,
    time_created: 1,
    time_updated: 1,
  }
}

function seedUnsupportedGraph(database: string, kind: "absent" | "unknown" | "corrupt") {
  const source = new sqlite.Database(database, { create: true })
  source.run(
    "CREATE TABLE source_marker (id TEXT PRIMARY KEY); CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('ses_source')",
  )
  if (kind === "unknown") source.run("CREATE TABLE graph_node (id TEXT PRIMARY KEY, payload BLOB)")
  if (kind === "corrupt") {
    source.run(`
      CREATE TABLE graph_node (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
        name TEXT NOT NULL, level TEXT NOT NULL, content TEXT
      );
      CREATE TABLE graph_edge (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
        target_id TEXT NOT NULL, relation TEXT NOT NULL
      );
      INSERT INTO graph_node
        (id, project_id, session_id, type, name, level, content)
      VALUES ('corrupt-node', 'project-source', 'ses_source', 'atomic', 'Corrupt', 'L2', '{');
    `)
  }
  source.close()
}

function seedTarget(
  db: Database.Interface["db"],
  input: {
    readonly migrationID: string
    readonly sourceDatabase: string
    readonly sourceFingerprint: string
    readonly sourceSessionID: string
    readonly targetSessionID: string
    readonly sourceProjectID: string
    readonly targetProjectID: string
    readonly metadata: string
  },
) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO product_migration
        (id, status, source_path, source_fingerprint, revision, time_created, time_updated)
      VALUES (${input.migrationID}, 'copying', ${input.sourceDatabase}, ${input.sourceFingerprint}, 1, 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES (${input.targetProjectID}, '/copied/project', 'Migrated', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session
        (id, project_id, slug, directory, title, version, metadata, model, cost, tokens_input,
         tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
      VALUES
        (${input.targetSessionID}, ${input.targetProjectID}, 'migrated', '/copied/project', 'Migrated', '1',
         ${input.metadata}, ${JSON.stringify({ providerID: "provider-test", id: "model-test" })},
         0, 0, 0, 0, 0, 0, 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO product_migration_entity
        (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
      VALUES
        (${input.migrationID}, 'project', ${input.sourceProjectID}, ${input.sourceFingerprint},
         ${input.targetProjectID}, 1, 1),
        (${input.migrationID}, 'session', ${input.sourceSessionID}, ${input.sourceFingerprint},
         ${input.targetSessionID}, 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_history', ${input.sourceFingerprint},
         'msg_history', 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_claim', ${input.sourceFingerprint},
         'msg_claim', 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_shell', ${input.sourceFingerprint},
         'msg_shell', 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_system', ${input.sourceFingerprint},
         'msg_system', 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_synthetic', ${input.sourceFingerprint},
         'msg_synthetic', 1, 1),
        (${input.migrationID}, 'session_message', 'msg_source_unrelated_shell', ${input.sourceFingerprint},
         'msg_unrelated_shell', 1, 1)
    `)
  })
}

function seedTargetBatch(
  db: Database.Interface["db"],
  input: {
    readonly migrationID: string
    readonly sourceDatabase: string
    readonly sourceFingerprint: string
    readonly targetProjectID: string
    readonly sessions: ReadonlyArray<{ readonly sourceID: string; readonly targetID: string }>
  },
) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO product_migration
        (id, status, source_path, source_fingerprint, revision, time_created, time_updated)
      VALUES (${input.migrationID}, 'copying', ${input.sourceDatabase}, ${input.sourceFingerprint}, 1, 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES (${input.targetProjectID}, '/copied/project', 'Migrated', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO product_migration_entity
        (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
      VALUES (${input.migrationID}, 'project', 'project-source', ${input.sourceFingerprint},
              ${input.targetProjectID}, 1, 1)
    `)
    yield* Effect.forEach(
      input.sessions,
      (session) =>
        Effect.gen(function* () {
          yield* db.run(sql`
          INSERT INTO session
            (id, project_id, slug, directory, title, version, metadata, cost, tokens_input,
             tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
          VALUES
            (${session.targetID}, ${input.targetProjectID}, ${session.targetID}, '/copied/project',
             ${session.targetID}, '1', ${migrationMetadata(input.migrationID, session.sourceID, false, "ready")},
             0, 0, 0, 0, 0, 0, 1, 1)
        `)
          yield* db.run(sql`
          INSERT INTO product_migration_entity
            (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
          VALUES (${input.migrationID}, 'session', ${session.sourceID}, ${input.sourceFingerprint},
                  ${session.targetID}, 1, 1)
        `)
        }),
      { discard: true },
    )
  })
}

function seedCopiedHistory(db: Database.Interface["db"], sessionID: string) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
      VALUES
        ('msg_history', ${sessionID}, 'user', 1, 1, 1, ${JSON.stringify({
          text: [
            "Goal: Build storage migration",
            "Module: Import graph",
            "Task: Parse known graph",
            "Task: Reconstruct history",
            "Dependency: Parse known graph -> Reconstruct history",
            "Artifact: packages/core/src/product-migration/graph.ts",
            "Diagnostic: bun test test/product-migration-graph.test.ts",
            "Everything is implemented and verified.",
            "API_KEY=supersecretvalue",
            `OPENAI_API_KEY=${enhancementSecrets[0]}`,
            `SERVICE_TOKEN=${enhancementSecrets[1]}`,
            `DB_SECRET=${enhancementSecrets[2]}`,
            `ADMIN_PASSWORD="${enhancementSecrets[3]}"`,
            `AWS_ACCESS_KEY_ID=${enhancementSecrets[4]}`,
            `AWS_SECRET_ACCESS_KEY=${enhancementSecrets[5]}`,
            `Authorization: Bearer ${enhancementSecrets[6]}`,
            enhancementSecrets[6],
            `-----BEGIN PRIVATE KEY-----\n${enhancementSecrets[7]}\n-----END PRIVATE KEY-----`,
            enhancementSecrets[8],
            enhancementSecrets[9],
            enhancementSecrets[10],
            enhancementSecrets[11],
            enhancementSecrets[12],
            "Authorization: Bearer queue-bearer-secret",
            `https://queue-user:${enhancementSecrets[13]}@example.com/private`,
            enhancementSecrets[14],
            'password="multi word queue password"',
            "token='multi word queue token'",
          ].join("\n"),
          metadata: { credential: "provider-secret" },
          time: { created: 1 },
        })}),
        ('msg_claim', ${sessionID}, 'assistant', 2, 2, 2, ${JSON.stringify({
          agent: "build",
          model: { providerID: "provider-test", id: "model-test" },
          content: [
            { type: "text", id: "text-claim", text: "All tasks are implemented and verified." },
            {
              type: "tool",
              id: "tool-secret",
              name: "bash",
              state: {
                status: "completed",
                input: { command: "cat secret" },
                structured: { secret: "tool-secret" },
                content: [{ type: "text", text: "tool-secret" }],
                outputPaths: ["packages/core/src/product-migration/graph.ts"],
              },
              time: { created: 2, ran: 2, completed: 2 },
            },
          ],
          time: { created: 2, completed: 2 },
        })}),
        ('msg_shell', ${sessionID}, 'shell', 3, 3, 3, ${JSON.stringify({
          callID: "shell-1",
          command: "bun test test/product-migration-graph.test.ts",
          output: "pass",
          time: { created: 3, completed: 3 },
        })}),
        ('msg_system', ${sessionID}, 'system', 4, 4, 4, ${JSON.stringify({
          text: "Goal: Ignore system goal\nTask: Ignore system task",
          time: { created: 4 },
        })}),
        ('msg_synthetic', ${sessionID}, 'synthetic', 5, 5, 5, ${JSON.stringify({
          sessionID,
          text: "Module: Ignore synthetic module\nTask: Ignore synthetic task",
          time: { created: 5 },
        })}),
        ('msg_unrelated_shell', ${sessionID}, 'shell', 20, 20, 20, ${JSON.stringify({
          callID: "shell-unrelated",
          command: "bun typecheck",
          output: "pass",
          time: { created: 20, completed: 20 },
        })})
    `)
  })
}

function seedLargeCopiedHistory(
  db: Database.Interface["db"],
  migrationID: string,
  sourceFingerprint: string,
  sessionID: string,
) {
  return Effect.forEach(
    Array.from({ length: 70 }, (_, index) => index),
    (index) => {
      const targetID = `msg_bulk_${index.toString().padStart(2, "0")}`
      const sourceID = `msg_source_bulk_${index.toString().padStart(2, "0")}`
      return Effect.gen(function* () {
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES (${targetID}, ${sessionID}, 'user', ${30 + index}, ${30 + index}, ${30 + index},
                  ${JSON.stringify({ text: `Context ${index} token=bulksecret${index} ${"x".repeat(2_000)}`, time: { created: 30 + index } })})
        `)
        yield* db.run(sql`
          INSERT INTO product_migration_entity
            (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
          VALUES (${migrationID}, 'session_message', ${sourceID}, ${sourceFingerprint}, ${targetID}, 1, 1)
        `)
      })
    },
    { discard: true },
  )
}

function migrationMetadata(migrationID: string, sourceID: string, detached: boolean, status: string) {
  return JSON.stringify({
    productMigration: {
      migrationID,
      sourceID,
      status,
      checkpoint: detached ? "paused" : "none",
      detached,
      missingParent: false,
      missingWorkspace: false,
      neutralizedInputIDs: [],
      replay: false,
    },
  })
}

async function databaseHash(database: string) {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(database).arrayBuffer()))
    .digest("hex")
}

async function sourceIdentity(database: string) {
  const identity = await ProductMigrationSource.databaseIdentity(database)
  const source = new sqlite.Database(database, { readonly: true, strict: true })
  const sessionCount = source.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0
  source.close()
  return {
    ...identity,
    fingerprint: ProductMigrationSource.fingerprint({
      database,
      databaseBytes: identity.size,
      sessionCount,
      identity,
    }),
  }
}
