import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, rename } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Product } from "@opencode-ai/core/product"
import { ProductMigrationService } from "@opencode-ai/core/product-migration/service"
import { ProductMigrationSourceRoots } from "@opencode-ai/core/product-migration/roots"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { tmpdir } from "../fixture/fixture"

const sqlite = await import("bun:sqlite")

test("migrates an active-WAL OpenCode fixture through validation and finalization without source writes", async () => {
  await using tmp = await tmpdir()
  const fixture = await migrationFixture(tmp.path)
  const writer = new sqlite.Database(fixture.sourceDatabase)
  try {
    expect(
      writer
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual([
      "credential",
      "graph_edge",
      "graph_node",
      "graph_version",
      "message",
      "part",
      "permission",
      "project",
      "project_directory",
      "session",
      "session_input",
      "session_message",
      "todo",
      "workspace",
    ])
    expect(writer.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1)
    writer.run("PRAGMA foreign_keys = ON")
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
    seedSource(writer, fixture)
    expect(Bun.file(`${fixture.sourceDatabase}-wal`).size).toBeGreaterThan(0)
    const rewrite = path.join(fixture.sourceData, "unexpected.bin")
    const rewriteBefore = (await sourceManifest(fixture)).find((entry) => entry.path.endsWith("unexpected.bin"))
    await Bun.write(`${rewrite}.replacement`, await Bun.file(rewrite).bytes())
    await rename(`${rewrite}.replacement`, rewrite)
    const rewriteAfter = (await sourceManifest(fixture)).find((entry) => entry.path.endsWith("unexpected.bin"))
    expect(rewriteAfter?.sha256).toBe(rewriteBefore?.sha256)
    expect(rewriteAfter?.ino).not.toBe(rewriteBefore?.ino)
    expect(rewriteAfter).not.toEqual(rewriteBefore)
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writerMutation = (async () => {
      ready.resolve()
      await release.promise
      writer.run("UPDATE session SET time_updated = time_updated + 1 WHERE id = 'ses_normal'")
    })()
    await ready.promise
    const sourceBefore = await sourceManifest(fixture)
    release.resolve()
    await writerMutation
    const sourceStable = await sourceManifest(fixture)
    expect(sourceStable).not.toEqual(sourceBefore)
    expect(sourceStable.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "source/config/unexpected/nested.txt",
        "source/data/opencode.db",
        "source/data/opencode.db-shm",
        "source/data/opencode.db-wal",
        "source/data/unexpected.bin",
        "source/state/unexpected.json",
      ]),
    )
    expect(
      sourceStable.every(
        (entry) =>
          Number.isInteger(entry.mode) &&
          /^\d+$/.test(entry.ino) &&
          /^\d+$/.test(entry.size) &&
          /^\d+$/.test(entry.mtimeNs) &&
          /^\d+$/.test(entry.ctimeNs),
      ),
    ).toBe(true)
    const layer = AppNodeBuilder.build(
      LayerNode.group([ProductMigrationService.node, ProductMigrationState.node, Database.node, EventV2.node]),
      [
        [Database.node, Database.layerFromPath(fixture.targetDatabase)],
        [Product.node, Product.layerWith(Product.GraphVibe)],
        [
          Global.node,
          Global.layerWith({
            home: fixture.root,
            data: fixture.targetData,
            config: fixture.targetConfig,
            state: fixture.targetState,
            cache: fixture.targetCache,
            tmp: fixture.targetTmp,
            log: path.join(fixture.targetData, "log"),
            repos: path.join(fixture.targetData, "repos"),
            bin: path.join(fixture.targetCache, "bin"),
          }),
        ],
        [
          ProductMigrationSourceRoots.node,
          ProductMigrationSourceRoots.layerWith([
            {
              id: "fixture",
              data: fixture.sourceData,
              config: fixture.sourceConfig,
              state: fixture.sourceState,
              database: fixture.sourceDatabase,
            },
          ]),
        ],
        [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
      ],
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const migration = yield* ProductMigrationService.Service
        const state = yield* ProductMigrationState.Service
        expect(yield* state.requireCompleted().pipe(Effect.flip)).toMatchObject({
          _tag: "ProductMigrationRequired",
        })
        const discovered = yield* migration.discover({ expectedRevision: 0, source: "fixture" })
        expect(discovered.source).toMatchObject({ mixedGraph: true, sessionCount: 5 })
        expect(discovered.plan?.categories).toEqual([
          expect.objectContaining({ category: "config", available: true }),
          expect.objectContaining({ category: "credentials", available: true }),
          expect.objectContaining({ category: "mcp", available: true }),
        ])

        const selections = discovered.plan?.projects.flatMap((project) =>
          project.sessions.map((session) => ({
            projectID: project.id,
            sessionID: session.id,
            selected: session.id !== "ses_unselected",
          })),
        )
        if (!selections) return yield* Effect.die("Expected discovered sessions")
        const configDraft = yield* migration.updateDraft({
          expectedRevision: discovered.revision,
          categories: [
            { category: "config", selected: true },
            { category: "credentials", selected: false },
            { category: "mcp", selected: false },
          ],
          sessionsEnabled: false,
          sessions: [],
        })
        expect(configDraft.items.map((item) => item.itemID)).toEqual(["category:config"])
        const credentialsDraft = yield* migration.updateDraft({
          expectedRevision: configDraft.revision,
          categories: [
            { category: "config", selected: false },
            { category: "credentials", selected: true },
            { category: "mcp", selected: false },
          ],
          sessionsEnabled: false,
          sessions: [],
        })
        expect(credentialsDraft.items.map((item) => item.itemID)).toEqual(["category:credentials"])
        const mcpDraft = yield* migration.updateDraft({
          expectedRevision: credentialsDraft.revision,
          categories: [
            { category: "config", selected: false },
            { category: "credentials", selected: false },
            { category: "mcp", selected: true },
          ],
          sessionsEnabled: false,
          sessions: [],
        })
        expect(mcpDraft.items.map((item) => item.itemID)).toEqual(["category:mcp"])
        const draft = yield* migration.updateDraft({
          expectedRevision: mcpDraft.revision,
          categories: [
            { category: "config", selected: true },
            { category: "credentials", selected: true },
            { category: "mcp", selected: true },
          ],
          sessionsEnabled: true,
          sessions: selections,
          currentProject: fixture.projectDirectory,
        })
        expect(draft.items.map((item) => item.itemID)).toEqual([
          "category:config",
          "category:credentials",
          "category:mcp",
          "session:ses_active",
          "session:ses_corrupt",
          "session:ses_detached",
          "session:ses_normal",
        ])

        const failed = yield* migration.execute({ expectedRevision: draft.revision })
        expect(failed.status).toBe("failed")
        expect(failed.items.find((item) => item.itemID === "session:ses_corrupt")?.status).toBe("failed")
        expect(
          failed.items
            .filter((item) => item.itemID !== "session:ses_corrupt")
            .every((item) => item.status === "completed"),
        ).toBe(true)
        const skipped = yield* migration.skip({
          expectedRevision: failed.revision,
          itemID: "session:ses_corrupt",
        })
        expect(skipped.items.find((item) => item.itemID === "session:ses_corrupt")?.status).toBe("skipped")
        expect(
          skipped.plan?.projects.flatMap((project) => project.sessions).find((session) => session.id === "ses_corrupt")
            ?.selected,
        ).toBe(false)

        const resumed = yield* migration.execute({ expectedRevision: skipped.revision })
        const validated = yield* migration.validate({ expectedRevision: resumed.revision })
        expect(validated).toMatchObject({
          status: "ready_to_finalize",
          canFinalize: true,
          validation: { valid: true, issues: [] },
        })
        expect(yield* state.requireCompleted().pipe(Effect.flip)).toMatchObject({
          _tag: "ProductMigrationRequired",
        })

        const { db } = yield* Database.Service
        const entities = yield* db.all<{ entity_type: string; source_id: string; target_id: string }>(sql`
        SELECT entity_type, source_id, target_id FROM product_migration_entity
        WHERE migration_id = 'opencode-first-import'
        ORDER BY entity_type, source_id
      `)
        const sessionMappings = entities.filter((item) => item.entity_type === "session")
        const targets = new Map(sessionMappings.map((item) => [item.source_id, item.target_id]))
        const activeTarget = targets.get("ses_active")
        if (!activeTarget) return yield* Effect.die("Expected active session mapping")
        const published = yield* (yield* EventV2.Service).publish(SessionEvent.AgentSwitched, {
          sessionID: SessionSchema.ID.make(activeTarget),
          messageID: SessionMessage.ID.make("msg_after_migration"),
          timestamp: yield* DateTime.now,
          agent: "review",
        })
        const sessions = yield* db.all<{ id: string; project_id: string; metadata: string }>(sql`
        SELECT id, project_id, metadata FROM session ORDER BY id
      `)
        const projects = yield* db.all<{ id: string; name: string | null; worktree: string }>(sql`
        SELECT id, name, worktree FROM project ORDER BY id
      `)
        const directories = yield* db.all<{ project_id: string; directory: string }>(sql`
        SELECT project_id, directory FROM project_directory ORDER BY project_id, directory
      `)
        const workspaces = yield* db.all<{
          id: string
          project_id: string
          name: string
          directory: string | null
        }>(sql`
        SELECT id, project_id, name, directory FROM workspace ORDER BY id
      `)
        const permissions = yield* db.all<{
          id: string
          project_id: string
          action: string
          resource: string
        }>(sql`
        SELECT id, project_id, action, resource FROM permission ORDER BY id
      `)
        const currentMessages = yield* db.all<{
          id: string
          session_id: string
          type: string
          seq: number
          data: string
        }>(sql`
        SELECT id, session_id, type, seq, data FROM session_message ORDER BY session_id, seq
      `)
        const inputs = yield* db.all<{
          id: string
          session_id: string
          prompt: string
          delivery: string
          admitted_seq: number
          promoted_seq: number | null
          time_created: number
        }>(sql`
        SELECT id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created
        FROM session_input ORDER BY session_id, admitted_seq
      `)
        const todos = yield* db.all<{
          session_id: string
          content: string
          status: string
          priority: string
          position: number
        }>(sql`
        SELECT session_id, content, status, priority, position FROM todo ORDER BY session_id, position
      `)
        const sequences = yield* db.all<{ aggregate_id: string; seq: number; owner_id: string | null }>(sql`
        SELECT aggregate_id, seq, owner_id FROM event_sequence ORDER BY aggregate_id
      `)
        const events = yield* db.all<{ aggregate_id: string; seq: number; type: string; data: string }>(sql`
        SELECT aggregate_id, seq, type, data FROM event ORDER BY aggregate_id, seq
      `)
        const legacyMessageCount = yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM message`)
        const partCount = yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM part`)
        const graphVersions = yield* db.all<{
          id: string
          session_id: string
          message: string | null
          snapshot: string
        }>(sql`
        SELECT id, session_id, message, snapshot FROM graph_version ORDER BY session_id, version_number
      `)
        const graphNodes = yield* db.all<{
          id: string
          session_id: string
          type: string
          name: string
          content: string
          confidence: number
        }>(sql`
        SELECT id, session_id, type, name, content, confidence FROM graph_node ORDER BY session_id, type, name
      `)
        const graphAudit = yield* db.all<{
          session_id: string
          tool_name: string
          status: string
          error: string | null
        }>(sql`
        SELECT session_id, tool_name, status, error FROM graph_tool_run ORDER BY session_id, tool_name
      `)
        const credentials = yield* db.all<{ id: string; value: string }>(sql`
        SELECT id, value FROM credential ORDER BY id
      `)
        const finalized = yield* migration.finalize({ expectedRevision: validated.revision })
        const gateCompleted = yield* state.requireCompleted().pipe(Effect.as(true))
        return {
          entities,
          targets,
          sessions,
          projects,
          directories,
          workspaces,
          permissions,
          currentMessages,
          inputs,
          todos,
          sequences,
          events,
          published,
          legacyMessageCount,
          partCount,
          graphVersions,
          graphNodes,
          graphAudit,
          credentials,
          finalized,
          gateCompleted,
          journal: yield* db.get<{
            status: string
            source_path: string | null
            source_fingerprint: string | null
            plan: string | null
            validation: string | null
          }>(sql`
            SELECT status, source_path, source_fingerprint, plan, validation
            FROM product_migration WHERE id = 'opencode-first-import'
          `),
          itemCount: yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM product_migration_item`),
          entityCount: yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM product_migration_entity`),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(await sourceManifest(fixture)).toEqual(sourceStable)
    expect(await Bun.file(path.join(fixture.targetConfig, "graph-vibe.json")).json()).toMatchObject({
      model: "test/model",
    })
    expect(await Bun.file(path.join(fixture.targetConfig, "plugins", "fixture.ts")).text()).toBe("export default {}")
    expect(await Bun.file(path.join(fixture.targetData, "auth.json")).json()).toEqual({
      provider: { type: "api", key: "provider-secret" },
    })
    if (process.platform !== "win32") {
      expect((await lstat(path.join(fixture.targetData, "auth.json"))).mode & 0o777).toBe(0o600)
      expect((await lstat(path.join(fixture.targetData, "mcp-auth.json"))).mode & 0o777).toBe(0o600)
    }
    expect(await Bun.file(path.join(fixture.targetData, "mcp-auth.json")).json()).toEqual({
      docs: { tokens: { accessToken: "mcp-secret" } },
    })
    expect(result.credentials).toEqual([
      expect.objectContaining({ id: "credential-fixture", value: expect.stringContaining("database-secret") }),
    ])

    expect([...result.targets.keys()]).toEqual(["ses_active", "ses_detached", "ses_normal"])
    expect(result.targets.has("ses_corrupt")).toBe(false)
    expect(result.targets.has("ses_unselected")).toBe(false)
    const activeID = result.targets.get("ses_active")
    const detachedID = result.targets.get("ses_detached")
    const normalID = result.targets.get("ses_normal")
    if (!activeID || !detachedID || !normalID) throw new Error("Expected migrated session mappings")
    const active = result.sessions.find((session) => session.id === activeID)
    const detached = result.sessions.find((session) => session.id === detachedID)
    const normal = result.sessions.find((session) => session.id === normalID)
    if (!active || !detached || !normal) throw new Error("Expected migrated sessions")
    const activeMetadata = JSON.parse(active.metadata) as MigrationMetadata
    expect(activeMetadata.productMigration).toEqual({
      migrationID: "opencode-first-import",
      sourceID: "ses_active",
      status: "needs_attention",
      checkpoint: "paused",
      detached: false,
      missingParent: false,
      missingWorkspace: false,
      neutralizedInputIDs: ["input_active"],
      closure: {
        legacyMessages: 0,
        parts: 0,
        currentMessages: 2,
        inputs: 1,
        todos: 0,
        projectID: "project-a-normal",
        projectDirectoryCount: 1,
        projectDirectories: [fixture.projectDirectory],
        workspaceID: "workspace-normal",
        permissionCount: 1,
        permissionIDs: ["permission-normal"],
      },
      copiedFileCount: 1,
      copiedFileBytes: "referenced output".length,
      copiedFiles: activeMetadata.productMigration.copiedFiles,
      replay: false,
      graphReconstructed: true,
      graphEnhancement: expect.objectContaining({
        id: expect.stringMatching(/^geh_/),
        versionID: expect.stringMatching(/^gvr_/),
        model: null,
        messages: [expect.objectContaining({ sourceID: "msg_active", targetID: expect.any(String) })],
        request: expect.objectContaining({ tools: [], toolChoice: "none" }),
      }),
    })
    const detachedMetadata = JSON.parse(detached.metadata) as MigrationMetadata
    expect(detachedMetadata.productMigration).toMatchObject({
      migrationID: "opencode-first-import",
      sourceID: "ses_detached",
      status: "needs_attention",
      checkpoint: "paused",
      detached: true,
      missingParent: false,
      missingWorkspace: false,
      neutralizedInputIDs: [],
      closure: {
        legacyMessages: 0,
        parts: 0,
        currentMessages: 1,
        inputs: 0,
        todos: 0,
        projectID: "project-z-detached",
        projectDirectoryCount: 1,
        projectDirectories: [fixture.detachedDirectory],
        workspaceID: null,
        permissionCount: 1,
        permissionIDs: ["permission-detached"],
      },
      copiedFileCount: 0,
      copiedFileBytes: 0,
    })
    expect(activeMetadata.productMigration.copiedFiles).toHaveLength(1)
    const copied = activeMetadata.productMigration.copiedFiles[0]
    if (!copied) throw new Error("Expected copied output inventory")
    expect(await Bun.file(path.join(fixture.targetData, copied.path)).text()).toBe("referenced output")
    expect(copied.sha256).toBe(createHash("sha256").update("referenced output").digest("hex"))
    const entity = (type: string, sourceID: string) =>
      result.entities.find((item) => item.entity_type === type && item.source_id === sourceID)
    const requireEntity = (type: string, sourceID: string) => {
      const found = entity(type, sourceID)
      if (!found) throw new Error(`Expected ${type} mapping for ${sourceID}`)
      return found
    }
    const activeInputEntity = requireEntity("session_input", "input_active")
    const activeInput = result.inputs.find((input) => input.id === activeInputEntity.target_id)
    expect(activeInput).toEqual({
      id: activeInputEntity.target_id,
      session_id: activeID,
      prompt: JSON.stringify({ text: "Pending input" }),
      delivery: "queue",
      admitted_seq: 2,
      promoted_seq: 3,
      time_created: 2,
    })
    expect(result.published.durable?.seq).toBe(4)
    expect(result.sequences).toEqual(
      expect.arrayContaining([
        { aggregate_id: normalID, seq: 1, owner_id: null },
        { aggregate_id: detachedID, seq: 1, owner_id: null },
        { aggregate_id: activeID, seq: 4, owner_id: null },
      ]),
    )
    expect(result.sequences).toHaveLength(3)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      aggregate_id: activeID,
      seq: 4,
      type: "session.next.agent.switched.1",
    })
    expect(JSON.parse(result.events[0]?.data ?? "{}")).toEqual({
      timestamp: expect.any(Number),
      sessionID: activeID,
      messageID: "msg_after_migration",
      agent: "review",
    })

    const normalMessage = result.currentMessages.find(
      (message) => message.id === entity("session_message", "msg_normal")?.target_id,
    )
    const activeUser = result.currentMessages.find(
      (message) => message.id === entity("session_message", "msg_active")?.target_id,
    )
    const activeOutput = result.currentMessages.find(
      (message) => message.id === entity("session_message", "msg_active_output")?.target_id,
    )
    const detachedMessage = result.currentMessages.find(
      (message) => message.id === entity("session_message", "msg_detached")?.target_id,
    )
    expect(result.currentMessages).toHaveLength(4)
    expect(normalMessage).toMatchObject({ session_id: normalID, type: "user", seq: 1 })
    expect(JSON.parse(normalMessage?.data ?? "{}")).toEqual({ text: "Normal history", time: { created: 1 } })
    expect(activeUser).toMatchObject({ session_id: activeID, type: "user", seq: 1 })
    expect(JSON.parse(activeUser?.data ?? "{}")).toEqual({
      text: "Goal: Resume migration\nModule: Storage\nTask: Verify copied output",
      time: { created: 1 },
    })
    expect(activeOutput).toMatchObject({ session_id: activeID, type: "assistant", seq: 2 })
    const activeOutputData = JSON.parse(activeOutput?.data ?? "{}") as {
      content: Array<{ state?: { outputPaths?: string[] } }>
    }
    expect(activeOutputData.content[0]?.state?.outputPaths).toEqual([path.join(fixture.targetData, copied.path)])
    expect(activeOutputData.content[0]?.state?.outputPaths).not.toContain(fixture.referencedOutput)
    expect(detachedMessage).toMatchObject({ session_id: detachedID, type: "user", seq: 1 })
    expect(JSON.parse(detachedMessage?.data ?? "{}")).toEqual({ text: "Detached history", time: { created: 1 } })

    const normalMetadata = JSON.parse(normal.metadata) as MigrationMetadata
    expect(normalMetadata.productMigration).toMatchObject({
      sourceID: "ses_normal",
      status: "ready",
      checkpoint: "none",
      detached: false,
      neutralizedInputIDs: [],
    })
    expect(normalMetadata.productMigration.closure).toEqual({
      legacyMessages: 0,
      parts: 0,
      currentMessages: 1,
      inputs: 0,
      todos: 1,
      projectID: "project-a-normal",
      projectDirectoryCount: 1,
      projectDirectories: [fixture.projectDirectory],
      workspaceID: "workspace-normal",
      permissionCount: 1,
      permissionIDs: ["permission-normal"],
    })
    expect(result.todos).toEqual([
      {
        session_id: normalID,
        content: "Normal todo",
        status: "pending",
        priority: "medium",
        position: 0,
      },
    ])
    expect(result.legacyMessageCount?.count).toBe(0)
    expect(result.partCount?.count).toBe(0)
    expect(result.directories).toEqual(
      expect.arrayContaining([
        { project_id: normal.project_id, directory: fixture.projectDirectory },
        { project_id: detached.project_id, directory: fixture.detachedDirectory },
      ]),
    )
    expect(result.directories).toHaveLength(2)
    expect(result.workspaces).toEqual([
      {
        id: requireEntity("workspace", "workspace-normal").target_id,
        project_id: normal.project_id,
        name: "Normal workspace",
        directory: fixture.projectDirectory,
      },
    ])
    expect(result.permissions).toHaveLength(2)
    const normalPermission = requireEntity("permission", "permission-normal")
    expect(result.permissions.find((item) => item.id === normalPermission.target_id)).toEqual({
      id: normalPermission.target_id,
      project_id: normal.project_id,
      action: "allow",
      resource: "repository",
    })
    const detachedPermission = requireEntity("permission", "permission-detached")
    expect(result.permissions.find((item) => item.id === detachedPermission.target_id)).toEqual({
      id: detachedPermission.target_id,
      project_id: detached.project_id,
      action: "allow",
      resource: "repository",
    })
    expect(result.projects).toHaveLength(2)
    const normalProject = requireEntity("project", "project-a-normal")
    expect(result.projects.find((project) => project.id === normal.project_id)).toEqual({
      id: normalProject.target_id,
      name: "Normal",
      worktree: fixture.projectDirectory,
    })
    expect(active.project_id).toBe(normal.project_id)
    expect(result.projects.find((project) => project.id === detached.project_id)?.name).toStartWith("[Detached]")
    expect(result.projects.some((project) => project.worktree === fixture.corruptDirectory)).toBe(false)
    expect(result.entities.some((item) => item.source_id.includes("corrupt"))).toBe(false)
    expect(result.entities.some((item) => item.source_id === "project-zz-corrupt")).toBe(false)
    expect(result.sessions).toHaveLength(3)
    expect(
      result.currentMessages.every(
        (message) =>
          message.session_id === activeID || message.session_id === detachedID || message.session_id === normalID,
      ),
    ).toBe(true)

    const normalVersion = result.graphVersions.find((version) => version.session_id === normalID)
    const detachedVersion = result.graphVersions.find((version) => version.session_id === detachedID)
    const reconstructedVersion = result.graphVersions.find((version) => version.session_id === activeID)
    expect(result.graphVersions).toHaveLength(3)
    expect(normalVersion?.message).toBe("Imported OpenCode Graph")
    expect(detachedVersion?.message).toBe("Detached OpenCode Graph")
    expect(reconstructedVersion?.message).toBe("Deterministic reconstruction from copied session history")
    const legacyNode = result.graphNodes.find((node) => node.session_id === normalID)
    const legacyNodeEntity = requireEntity("graph_node", "node-normal")
    expect(legacyNode).toEqual({
      id: legacyNodeEntity.target_id,
      session_id: normalID,
      type: "atomic",
      name: "Imported task",
      content: JSON.stringify({
        source_message_ids: ["msg_normal"],
        migration: {
          source_id: "node-normal",
          source_message_ids: ["msg_normal"],
          provenance: "deterministic",
          confidence: 0.75,
        },
      }),
      confidence: 0.75,
    })
    expect(legacyNode?.id).not.toBe("node-normal")
    expect(normalVersion?.id).toBe(requireEntity("graph_version", "version-normal").target_id)
    expect(normalVersion?.id).not.toBe("version-normal")
    const normalSnapshot = JSON.parse(normalVersion?.snapshot ?? "{}") as { nodes: Array<Record<string, unknown>> }
    expect(normalSnapshot.nodes).toHaveLength(1)
    expect(normalSnapshot.nodes[0]).toMatchObject({
      id: legacyNode?.id,
      session_id: normalID,
      confidence: 0.75,
      content: {
        migration: {
          source_id: "node-normal",
          source_message_ids: ["msg_normal"],
          provenance: "deterministic",
          confidence: 0.75,
        },
      },
    })
    const detachedNode = result.graphNodes.find((node) => node.session_id === detachedID)
    expect(detachedNode).toEqual({
      id: requireEntity("graph_node", "node-detached").target_id,
      session_id: detachedID,
      type: "atomic",
      name: "Detached task",
      content: JSON.stringify({
        source_message_ids: ["msg_detached"],
        migration: {
          source_id: "node-detached",
          source_message_ids: ["msg_detached"],
          provenance: "deterministic",
          confidence: 0.5,
        },
      }),
      confidence: 0.5,
    })
    expect(detachedVersion?.id).toBe(requireEntity("graph_version", "version-detached").target_id)

    const reconstructedNodes = result.graphNodes.filter((node) => node.session_id === activeID)
    expect(result.graphNodes).toHaveLength(5)
    expect(reconstructedNodes.map((node) => [node.type, node.name])).toEqual([
      ["atomic", "Verify copied output"],
      ["composite", "Storage"],
      ["prd", "Resume migration"],
    ])
    expect(
      reconstructedNodes.map((node) => ({
        id: node.id,
        name: node.name,
        content: JSON.parse(node.content),
        confidence: node.confidence,
      })),
    ).toEqual([
      {
        id: expect.any(String),
        name: "Verify copied output",
        content: {
          artifact_paths: [],
          diagnostic_commands: [],
          migration: {
            source_id: expect.stringMatching(/^reconstructed:task:[a-f0-9]{64}$/),
            source_message_ids: ["msg_active"],
            provenance: "deterministic",
            confidence: 1,
          },
        },
        confidence: 1,
      },
      {
        id: expect.any(String),
        name: "Storage",
        content: {
          migration: {
            source_id: expect.stringMatching(/^reconstructed:module:[a-f0-9]{64}$/),
            source_message_ids: ["msg_active"],
            provenance: "deterministic",
            confidence: 1,
          },
        },
        confidence: 1,
      },
      {
        id: expect.any(String),
        name: "Resume migration",
        content: {
          migration: {
            source_id: expect.stringMatching(/^reconstructed:goal:[a-f0-9]{64}$/),
            source_message_ids: ["msg_active"],
            provenance: "deterministic",
            confidence: 1,
          },
        },
        confidence: 1,
      },
    ])
    reconstructedNodes.forEach((node) => {
      const sourceID = JSON.parse(node.content).migration.source_id as string
      expect(node.id).toBe(requireEntity("graph_node", sourceID).target_id)
    })
    const reconstructedSnapshot = JSON.parse(reconstructedVersion?.snapshot ?? "{}") as {
      nodes: Array<{ id: string; content: Record<string, unknown> }>
      edges: Array<{ source_id: string; target_id: string; relation: string; confidence: number }>
    }
    expect(reconstructedSnapshot.nodes.map((node) => node.id).toSorted()).toEqual(
      reconstructedNodes.map((node) => node.id).toSorted(),
    )
    expect(reconstructedSnapshot.edges).toHaveLength(2)
    expect(reconstructedSnapshot.edges.every((edge) => edge.relation === "contains" && edge.confidence === 1)).toBe(
      true,
    )
    expect(result.graphAudit).toEqual([
      {
        session_id: activeID,
        tool_name: "product_migration.graph_table_unsupported",
        status: "blocked",
        error: "Corrupt Graph rows or snapshots",
      },
    ])
    const reconstructedVersionEntity = result.entities.find(
      (item) => item.entity_type === "graph_version" && item.target_id === reconstructedVersion?.id,
    )
    expect(reconstructedVersionEntity?.source_id).toMatch(/^reconstructed:version:[a-f0-9]{64}$/)

    const migrationFiles = [
      ...new Bun.Glob("product-migration/**/*").scanSync({
        cwd: fixture.targetData,
        onlyFiles: true,
      }),
    ].toSorted()
    expect(migrationFiles).toEqual([copied.path])
    expect([...new Bun.Glob(".product-migration-*").scanSync({ cwd: fixture.targetData })]).toEqual([])

    expect(result.finalized).toMatchObject({
      status: "completed",
      source: null,
      plan: null,
      validation: null,
      items: [],
      canFinalize: false,
    })
    expect(result.gateCompleted).toBe(true)
    expect(result.journal).toEqual({
      status: "completed",
      source_path: null,
      source_fingerprint: null,
      plan: null,
      validation: null,
    })
    expect(result.itemCount?.count).toBe(0)
    expect(result.entityCount?.count).toBe(0)
  } finally {
    writer.close(false)
  }
}, 30_000)

type Fixture = Awaited<ReturnType<typeof migrationFixture>>

type MigrationMetadata = {
  readonly productMigration: {
    readonly migrationID: string
    readonly sourceID: string
    readonly status: string
    readonly checkpoint: string
    readonly detached: boolean
    readonly missingParent: boolean
    readonly missingWorkspace: boolean
    readonly neutralizedInputIDs: string[]
    readonly closure: {
      readonly legacyMessages: number
      readonly parts: number
      readonly currentMessages: number
      readonly projectDirectories: string[]
      readonly projectDirectoryCount: number
      readonly projectID: string
      readonly permissionIDs: string[]
      readonly permissionCount: number
      readonly workspaceID: string | null
      readonly inputs: number
      readonly todos: number
    }
    readonly copiedFileCount: number
    readonly copiedFileBytes: number
    readonly copiedFiles: Array<{ readonly path: string; readonly sha256: string; readonly size: number }>
    readonly replay: boolean
    readonly graphReconstructed: boolean
    readonly graphEnhancement: {
      readonly id: string
      readonly versionID: string
      readonly model: unknown
      readonly messages: ReadonlyArray<{ readonly sourceID: string; readonly targetID: string }>
      readonly request: unknown
    }
  }
}

async function migrationFixture(root: string) {
  const sourceData = path.join(root, "source", "data")
  const sourceConfig = path.join(root, "source", "config")
  const sourceState = path.join(root, "source", "state")
  const targetData = path.join(root, "target", "data")
  const targetConfig = path.join(root, "target", "config")
  const targetState = path.join(root, "target", "state")
  const targetCache = path.join(root, "target", "cache")
  const targetTmp = path.join(root, "target", "tmp")
  const projectDirectory = path.join(root, "project")
  const detachedDirectory = path.join(root, "detached-project")
  const corruptDirectory = path.join(root, "corrupt-project")
  const referencedOutput = path.join(sourceData, "tool-output", "result.txt")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  await Promise.all([
    mkdir(path.join(sourceConfig, "plugins"), { recursive: true }),
    mkdir(path.join(sourceConfig, "unexpected"), { recursive: true }),
    mkdir(sourceState, { recursive: true }),
    mkdir(path.dirname(referencedOutput), { recursive: true }),
    mkdir(targetData, { recursive: true }),
    mkdir(targetConfig, { recursive: true }),
    mkdir(targetState, { recursive: true }),
    mkdir(targetCache, { recursive: true }),
    mkdir(targetTmp, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(sourceConfig, "opencode.json"), JSON.stringify({ model: "test/model" })),
    Bun.write(path.join(sourceConfig, "package.json"), JSON.stringify({ dependencies: {} })),
    Bun.write(path.join(sourceConfig, "plugins", "fixture.ts"), "export default {}"),
    Bun.write(path.join(sourceConfig, "unexpected", "nested.txt"), "unexpected config"),
    Bun.write(
      path.join(sourceData, "auth.json"),
      JSON.stringify({ provider: { type: "api", key: "provider-secret" } }),
    ),
    Bun.write(
      path.join(sourceData, "mcp-auth.json"),
      JSON.stringify({ docs: { tokens: { accessToken: "mcp-secret" } } }),
    ),
    Bun.write(referencedOutput, "referenced output"),
    Bun.write(path.join(sourceData, "unexpected.bin"), new Uint8Array([0, 1, 2, 3])),
    Bun.write(path.join(sourceState, "unexpected.json"), JSON.stringify({ preserved: true })),
  ])
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(path.join(sourceData, "auth.json"), 0o600),
      chmod(path.join(sourceData, "mcp-auth.json"), 0o600),
    ])
  }
  createLegacyDatabase(sourceDatabase)
  return {
    root,
    sourceData,
    sourceConfig,
    sourceState,
    sourceDatabase,
    targetData,
    targetConfig,
    targetState,
    targetCache,
    targetTmp,
    targetDatabase: path.join(targetData, "graph-vibe.db"),
    projectDirectory,
    detachedDirectory,
    corruptDirectory,
    referencedOutput,
  }
}

function createLegacyDatabase(database: string) {
  const source = new sqlite.Database(database, { create: true })
  source.run("PRAGMA user_version = 1")
  source.run(`CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL
  )`)
  source.run(`CREATE TABLE project_directory (
    project_id TEXT NOT NULL, directory TEXT NOT NULL, type TEXT NOT NULL, strategy TEXT NOT NULL,
    time_created INTEGER NOT NULL, PRIMARY KEY (project_id, directory)
  )`)
  source.run(`CREATE TABLE workspace (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, directory TEXT, project_id TEXT NOT NULL,
    time_used INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE permission (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, metadata TEXT NOT NULL,
    cost REAL NOT NULL, tokens_input INTEGER NOT NULL, tokens_output INTEGER NOT NULL,
    tokens_reasoning INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL, tokens_cache_write INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER
  )`)
  source.run(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`)
  source.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`)
  source.run(`CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`)
  source.run(`CREATE TABLE session_input (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, delivery TEXT NOT NULL,
    admitted_seq INTEGER NOT NULL, promoted_seq INTEGER, time_created INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE todo (
    session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
    position INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE credential (
    id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT,
    method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE graph_node (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL,
    level TEXT NOT NULL, priority TEXT, category TEXT, status TEXT, desc TEXT, content TEXT, verification TEXT,
    code_hash TEXT, test_status TEXT, confidence REAL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE graph_edge (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, source_id TEXT NOT NULL,
    target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL, time_created INTEGER NOT NULL
  )`)
  source.run(`CREATE TABLE graph_version (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, version_number INTEGER NOT NULL,
    message TEXT NOT NULL, snapshot TEXT NOT NULL, time_created INTEGER NOT NULL,
    UNIQUE(project_id, version_number)
  )`)
  source.close(false)
}

function seedSource(source: import("bun:sqlite").Database, fixture: Fixture) {
  source
    .prepare(
      `
    INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
    VALUES (?, ?, ?, 1, 1, '[]')
  `,
    )
    .run("project-a-normal", fixture.projectDirectory, "Normal")
  source
    .prepare(
      `
    INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
    VALUES (?, ?, ?, 1, 1, '[]')
  `,
    )
    .run("project-z-detached", fixture.detachedDirectory, "Detached")
  source
    .prepare(
      `
    INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
    VALUES (?, ?, ?, 1, 1, '[]')
  `,
    )
    .run("project-zz-corrupt", fixture.corruptDirectory, "Corrupt")
  source
    .prepare(
      `
    INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
    VALUES (?, ?, 'main', 'git', 1)
  `,
    )
    .run("project-a-normal", fixture.projectDirectory)
  source
    .prepare(
      `
    INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
    VALUES (?, ?, 'main', 'git', 1)
  `,
    )
    .run("project-z-detached", fixture.detachedDirectory)
  source
    .prepare(
      `
    INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
    VALUES (?, ?, 'main', 'git', 1)
  `,
    )
    .run("project-zz-corrupt", fixture.corruptDirectory)
  source
    .prepare(
      `
    INSERT INTO workspace (id, type, name, directory, project_id, time_used)
    VALUES ('workspace-normal', 'local', 'Normal workspace', ?, 'project-a-normal', 1)
  `,
    )
    .run(fixture.projectDirectory)
  source.run(`
    INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES
      ('permission-normal', 'project-a-normal', 'allow', 'repository', 1, 1),
      ('permission-detached', 'project-z-detached', 'allow', 'repository', 1, 1),
      ('permission-corrupt', 'project-zz-corrupt', 'allow', 'repository', 1, 1)
  `)
  const insertSession = source.prepare(`
    INSERT INTO session
      (id, project_id, workspace_id, slug, directory, title, version, metadata, cost, tokens_input,
       tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated,
       time_compacting)
    VALUES (?, ?, ?, ?, ?, ?, '1', '{}', 0, 0, 0, 0, 0, 0, 1, ?, ?)
  `)
  insertSession.run(
    "ses_normal",
    "project-a-normal",
    "workspace-normal",
    "normal",
    fixture.projectDirectory,
    "Normal session",
    40,
    null,
  )
  insertSession.run(
    "ses_unselected",
    "project-a-normal",
    null,
    "unselected",
    fixture.projectDirectory,
    "Unselected session",
    30,
    null,
  )
  insertSession.run(
    "ses_active",
    "project-a-normal",
    "workspace-normal",
    "active",
    fixture.projectDirectory,
    "Active attached session",
    20,
    20,
  )
  insertSession.run(
    "ses_detached",
    "project-z-detached",
    null,
    "detached",
    fixture.detachedDirectory,
    "Detached session",
    15,
    null,
  )
  insertSession.run(
    "ses_corrupt",
    "project-zz-corrupt",
    null,
    "corrupt",
    fixture.corruptDirectory,
    "Corrupt session",
    10,
    null,
  )
  const insertMessage = source.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insertMessage.run(
    "msg_normal",
    "ses_normal",
    "user",
    1,
    1,
    1,
    JSON.stringify({ text: "Normal history", time: { created: 1 } }),
  )
  insertMessage.run(
    "msg_active",
    "ses_active",
    "user",
    1,
    1,
    1,
    JSON.stringify({
      text: "Goal: Resume migration\nModule: Storage\nTask: Verify copied output",
      time: { created: 1 },
    }),
  )
  insertMessage.run(
    "msg_active_output",
    "ses_active",
    "assistant",
    2,
    2,
    2,
    JSON.stringify({
      agent: "build",
      model: { providerID: "test", id: "test" },
      content: [
        {
          type: "tool",
          id: "tool_output",
          name: "bash",
          state: {
            status: "completed",
            input: {},
            structured: {},
            content: [],
            outputPaths: [fixture.referencedOutput],
          },
          time: { created: 2, ran: 2, completed: 2 },
        },
      ],
      finish: "stop",
      time: { created: 2, completed: 2 },
    }),
  )
  insertMessage.run(
    "msg_detached",
    "ses_detached",
    "user",
    1,
    1,
    1,
    JSON.stringify({ text: "Detached history", time: { created: 1 } }),
  )
  insertMessage.run(
    "msg_corrupt",
    "ses_corrupt",
    "user",
    1,
    1,
    1,
    JSON.stringify({
      text: "Corrupt file reference fallback",
      files: [{ uri: "file://%", mime: "text/plain" }],
      time: { created: 1 },
    }),
  )
  source
    .prepare(
      `
    INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
    VALUES ('input_active', 'ses_active', ?, 'queue', 2, NULL, 2)
  `,
    )
    .run(JSON.stringify({ text: "Pending input" }))
  source.run(`
    INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
    VALUES ('ses_normal', 'Normal todo', 'pending', 'medium', 0, 1, 1)
  `)
  source.run(`
    INSERT INTO credential
      (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)
    VALUES
      ('credential-fixture', 'provider-fixture', 'Fixture', '{"type":"key","key":"database-secret"}',
       NULL, NULL, 1, 1, 1)
  `)
  source.run(`
    INSERT INTO graph_node
      (id, project_id, session_id, type, name, level, status, content, test_status, confidence,
       time_created, time_updated)
    VALUES
      ('node-normal', 'project-a-normal', 'ses_normal', 'atomic', 'Imported task', 'L2', 'pending',
       '{"source_message_ids":["msg_normal"]}', 'none', 0.75, 1, 1),
      ('node-detached', 'project-z-detached', 'ses_detached', 'atomic', 'Detached task', 'L2', 'pending',
       '{"source_message_ids":["msg_detached"]}', 'none', 0.5, 1, 1)
  `)
  source
    .prepare(
      `
    INSERT INTO graph_version (id, project_id, session_id, version_number, message, snapshot, time_created)
    VALUES ('version-normal', 'project-a-normal', 'ses_normal', 1, 'Imported OpenCode Graph', ?, 1)
  `,
    )
    .run(
      JSON.stringify({
        nodes: [
          {
            id: "node-normal",
            project_id: "project-a-normal",
            session_id: "ses_normal",
            type: "atomic",
            name: "Imported task",
            level: "L2",
            priority: null,
            category: null,
            status: "pending",
            desc: null,
            content: { source_message_ids: ["msg_normal"] },
            verification: { criteria: ["Verify imported task"], diagnostics: [{ name: "test" }] },
            code_hash: null,
            test_status: "none",
            confidence: 0.75,
            time_created: 1,
            time_updated: 1,
          },
        ],
        edges: [],
      }),
    )
  source
    .prepare(
      `
    INSERT INTO graph_version (id, project_id, session_id, version_number, message, snapshot, time_created)
    VALUES ('version-detached', 'project-z-detached', 'ses_detached', 1, 'Detached OpenCode Graph', ?, 1)
  `,
    )
    .run(
      JSON.stringify({
        nodes: [
          {
            id: "node-detached",
            project_id: "project-z-detached",
            session_id: "ses_detached",
            type: "atomic",
            name: "Detached task",
            level: "L2",
            priority: null,
            category: null,
            status: "pending",
            desc: null,
            content: { source_message_ids: ["msg_detached"] },
            verification: null,
            code_hash: null,
            test_status: "none",
            confidence: 0.5,
            time_created: 1,
            time_updated: 1,
          },
        ],
        edges: [],
      }),
    )
  source.run(`
    INSERT INTO graph_version (id, project_id, session_id, version_number, message, snapshot, time_created)
    VALUES ('version-corrupt', 'project-a-normal', 'ses_active', 2, 'Corrupt Graph', '{', 1)
  `)
}

async function sourceManifest(fixture: Fixture, attempt = 0): Promise<Awaited<ReturnType<typeof readSourceManifest>>> {
  const before = await readSourceManifest(fixture)
  await Bun.sleep(10)
  const after = await readSourceManifest(fixture)
  if (JSON.stringify(before) === JSON.stringify(after)) return after
  if (attempt >= 20) throw new Error("Source manifest did not become stable")
  return sourceManifest(fixture, attempt + 1)
}

async function readSourceManifest(fixture: Fixture) {
  const inspect = async (target: string): Promise<SourceManifestEntry[]> => {
    const info = await lstat(target, { bigint: true })
    const entry = {
      path: path.relative(fixture.root, target).replaceAll(path.sep, "/"),
      ino: info.ino.toString(),
      mode: Number(info.mode & 0o7777n),
      size: info.size.toString(),
      mtimeNs: info.mtimeNs.toString(),
      ctimeNs: info.ctimeNs.toString(),
    }
    if (info.isDirectory()) {
      const children = await readdir(target)
      return [
        { ...entry, type: "directory", sha256: null },
        ...(await Promise.all(children.toSorted().map((child) => inspect(path.join(target, child))))).flat(),
      ]
    }
    if (!info.isFile()) return [{ ...entry, type: "other", sha256: null }]
    if (target === `${fixture.sourceDatabase}-shm`) {
      // Online SQLite readers coordinate through SHM without mutating durable DB or WAL bytes.
      return [
        {
          ...entry,
          size: "0",
          mtimeNs: "0",
          ctimeNs: "0",
          type: "file",
          sha256: null,
        },
      ]
    }
    const content = await Bun.file(target).bytes()
    return [
      {
        ...entry,
        type: "file",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ]
  }
  return (await Promise.all([fixture.sourceData, fixture.sourceConfig, fixture.sourceState].map(inspect)))
    .flat()
    .toSorted((left, right) => left.path.localeCompare(right.path))
}

type SourceManifestEntry = {
  readonly path: string
  readonly type: string
  readonly ino: string
  readonly mode: number
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly sha256: string | null
}
