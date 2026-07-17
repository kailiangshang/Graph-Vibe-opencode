import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, realpath, stat, symlink, truncate } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProductMigrationSession } from "@opencode-ai/core/product-migration/session"
import { ProductMigrationSource } from "@opencode-ai/core/product-migration/source"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const sqlite = await import("bun:sqlite")

test("imports a closed selected projection that is safe to continue", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source-data")
  const targetData = path.join(tmp.path, "target-data")
  const projectDirectory = path.join(tmp.path, "project")
  const childDirectory = path.join(projectDirectory, "missing-child")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const targetDatabase = path.join(targetData, "graph-vibe.db")
  const output = path.join(sourceData, "tool-output", "tool_1")
  const attachment = path.join(sourceData, "attachments", "diagram.txt")
  const missing = path.join(sourceData, "attachments", "missing.txt")
  const auth = path.join(sourceData, "auth.json")
  const outside = path.join(tmp.path, "outside.txt")
  const escape = path.join(sourceData, "attachments", "escape.txt")
  await mkdir(path.dirname(output), { recursive: true })
  await mkdir(path.dirname(attachment), { recursive: true })
  await mkdir(projectDirectory)
  await mkdir(targetData)
  await Bun.write(output, "complete tool output")
  await Bun.write(attachment, "attachment bytes")
  await Bun.write(auth, "provider secret")
  await Bun.write(outside, "outside source root")
  await symlink(outside, escape)
  await chmod(output, 0o640)

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('project-selected', ${projectDirectory}, 'Selected', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
        VALUES ('project-selected', ${projectDirectory}, 'main', 'git', 1)
      `)
      yield* db.run(sql`
        INSERT INTO workspace (id, type, name, branch, directory, project_id, time_used)
        VALUES ('wrk_selected', 'local', 'Workspace', 'dev', ${projectDirectory}, 'project-selected', 1)
      `)
      yield* insertSession(db, {
        id: "ses_parent",
        projectID: "project-selected",
        workspaceID: "wrk_selected",
        directory: projectDirectory,
      })
      yield* insertSession(db, {
        id: "ses_child",
        projectID: "project-selected",
        workspaceID: "wrk_selected",
        parentID: "ses_parent",
        directory: childDirectory,
      })
      yield* insertSession(db, {
        id: "ses_skipped",
        projectID: "project-selected",
        directory: projectDirectory,
      })
      yield* insertSession(db, {
        id: "ses_legacy_active",
        projectID: "project-selected",
        directory: projectDirectory,
      })
      yield* db.run(sql`
        INSERT INTO permission (id, project_id, action, resource, time_created, time_updated)
        VALUES ('permission-saved', 'project-selected', 'allow', 'repository', 1, 1)
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_legacy', 'ses_child', 2, 3, ${JSON.stringify({
          role: "user",
          time: { created: 2 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_legacy_incomplete', 'ses_child', 3, 4, ${legacyAssistant("incomplete")})
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_legacy_complete', 'ses_child', 5, 6, ${legacyAssistant("complete", 6)})
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_legacy_active_user', 'ses_legacy_active', 1, 1, ${JSON.stringify({
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('msg_legacy_active', 'ses_legacy_active', 2, 3,
                ${legacyAssistant("legacy-only-active", undefined, "msg_legacy_active_user")})
      `)
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_pending', 'msg_legacy', 'ses_child', 2, 3, ${JSON.stringify({
          type: "tool",
          callID: "legacy-pending",
          tool: "bash",
          state: { status: "pending", input: {}, raw: "" },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_attachment', 'msg_legacy', 'ses_child', 3, 3, ${JSON.stringify({
          type: "tool",
          callID: "legacy-complete",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "preview",
            title: "read",
            metadata: {},
            time: { start: 2, end: 3 },
            attachments: [
              {
                id: "prt_nested",
                sessionID: "ses_child",
                messageID: "msg_legacy",
                type: "file",
                mime: "text/plain",
                filename: "diagram.txt",
                url: pathToFileURL(attachment).href,
              },
            ],
          },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('prt_compaction', 'msg_legacy', 'ses_child', 3, 3, ${JSON.stringify({
          type: "compaction",
          auto: true,
          tail_start_id: "msg_legacy",
        })})
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_promoted', 'ses_child', 'user', 5, 5, 5, ${JSON.stringify({
          text: "already promoted",
          time: { created: 5 },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_running', 'ses_child', 'assistant', 8, 8, 9, ${JSON.stringify({
          metadata: { url: pathToFileURL(auth).href },
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [
            {
              type: "tool",
              id: "current-running",
              name: "bash",
              state: { status: "running", input: {}, structured: {}, content: [] },
              time: { created: 8, ran: 8 },
            },
            {
              type: "tool",
              id: "current-complete",
              name: "bash",
              state: { status: "completed", input: {}, structured: {}, content: [], outputPaths: [output] },
              time: { created: 8, ran: 8, completed: 8 },
            },
          ],
          time: { created: 8 },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_success', 'ses_child', 'assistant', 7, 6, 7, ${JSON.stringify({
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [{ type: "text", id: "text-success", text: "done" }],
          finish: "stop",
          time: { created: 6, completed: 7 },
        })})
      `)
      yield* db.run(sql`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES ('msg_promoted', 'ses_child', ${JSON.stringify({ text: "already promoted" })}, 'steer', 4, 5, 4)
      `)
      yield* db.run(sql`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES ('msg_pending', 'ses_child', ${JSON.stringify({
          text: "pending steer",
          files: [
            { uri: pathToFileURL(missing).href, mime: "text/plain" },
            { uri: pathToFileURL(escape).href, mime: "text/plain" },
          ],
        })}, 'steer', 9, NULL, 9)
      `)
      yield* db.run(sql`
        INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES ('msg_queued', 'ses_child', ${JSON.stringify({ text: "pending queue" })}, 'queue', 10, NULL, 10)
      `)
      yield* db.run(sql`
        INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
        VALUES ('ses_child', 'Verify migration', 'pending', 'high', 0, 10, 10)
      `)
      yield* db.run(sql`
        UPDATE session
        SET revert = ${JSON.stringify({ messageID: "msg_promoted", partID: "prt_pending", snapshot: "snapshot-1" })}
        WHERE id = 'ses_child'
      `)
    }).pipe(Effect.provide(Database.layerFromPath(sourceDatabase))),
  )

  const identity = await sourceIdentity(sourceDatabase, 4)
  const before = await fileState(sourceDatabase, output, attachment, auth)
  const database = Database.layerFromPath(targetDatabase)
  const layer = Layer.merge(
    ProductMigrationSession.layer.pipe(
      Layer.provideMerge(database),
      Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
    ),
    EventV2.layerWith().pipe(Layer.provideMerge(database)),
  )
  const migrated = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-1", identity.database, "full-source-fingerprint")
      const migration = yield* ProductMigrationSession.Service
      const events = yield* EventV2.Service
      const selections = [
        { projectID: "project-selected", sessionID: "ses_child" },
        { projectID: "project-selected", sessionID: "ses_parent" },
        { projectID: "project-selected", sessionID: "ses_child" },
        { projectID: "project-selected", sessionID: "ses_legacy_active" },
      ]
      const input = {
        migrationID: "migration-1",
        sourceDatabase,
        databaseFingerprint: identity.fingerprint,
        sourceFingerprint: "full-source-fingerprint",
        sourceData,
        targetData,
        selections,
        selectionInventory: selections,
      }
      const [result, retry] = yield* Effect.all([migration.import(input), migration.import(input)], {
        concurrency: "unbounded",
      })
      const child = result.sessions.find((item) => item.sourceID === "ses_child")
      const parent = result.sessions.find((item) => item.sourceID === "ses_parent")
      const legacyActive = result.sessions.find((item) => item.sourceID === "ses_legacy_active")
      if (!child || !parent || !legacyActive)
        return yield* Effect.die("Expected imported parent, child, and legacy session")
      const childID = SessionSchema.ID.make(child.targetID)
      const sequence = yield* db.get<{ seq: number; owner_id: string | null }>(sql`
        SELECT seq, owner_id FROM event_sequence WHERE aggregate_id = ${child.targetID}
      `)
      const next = yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID: childID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        agent: "build",
      })
      return {
        result,
        retry,
        pendingSteer: yield* SessionInput.hasPending(db, childID, "steer"),
        pendingQueue: yield* SessionInput.hasPending(db, childID, "queue"),
        promotedSteers: yield* SessionInput.promoteSteers(db, events, childID, Number.MAX_SAFE_INTEGER),
        promotedQueue: yield* SessionInput.promoteNextQueued(db, events, childID),
        child,
        parent,
        legacyActive,
        childRow: yield* db.get<Record<string, string | number | null>>(
          sql`SELECT * FROM session WHERE id = ${child.targetID}`,
        ),
        messages: yield* db.all<Record<string, string | number | null>>(sql`
          SELECT * FROM message WHERE session_id = ${child.targetID} ORDER BY time_created, id
        `),
        inputs: yield* db.all<Record<string, string | number | null>>(sql`
          SELECT * FROM session_input WHERE session_id = ${child.targetID} ORDER BY admitted_seq
        `),
        current: yield* db.all<Record<string, string | number | null>>(sql`
          SELECT * FROM session_message WHERE session_id = ${child.targetID} ORDER BY seq
        `),
        parts: yield* db.all<Record<string, string | number | null>>(sql`
          SELECT * FROM part WHERE session_id = ${child.targetID} ORDER BY id
        `),
        sequence,
        nextSequence: next.durable?.seq,
        projectDirectories: yield* db.all<Record<string, string | number | null>>(sql`SELECT * FROM project_directory`),
        workspaces: yield* db.all<Record<string, string | number | null>>(sql`SELECT * FROM workspace`),
        permissions: yield* db.all<Record<string, string | number | null>>(sql`SELECT * FROM permission`),
        entities: yield* db.all<Record<string, string | number | null>>(sql`
          SELECT * FROM product_migration_entity ORDER BY entity_type, source_id
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(migrated.result.sessions).toHaveLength(3)
  expect(migrated.retry).toEqual(migrated.result)
  expect(migrated.pendingSteer).toBe(false)
  expect(migrated.pendingQueue).toBe(false)
  expect(migrated.promotedSteers).toBe(0)
  expect(migrated.promotedQueue).toBe(false)
  expect(migrated.child).toMatchObject({ status: "needs_attention", checkpoint: "paused", detached: true })
  expect(migrated.parent).toMatchObject({ status: "ready", checkpoint: "none", detached: false })
  expect(migrated.legacyActive).toMatchObject({ status: "needs_attention", checkpoint: "paused", detached: false })
  expect(migrated.childRow?.parent_id).toBe(migrated.parent.targetID)
  expect(migrated.childRow?.workspace_id).toBeString()
  const metadata = JSON.parse(String(migrated.childRow?.metadata)) as {
    productMigration: {
      closure: {
        legacyMessages: number
        parts: number
        currentMessages: number
        inputs: number
        todos: number
        projectID: string
        projectDirectoryCount: number
        projectDirectories: string[]
        workspaceID: string | null
        permissionCount: number
        permissionIDs: string[]
      }
      copiedFileCount: number
      copiedFileBytes: number
      copiedFiles: Array<{ path: string; sha256: string; size: number }>
    }
  }
  expect(metadata.productMigration.closure).toEqual({
    legacyMessages: 3,
    parts: 3,
    currentMessages: 3,
    inputs: 3,
    todos: 1,
    projectID: "project-selected",
    projectDirectoryCount: 1,
    projectDirectories: [projectDirectory],
    workspaceID: "wrk_selected",
    permissionCount: 1,
    permissionIDs: ["permission-saved"],
  })
  expect(metadata.productMigration.copiedFileCount).toBe(2)
  expect(metadata.productMigration.copiedFileBytes).toBe("complete tool output".length + "attachment bytes".length)
  expect(metadata.productMigration.copiedFiles).toHaveLength(2)
  expect(
    metadata.productMigration.copiedFiles.every((file) =>
      file.path.startsWith(`product-migration/${migrated.child.targetID}/`),
    ),
  ).toBe(true)
  expect(metadata.productMigration.copiedFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
  expect(metadata.productMigration.copiedFiles.map((file) => file.size).toSorted((a, b) => a - b)).toEqual([
    "attachment bytes".length,
    "complete tool output".length,
  ])
  expect(migrated.projectDirectories).toHaveLength(1)
  expect(migrated.projectDirectories[0]?.project_id).toBe(migrated.child.projectID)
  expect(migrated.workspaces).toHaveLength(1)
  expect(migrated.childRow?.workspace_id).toBe(migrated.workspaces[0]?.id)
  expect(migrated.permissions).toHaveLength(1)
  expect(migrated.permissions[0]?.project_id).toBe(migrated.child.projectID)
  expect(migrated.permissions[0]?.action).toBe("allow")
  expect(migrated.permissions[0]?.resource).toBe("repository")
  expect(migrated.inputs).toHaveLength(3)
  expect(migrated.inputs.every((row) => row.promoted_seq !== null)).toBe(true)
  const promoted = migrated.inputs.find((row) => row.admitted_seq === 4)
  expect(migrated.current.find((row) => row.seq === 5)?.id).toBe(promoted?.id)
  expect(migrated.sequence?.seq).toBeGreaterThanOrEqual(
    Math.max(
      ...migrated.current.map((row) => Number(row.seq)),
      ...migrated.inputs.flatMap((row) => [Number(row.admitted_seq), Number(row.promoted_seq)]),
    ),
  )
  expect(migrated.sequence?.owner_id).toBeNull()
  expect(migrated.nextSequence).toBe((migrated.sequence?.seq ?? -1) + 1)

  const assistant = decodeCurrent(migrated.current.find((row) => row.seq === 8))
  if (assistant.type !== "assistant") throw new Error("Expected assistant projection")
  expect(assistant.time.completed).toBeDefined()
  expect(assistant.content.find((item) => item.type === "tool" && item.id === "current-running")).toMatchObject({
    state: { status: "error", error: { type: "unknown" } },
  })
  const successful = decodeCurrent(migrated.current.find((row) => row.seq === 7))
  if (successful.type !== "assistant") throw new Error("Expected successful assistant projection")
  if (!successful.time.completed) throw new Error("Expected completed successful assistant")
  expect(DateTime.toEpochMillis(successful.time.completed)).toBe(7)
  expect(successful.error).toBeUndefined()

  const legacyMessages = migrated.messages.map(decodeLegacyMessage)
  const incompleteLegacy = legacyMessages.find(
    (message) => message.role === "assistant" && message.mode === "incomplete",
  )
  const completeLegacy = legacyMessages.find((message) => message.role === "assistant" && message.mode === "complete")
  if (
    !incompleteLegacy ||
    incompleteLegacy.role !== "assistant" ||
    !completeLegacy ||
    completeLegacy.role !== "assistant"
  ) {
    throw new Error("Expected both legacy assistant fixtures")
  }
  expect(incompleteLegacy).toMatchObject({
    time: { completed: 4 },
    error: { name: "MessageAbortedError", data: { message: "Interrupted while importing an active OpenCode session" } },
  })
  expect(completeLegacy).toMatchObject({ time: { completed: 6 } })
  expect(completeLegacy?.error).toBeUndefined()

  const pendingPart = decodePart(migrated.parts.find((row) => JSON.stringify(row).includes("prt_")))
  expect(
    migrated.parts.map(decodePart).find((part) => part.type === "tool" && part.callID === "legacy-pending"),
  ).toMatchObject({
    state: { status: "error" },
  })
  expect(String(pendingPart.sessionID)).toBe(migrated.child.targetID)
  const legacyUser = legacyMessages.find((message) => message.role === "user")
  const compaction = migrated.parts.map(decodePart).find((part) => part.type === "compaction")
  if (!legacyUser || !compaction || compaction.type !== "compaction") throw new Error("Missing remapped compaction")
  expect(compaction.tail_start_id).toBe(legacyUser.id)

  const revert: unknown = JSON.parse(String(migrated.childRow?.revert))
  expect(revert).toMatchObject({
    messageID: migrated.current.find((row) => row.seq === 5)?.id,
    partID: migrated.parts.map(decodePart).find((part) => part.type === "tool" && part.callID === "legacy-pending")?.id,
    snapshot: "snapshot-1",
  })
  const serialized = JSON.stringify({ current: migrated.current, parts: migrated.parts, inputs: migrated.inputs })
  expect(serialized).toContain(auth)
  expect(serialized).not.toContain("provider secret")
  expect([...new Bun.Glob("**/auth.json").scanSync({ cwd: targetData })]).toEqual([])
  expect(migrated.child.missingFiles).toEqual([missing])
  expect(migrated.child.rejectedFiles).toEqual([escape])

  const copiedOutput = referencedOutput(assistant)
  expect(await Bun.file(copiedOutput).text()).toBe("complete tool output")
  expect((await stat(copiedOutput)).mode & 0o777).toBe((await stat(output)).mode & 0o777)
  expect(await fileState(sourceDatabase, output, attachment, auth)).toEqual(before)
})

test("rejects canonical source and target overlap before writing", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetAlias = path.join(tmp.path, "target-alias")
  const targetDatabase = path.join(tmp.path, "target.db")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  await mkdir(sourceData)
  await symlink(sourceData, targetAlias)
  await seedMinimalSource(sourceDatabase, sourceData, "ses_overlap")
  const identity = await sourceIdentity(sourceDatabase, 1)
  const before = await fileState(sourceDatabase)
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(targetDatabase)),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-overlap", identity.database, identity.fingerprint)
      const migration = yield* ProductMigrationSession.Service
      return yield* migration
        .import({
          migrationID: "migration-overlap",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData: targetAlias,
          selections: [{ projectID: "project-minimal", sessionID: "ses_overlap" }],
          selectionInventory: [{ projectID: "project-minimal", sessionID: "ses_overlap" }],
        })
        .pipe(Effect.exit)
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result)).toBe(true)
  expect(await fileState(sourceDatabase)).toEqual(before)
})

test("rejects a journal whose canonical source path or fingerprint does not match", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  await mkdir(sourceData)
  await mkdir(targetData)
  await seedMinimalSource(sourceDatabase, sourceData, "ses_identity")
  const identity = await sourceIdentity(sourceDatabase, 1)
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(targetData, "graph-vibe.db"))),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-identity", path.join(tmp.path, "other.db"), identity.fingerprint)
      yield* insertMigration(db, "migration-fingerprint", identity.database, "wrong-fingerprint")
      const migration = yield* ProductMigrationSession.Service
      const pathMismatch = yield* migration
        .import({
          migrationID: "migration-identity",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-minimal", sessionID: "ses_identity" }],
          selectionInventory: [{ projectID: "project-minimal", sessionID: "ses_identity" }],
        })
        .pipe(Effect.exit)
      const fingerprintMismatch = yield* migration
        .import({
          migrationID: "migration-fingerprint",
          sourceDatabase,
          databaseFingerprint: "wrong-fingerprint",
          sourceData,
          targetData,
          selections: [{ projectID: "project-minimal", sessionID: "ses_identity" }],
          selectionInventory: [{ projectID: "project-minimal", sessionID: "ses_identity" }],
        })
        .pipe(Effect.exit)
      return { pathMismatch, fingerprintMismatch }
    }).pipe(Effect.provide(layer)),
  )
  expect(Exit.isFailure(result.pathMismatch)).toBe(true)
  expect(Exit.isFailure(result.fingerprintMismatch)).toBe(true)
})

test("refuses to clean a mapped target without the exact migration metadata marker", async () => {
  await using tmp = await tmpdir()
  const targetData = path.join(tmp.path, "target")
  const copied = path.join(targetData, "product-migration", "ses_preexisting", "existing.txt")
  await mkdir(path.dirname(copied), { recursive: true })
  await Bun.write(copied, "keep")
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(targetData, "graph-vibe.db"))),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-cleanup-ownership", "/source/opencode.db", "fingerprint")
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('project-preexisting', ${tmp.path}, 'Existing', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO session
          (id, project_id, slug, directory, title, version, metadata, cost, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
        VALUES
          ('ses_preexisting', 'project-preexisting', 'existing', ${tmp.path}, 'Existing', '1',
           '{"owner":"existing"}', 0, 0, 0, 0, 0, 0, 1, 1)
      `)
      yield* db.run(sql`
        INSERT INTO product_migration_entity
          (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
        VALUES
          ('migration-cleanup-ownership', 'session', 'ses_source', 'fingerprint', 'ses_preexisting', 1, 1)
      `)
      const migration = yield* ProductMigrationSession.Service
      const error = yield* migration
        .cleanup({
          migrationID: "migration-cleanup-ownership",
          sourceSessionID: "ses_source",
          targetData,
        })
        .pipe(Effect.flip)
      return {
        error,
        session: yield* db.get<{ id: string }>(sql`SELECT id FROM session WHERE id = 'ses_preexisting'`),
        mapping: yield* db.get<{ target_id: string }>(sql`
          SELECT target_id FROM product_migration_entity
          WHERE migration_id = 'migration-cleanup-ownership' AND entity_type = 'session'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.error).toBeInstanceOf(ProductMigrationSession.ImportError)
  expect(result.session?.id).toBe("ses_preexisting")
  expect(result.mapping?.target_id).toBe("ses_preexisting")
  expect(await Bun.file(copied).text()).toBe("keep")
})

test("rejects a WAL-only source mutation after planning", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  await mkdir(sourceData)
  await mkdir(targetData)
  await seedMinimalSource(sourceDatabase, sourceData, "ses_wal")
  const writer = new sqlite.Database(sourceDatabase)
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
  const identity = await sourceIdentity(sourceDatabase, 1)
  writer.run("UPDATE session SET title = 'changed only in WAL' WHERE id = 'ses_wal'")
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(targetData, "graph-vibe.db"))),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-wal", identity.database, identity.fingerprint)
      const migration = yield* ProductMigrationSession.Service
      const imported = yield* migration
        .import({
          migrationID: "migration-wal",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-minimal", sessionID: "ses_wal" }],
          selectionInventory: [{ projectID: "project-minimal", sessionID: "ses_wal" }],
        })
        .pipe(Effect.exit)
      return {
        imported,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity WHERE migration_id = 'migration-wal'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result.imported)).toBe(true)
  expect(result.mappings).toEqual([])
  writer.close(false)
})

test("rejects an oversized selected session row family before materializing it", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  await mkdir(sourceData)
  await mkdir(targetData)
  await seedMinimalSource(sourceDatabase, sourceData, "ses_limit")
  const source = new sqlite.Database(sourceDatabase)
  source.run(`
    WITH RECURSIVE rows(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM rows WHERE value <= 100000
    )
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    SELECT printf('msg_limit_%06d', value), 'ses_limit', 1, 1, '{}' FROM rows
  `)
  source.close()
  const identity = await sourceIdentity(sourceDatabase, 1)
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(targetData, "graph-vibe.db"))),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-row-limit", identity.database, identity.fingerprint)
      const migration = yield* ProductMigrationSession.Service
      const error = yield* migration
        .import({
          migrationID: "migration-row-limit",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-minimal", sessionID: "ses_limit" }],
          selectionInventory: [{ projectID: "project-minimal", sessionID: "ses_limit" }],
        })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
      return {
        error,
        mappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity WHERE migration_id = 'migration-row-limit'
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(result.error).toBeInstanceOf(ProductMigrationSession.ImportError)
  expect(result.error?.message).toContain("message row limit")
  expect(result.mappings).toEqual([])
})

test("rolls back mappings and copied files for a failed session transaction", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const projectDirectory = path.join(tmp.path, "project")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const targetDatabase = path.join(targetData, "graph-vibe.db")
  const badOutput = path.join(sourceData, "tool-output", "bad-output")
  await mkdir(path.dirname(badOutput), { recursive: true })
  await mkdir(projectDirectory)
  await mkdir(targetData)
  await Bun.write(badOutput, "rollback output")
  await seedRollbackSource(sourceDatabase, projectDirectory, badOutput)
  const identity = await sourceIdentity(sourceDatabase, 2)
  const copied = path.join(
    targetData,
    "product-migration",
    "ses_target_bad",
    `${createHash("sha256").update("rollback output").digest("hex").slice(0, 16)}-bad-output`,
  )
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(targetDatabase)),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-rollback", identity.database, identity.fingerprint)
      yield* db.run(sql`
        INSERT INTO product_migration_entity
          (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
        VALUES
          ('migration-rollback', 'project', 'project-bad', ${identity.fingerprint}, 'target-bad-project', 1, 1),
          ('migration-rollback', 'session', 'ses_bad', ${identity.fingerprint}, 'ses_target_bad', 1, 1)
      `)
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('target-bad-project', ${projectDirectory}, 'Bad', 1, 1, '[]')
      `)
      yield* db.run(sql`
        INSERT INTO session
          (id, project_id, slug, directory, title, version, metadata, cost, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
        VALUES
          ('ses_target_bad', 'target-bad-project', 'bad', ${projectDirectory}, 'bad', '1',
           ${JSON.stringify({ productMigration: { migrationID: "migration-rollback", sourceID: "ses_bad" } })},
           0, 0, 0, 0, 0, 0, 1, 1)
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_existing', 'ses_target_bad', 'user', 2, 1, 1, ${JSON.stringify({ text: "collision", time: { created: 1 } })})
      `)
      const migration = yield* ProductMigrationSession.Service
      const imported = yield* migration
        .import({
          migrationID: "migration-rollback",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [
            { projectID: "project-good", sessionID: "ses_good" },
            { projectID: "project-bad", sessionID: "ses_bad" },
          ],
          selectionInventory: [
            { projectID: "project-good", sessionID: "ses_good" },
            { projectID: "project-bad", sessionID: "ses_bad" },
          ],
        })
        .pipe(Effect.exit)
      return {
        imported,
        sessions: yield* db.all<{ id: string }>(sql`SELECT id FROM session ORDER BY id`),
        badMappings: yield* db.all<{ source_id: string }>(sql`
          SELECT source_id FROM product_migration_entity
          WHERE migration_id = 'migration-rollback'
            AND source_id NOT IN ('project-bad', 'ses_bad')
            AND source_id IN ('msg_bad', 'current-bad')
        `),
      }
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result.imported)).toBe(true)
  expect(result.sessions).toHaveLength(2)
  expect(result.badMappings).toEqual([])
  expect(await Bun.file(copied).exists()).toBe(false)
})

test("conflicts when an existing copied-file path has different content", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const projectDirectory = path.join(tmp.path, "project")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const targetDatabase = path.join(targetData, "graph-vibe.db")
  const output = path.join(sourceData, "tool-output", "existing")
  await mkdir(path.dirname(output), { recursive: true })
  await mkdir(projectDirectory)
  await mkdir(targetData)
  await Bun.write(output, "expected bytes")
  await seedOutputSource(sourceDatabase, projectDirectory, output)
  const identity = await sourceIdentity(sourceDatabase, 1)
  const destination = path.join(
    targetData,
    "product-migration",
    "ses_target_existing",
    `${createHash("sha256").update("expected bytes").digest("hex").slice(0, 16)}-existing`,
  )
  await mkdir(path.dirname(destination), { recursive: true })
  await Bun.write(destination, "wrong bytes")
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(targetDatabase)),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-existing", identity.database, identity.fingerprint)
      yield* db.run(sql`
        INSERT INTO product_migration_entity
          (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
        VALUES ('migration-existing', 'session', 'ses_output', ${identity.fingerprint}, 'ses_target_existing', 1, 1)
      `)
      const migration = yield* ProductMigrationSession.Service
      return yield* migration
        .import({
          migrationID: "migration-existing",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-output", sessionID: "ses_output" }],
          selectionInventory: [{ projectID: "project-output", sessionID: "ses_output" }],
        })
        .pipe(Effect.exit)
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result)).toBe(true)
  expect(await Bun.file(destination).text()).toBe("wrong bytes")
})

test("rejects a referenced file above the per-file byte cap without leaving migration files", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const projectDirectory = path.join(tmp.path, "project")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const output = path.join(sourceData, "tool-output", "oversized")
  await mkdir(path.dirname(output), { recursive: true })
  await mkdir(projectDirectory)
  await mkdir(targetData)
  await Bun.write(output, "x")
  await truncate(output, 128 * 1024 * 1024 + 1)
  await seedOutputSource(sourceDatabase, projectDirectory, output)
  const identity = await sourceIdentity(sourceDatabase, 1)
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(targetData, "graph-vibe.db"))),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-oversized", identity.database, identity.fingerprint)
      const migration = yield* ProductMigrationSession.Service
      return yield* migration
        .import({
          migrationID: "migration-oversized",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-output", sessionID: "ses_output" }],
          selectionInventory: [{ projectID: "project-output", sessionID: "ses_output" }],
        })
        .pipe(Effect.exit)
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result)).toBe(true)
  expect([...new Bun.Glob("product-migration/**/*").scanSync({ cwd: targetData })]).toEqual([])
})

test("rejects and removes a destination created through an escaping ancestor", async () => {
  await using tmp = await tmpdir()
  const sourceData = path.join(tmp.path, "source")
  const targetData = path.join(tmp.path, "target")
  const outside = path.join(tmp.path, "outside")
  const projectDirectory = path.join(tmp.path, "project")
  const sourceDatabase = path.join(sourceData, "opencode.db")
  const targetDatabase = path.join(targetData, "graph-vibe.db")
  const output = path.join(sourceData, "tool-output", "escape-output")
  await mkdir(path.dirname(output), { recursive: true })
  await mkdir(projectDirectory)
  await mkdir(targetData)
  await mkdir(outside)
  await symlink(outside, path.join(targetData, "product-migration"))
  await Bun.write(output, "escape bytes")
  await seedOutputSource(sourceDatabase, projectDirectory, output)
  const identity = await sourceIdentity(sourceDatabase, 1)
  const escaped = path.join(
    outside,
    "ses_target_escape",
    `${createHash("sha256").update("escape bytes").digest("hex").slice(0, 16)}-escape-output`,
  )
  const layer = ProductMigrationSession.layer.pipe(
    Layer.provideMerge(Database.layerFromPath(targetDatabase)),
    Layer.provideMerge(AppNodeBuilder.build(FSUtil.node)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertMigration(db, "migration-escape", identity.database, identity.fingerprint)
      yield* db.run(sql`
        INSERT INTO product_migration_entity
          (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
        VALUES ('migration-escape', 'session', 'ses_output', ${identity.fingerprint}, 'ses_target_escape', 1, 1)
      `)
      const migration = yield* ProductMigrationSession.Service
      return yield* migration
        .import({
          migrationID: "migration-escape",
          sourceDatabase,
          databaseFingerprint: identity.fingerprint,
          sourceData,
          targetData,
          selections: [{ projectID: "project-output", sessionID: "ses_output" }],
          selectionInventory: [{ projectID: "project-output", sessionID: "ses_output" }],
        })
        .pipe(Effect.exit)
    }).pipe(Effect.provide(layer)),
  )

  expect(Exit.isFailure(result)).toBe(true)
  expect(await directoryExists(path.dirname(escaped))).toBe(false)
  expect(await Bun.file(escaped).exists()).toBe(false)
})

function insertSession(
  db: Database.Interface["db"],
  input: {
    readonly id: string
    readonly projectID: string
    readonly directory: string
    readonly workspaceID?: string
    readonly parentID?: string
  },
) {
  return db.run(sql`
    INSERT INTO session
      (id, project_id, workspace_id, parent_id, slug, directory, title, version, metadata, permission,
       cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
    VALUES
      (${input.id}, ${input.projectID}, ${input.workspaceID ?? null}, ${input.parentID ?? null}, ${input.id},
       ${input.directory}, ${input.id}, '1', '{"source":true}',
       '[{"permission":"bash","pattern":"*","action":"allow"}]', 0, 0, 0, 0, 0, 0, 1, 10)
  `)
}

function insertMigration(db: Database.Interface["db"], id: string, sourcePath: string, sourceFingerprint: string) {
  return db.run(sql`
    INSERT INTO product_migration
      (id, status, source_path, source_fingerprint, revision, time_created, time_updated)
    VALUES (${id}, 'copying', ${sourcePath}, ${sourceFingerprint}, 1, 1, 1)
  `)
}

async function seedMinimalSource(database: string, directory: string, sessionID: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('project-minimal', ${directory}, 'Minimal', 1, 1, '[]')
      `)
      yield* insertSession(db, { id: sessionID, projectID: "project-minimal", directory })
    }).pipe(Effect.provide(Database.layerFromPath(database))),
  )
}

async function seedRollbackSource(database: string, directory: string, output: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('project-good', ${directory}, 'Good', 1, 1, '[]'), ('project-bad', ${directory}, 'Bad', 1, 1, '[]')
      `)
      yield* insertSession(db, { id: "ses_good", projectID: "project-good", directory })
      yield* insertSession(db, { id: "ses_bad", projectID: "project-bad", directory })
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_bad', 'ses_bad', 'assistant', 2, 2, 2, ${assistantWithOutput(output)})
      `)
    }).pipe(Effect.provide(Database.layerFromPath(database))),
  )
}

async function seedOutputSource(database: string, directory: string, output: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
        VALUES ('project-output', ${directory}, 'Output', 1, 1, '[]')
      `)
      yield* insertSession(db, { id: "ses_output", projectID: "project-output", directory })
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_output', 'ses_output', 'assistant', 2, 2, 2, ${assistantWithOutput(output)})
      `)
    }).pipe(Effect.provide(Database.layerFromPath(database))),
  )
}

function assistantWithOutput(output: string) {
  return JSON.stringify({
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id: "output",
        name: "bash",
        state: { status: "completed", input: {}, structured: {}, content: [], outputPaths: [output] },
        time: { created: 2, ran: 2, completed: 2 },
      },
    ],
    time: { created: 2, completed: 2 },
  })
}

function legacyAssistant(mode: string, completed?: number, parentID = "msg_legacy") {
  return JSON.stringify({
    role: "assistant",
    time: { created: completed ? 5 : 3, ...(completed === undefined ? {} : { completed }) },
    parentID,
    modelID: "test",
    providerID: "test",
    mode,
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function sourceIdentity(database: string, sessionCount: number) {
  const canonical = await realpath(database)
  const source = new sqlite.Database(canonical)
  source.run("PRAGMA wal_checkpoint(TRUNCATE)")
  source.close()
  const identity = await ProductMigrationSource.databaseIdentity(canonical)
  return {
    database: canonical,
    fingerprint: ProductMigrationSource.fingerprint({
      database: canonical,
      databaseBytes: identity.size,
      sessionCount,
      identity,
    }),
  }
}

async function fileState(...files: string[]) {
  return Promise.all(
    files.map(async (file) => ({
      file,
      hash: createHash("sha256")
        .update(Buffer.from(await Bun.file(file).arrayBuffer()))
        .digest("hex"),
      mode: (await lstat(file)).mode,
    })),
  )
}

function decodeCurrent(row: Record<string, string | number | null> | undefined) {
  if (!row) throw new Error("Missing current message")
  return Schema.decodeUnknownSync(SessionMessage.Message)({
    ...JSON.parse(String(row.data)),
    id: row.id,
    type: row.type,
  })
}

function decodePart(row: Record<string, string | number | null> | undefined) {
  if (!row) throw new Error("Missing part")
  return Schema.decodeUnknownSync(SessionV1.Part)({
    ...JSON.parse(String(row.data)),
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  })
}

function decodeLegacyMessage(row: Record<string, string | number | null>) {
  return Schema.decodeUnknownSync(SessionV1.Info)({
    ...JSON.parse(String(row.data)),
    id: row.id,
    sessionID: row.session_id,
  })
}

function referencedOutput(message: SessionMessage.Message) {
  if (message.type !== "assistant") throw new Error("Expected assistant message")
  const tool = message.content.find(
    (item) => item.type === "tool" && item.state.status === "completed" && item.state.outputPaths?.length,
  )
  if (!tool || tool.type !== "tool" || tool.state.status !== "completed" || !tool.state.outputPaths?.[0]) {
    throw new Error("Missing copied output")
  }
  return tool.state.outputPaths[0]
}

function directoryExists(directory: string) {
  return lstat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  )
}
