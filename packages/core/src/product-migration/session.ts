export * as ProductMigrationSession from "./session"

import { randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { Revert } from "@opencode-ai/schema/revert"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { FSUtil } from "../fs-util"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { SessionV1 } from "../v1/session"
import { ProductMigrationFile } from "./file"
import { ProductMigrationSnapshot } from "./snapshot"
import { ProductMigrationSource } from "./source"

type SqlValue = string | number | null
type Row = Record<string, SqlValue>
type DatabaseService = Database.Interface["db"]
type QueryDatabase = Pick<DatabaseService, "all" | "get" | "run">

export interface Selection {
  readonly projectID: string
  readonly sessionID: string
}

export interface ImportInput {
  readonly migrationID: string
  readonly sourceDatabase: string
  readonly sourceData: string
  readonly targetData: string
  readonly snapshotDirectory?: string
  readonly snapshot?: ProductMigrationSnapshot.Snapshot
  readonly selections: ReadonlyArray<Selection>
  readonly selectionInventory: ReadonlyArray<Selection>
  readonly sourceFingerprint?: string
  readonly databaseFingerprint: string
}

export interface ImportedSession {
  readonly sourceID: string
  readonly targetID: string
  readonly projectID: string
  readonly status: "ready" | "needs_attention"
  readonly checkpoint: "none" | "paused"
  readonly detached: boolean
  readonly missingFiles: ReadonlyArray<string>
  readonly rejectedFiles: ReadonlyArray<string>
}

export interface ImportResult {
  readonly sessions: ReadonlyArray<ImportedSession>
}

export interface CleanupInput {
  readonly migrationID: string
  readonly sourceSessionID: string
  readonly targetData: string
}

interface Closure {
  readonly project: Row
  readonly projectDirectories: ReadonlyArray<Row>
  readonly permissions: ReadonlyArray<Row>
  readonly workspace: Row | undefined
  readonly session: Row
  readonly messages: ReadonlyArray<Row>
  readonly parts: ReadonlyArray<Row>
  readonly sessionMessages: ReadonlyArray<Row>
  readonly inputs: ReadonlyArray<Row>
  readonly todos: ReadonlyArray<Row>
  readonly parentSelected: boolean
}

interface Entity {
  readonly type:
    | "project"
    | "workspace"
    | "session"
    | "message"
    | "part"
    | "session_message"
    | "session_input"
    | "todo"
    | "permission"
  readonly sourceID: string
  readonly targetID: string
}

interface CopyState {
  readonly fs: FSUtil.Interface
  readonly sourceData: string
  readonly targetData: string
  readonly attachmentRoots: ReadonlyArray<string>
  readonly targetSessionID: string
  readonly missingFiles: string[]
  readonly rejectedFiles: string[]
  readonly createdFiles: string[]
  readonly copiedFiles: Map<string, { readonly sha256: string; readonly size: number }>
}

interface CleanupTarget {
  readonly targetSessionID: string
  readonly targetProjectID?: string
  readonly sourceProjectID?: string
  readonly projectDirectories?: ReadonlyArray<string>
}

export class ImportError extends Schema.TaggedErrorClass<ImportError>()("ProductMigrationSessionImportError", {
  operation: Schema.String,
  sourceID: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation}${this.sourceID ? ` ${this.sourceID}` : ""}: ${detail}`
  }
}

export interface Interface {
  readonly import: (input: ImportInput) => Effect.Effect<ImportResult, ImportError>
  readonly cleanup: (input: CleanupInput) => Effect.Effect<void, ImportError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationSession") {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodeCurrentMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeCurrentMessage = Schema.encodeSync(SessionMessage.Message)
const decodeLegacyMessage = Schema.decodeUnknownSync(SessionV1.Info)
const encodeLegacyMessage = Schema.encodeSync(SessionV1.Info)
const decodeLegacyPart = Schema.decodeUnknownSync(SessionV1.Part)
const encodeLegacyPart = Schema.encodeSync(SessionV1.Part)
const decodeRevert = Schema.decodeUnknownSync(Revert.State)
const encodeRevert = Schema.encodeSync(Revert.State)
const CleanupMetadata = Schema.Struct({
  productMigration: Schema.Struct({
    migrationID: Schema.String.check(Schema.isMaxLength(256)),
    sourceID: Schema.String.check(Schema.isMaxLength(256)),
    closure: Schema.Struct({
      projectID: Schema.String.check(Schema.isMaxLength(256)),
      projectDirectories: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
        Schema.isMaxLength(10_000),
      ),
    }),
  }),
})
const decodeCleanupMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(CleanupMetadata))
const interrupted = "Interrupted while importing an active OpenCode session"
const snapshotMaxBytes = 256 * 1024 * 1024

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const sqlite = yield* Effect.promise(() => import("bun:sqlite"))

    return Service.of({
      import: Effect.fn("ProductMigrationSession.import")(function* (input) {
        const sourceData = yield* canonicalDirectory(fs, input.sourceData, "resolve source data root")
        const sourceDatabase = yield* canonicalFile(fs, input.sourceDatabase, "resolve source database")
        const targetData = yield* canonicalDirectory(fs, input.targetData, "resolve target data root")
        if (!inside(sourceData, sourceDatabase)) {
          return yield* new ImportError({
            operation: "validate source database",
            cause: new Error("Source database is outside the source data root"),
          })
        }
        if (overlaps(sourceData, targetData) || inside(targetData, sourceDatabase)) {
          return yield* new ImportError({
            operation: "validate storage isolation",
            cause: new Error("Source and target storage overlap"),
          })
        }

        const migration = yield* db
          .get<{ source_path: string | null; source_fingerprint: string | null }>(
            sql`
            SELECT source_path, source_fingerprint FROM product_migration WHERE id = ${input.migrationID}
          `,
          )
          .pipe(
            Effect.mapError(
              (cause) => new ImportError({ operation: "read migration journal", sourceID: input.migrationID, cause }),
            ),
          )
        const migrationFingerprint = migration?.source_fingerprint
        if (!migrationFingerprint || migration.source_path !== sourceDatabase) {
          return yield* new ImportError({
            operation: "verify migration source",
            sourceID: input.migrationID,
            cause: new Error("Migration journal source identity does not match the canonical source database"),
          })
        }
        const readSnapshot = (copy: ProductMigrationSnapshot.Snapshot) =>
          Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                return ProductMigrationSource.openReadTransaction(
                  () => new sqlite.Database(copy.database, { readonly: true, strict: true }),
                )
              },
              catch: (cause) => new ImportError({ operation: "open read-only source", cause }),
            }),
            (source) =>
              Effect.try({
                try: () => ({ ...readClosures(source, input.selections, input.selectionInventory), identity: copy.identity }),
                catch: (cause) => new ImportError({ operation: "read source snapshot", cause }),
              }),
            (source) => Effect.sync(() => source.close(false)),
          )
        const snapshot = yield* (
          input.snapshot
            ? readSnapshot(input.snapshot)
            : ProductMigrationSnapshot.use(
                { database: sourceDatabase, directory: input.snapshotDirectory },
                readSnapshot,
              )
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof ImportError ? cause : new ImportError({ operation: "snapshot source database", cause }),
          ),
        )
        const fingerprint = ProductMigrationSource.fingerprint({
          database: sourceDatabase,
          databaseBytes: snapshot.identity.size,
          sessionCount: snapshot.sessionCount,
          identity: snapshot.identity,
        })
        if (!input.databaseFingerprint || input.databaseFingerprint !== fingerprint) {
          return yield* new ImportError({
            operation: "verify migration source",
            sourceID: input.migrationID,
            cause: new Error("Migration source fingerprint changed"),
          })
        }

        // A failed session stops this batch; durable mappings let the executor retry or continue explicitly.
        const sessions = yield* Effect.forEach(
          snapshot.closures,
          (closure) =>
            importClosure({
              db,
              fs,
              input: { ...input, sourceDatabase, sourceData, targetData },
              closure,
              sourceFingerprint: input.sourceFingerprint ?? migrationFingerprint,
            }),
          { concurrency: 1 },
        )
        const requested = new Set(input.selections.map((selection) => selection.sessionID))
        return { sessions: sessions.filter((session) => requested.has(session.sourceID)) }
      }),
      cleanup: Effect.fn("ProductMigrationSession.cleanup")(function* (input) {
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const owned = yield* cleanupTarget(tx, input)
                if (!owned) return
                const copied = path.resolve(input.targetData, "product-migration", owned.targetSessionID)
                const relative = path.relative(path.resolve(input.targetData), copied)
                if (
                  path.basename(owned.targetSessionID) !== owned.targetSessionID ||
                  relative === ".." ||
                  relative.startsWith(`..${path.sep}`) ||
                  path.isAbsolute(relative)
                ) {
                  return yield* new ImportError({
                    operation: "clean imported session",
                    sourceID: input.sourceSessionID,
                    cause: new Error("Imported session mapping resolves outside target data"),
                  })
                }
                yield* fs.remove(copied, { recursive: true, force: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ImportError({
                        operation: "remove imported session files",
                        sourceID: input.sourceSessionID,
                        cause,
                      }),
                  ),
                )
                yield* cleanupDatabase(tx, input, owned)
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof ImportError
                ? cause
                : new ImportError({ operation: "clean imported session", sourceID: input.sourceSessionID, cause }),
            ),
          )
      }),
    })
  }),
)

function cleanupTarget(
  db: QueryDatabase,
  input: CleanupInput,
): Effect.Effect<CleanupTarget | undefined, ImportError, never> {
  return Effect.gen(function* () {
    const mapping = yield* db.get<{ target_id: string }>(sql`
      SELECT target_id FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND entity_type = 'session'
        AND source_id = ${input.sourceSessionID}
    `)
    if (!mapping) return undefined
    const session = yield* db.get<{ project_id: string; metadata: string | null }>(sql`
      SELECT project_id, metadata FROM session WHERE id = ${mapping.target_id}
    `)
    if (!session) {
      return yield* new ImportError({
        operation: "clean imported session",
        sourceID: input.sourceSessionID,
        cause: new Error("Target session ownership marker is missing"),
      })
    }
    const metadata = Option.getOrUndefined(decodeCleanupMetadata(session.metadata ?? ""))
    if (
      !metadata ||
      metadata.productMigration.migrationID !== input.migrationID ||
      metadata.productMigration.sourceID !== input.sourceSessionID
    ) {
      return yield* new ImportError({
        operation: "clean imported session",
        sourceID: input.sourceSessionID,
        cause: new Error("Target session is not owned by this migration"),
      })
    }
    const project = yield* db.get<{ target_id: string }>(sql`
      SELECT target_id FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND entity_type = 'project'
        AND source_id = ${metadata.productMigration.closure.projectID}
    `)
    if (!project || project.target_id !== session.project_id) {
      return yield* new ImportError({
        operation: "clean imported session",
        sourceID: input.sourceSessionID,
        cause: new Error("Target project is not owned by this migration"),
      })
    }
    return {
      targetSessionID: mapping.target_id,
      targetProjectID: session.project_id,
      sourceProjectID: metadata.productMigration.closure.projectID,
      projectDirectories: metadata.productMigration.closure.projectDirectories,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ImportError
        ? cause
        : new ImportError({ operation: "read imported session ownership", sourceID: input.sourceSessionID, cause }),
    ),
  )
}

function cleanupDatabase(db: QueryDatabase, input: CleanupInput, owned: CleanupTarget) {
  return Effect.gen(function* () {
    const mapping = yield* db.get<{ target_id: string }>(sql`
      SELECT target_id FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND entity_type = 'session'
        AND source_id = ${input.sourceSessionID}
    `)
    if (!mapping) return
    if (mapping.target_id !== owned.targetSessionID) {
      return yield* new ImportError({
        operation: "clean imported session",
        sourceID: input.sourceSessionID,
        cause: new Error("Imported session mapping changed during cleanup"),
      })
    }
    const session = yield* db.get<{ project_id: string; metadata: string | null }>(sql`
      SELECT project_id, metadata FROM session WHERE id = ${owned.targetSessionID}
    `)
    if (session) {
      const metadata = Option.getOrUndefined(decodeCleanupMetadata(session.metadata ?? ""))
      if (
        !metadata ||
        metadata.productMigration.migrationID !== input.migrationID ||
        metadata.productMigration.sourceID !== input.sourceSessionID ||
        session.project_id !== owned.targetProjectID
      ) {
        return yield* new ImportError({
          operation: "clean imported session",
          sourceID: input.sourceSessionID,
          cause: new Error("Target session ownership changed during cleanup"),
        })
      }
    }
    yield* db.run(sql`
      DELETE FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND (
        (entity_type = 'session' AND source_id = ${input.sourceSessionID}) OR
        (entity_type = 'message' AND target_id IN
          (SELECT id FROM message WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'part' AND target_id IN
          (SELECT id FROM part WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'session_message' AND target_id IN
          (SELECT id FROM session_message WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'session_input' AND target_id IN
          (SELECT id FROM session_input WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'todo' AND substr(source_id, 1, ${input.sourceSessionID.length + 1}) = ${`${input.sourceSessionID}:`}) OR
        (entity_type = 'graph_node' AND target_id IN
          (SELECT id FROM graph_node WHERE session_id = ${owned.targetSessionID}
           UNION
           SELECT json_extract(node.value, '$.id')
           FROM graph_version AS version, json_each(version.snapshot, '$.nodes') AS node
           WHERE version.session_id = ${owned.targetSessionID})) OR
        (entity_type = 'graph_edge' AND target_id IN
          (SELECT id FROM graph_edge WHERE session_id = ${owned.targetSessionID}
           UNION
           SELECT json_extract(edge.value, '$.id')
           FROM graph_version AS version, json_each(version.snapshot, '$.edges') AS edge
           WHERE version.session_id = ${owned.targetSessionID})) OR
        (entity_type = 'graph_version' AND target_id IN
          (SELECT id FROM graph_version WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'graph_evidence' AND target_id IN
          (SELECT id FROM graph_tool_run WHERE session_id = ${owned.targetSessionID})) OR
        (entity_type = 'graph_generation' AND target_id IN
          (SELECT id FROM graph_generation_run WHERE session_id = ${owned.targetSessionID}))
      )
    `)
    yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = ${owned.targetSessionID}`)
    yield* db.run(sql`DELETE FROM session WHERE id = ${owned.targetSessionID}`)
    if (!owned.targetProjectID || !owned.sourceProjectID) return
    const remaining = yield* db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM session WHERE project_id = ${owned.targetProjectID}
    `)
    if ((remaining?.count ?? 0) > 0) return
    const project = yield* db.get<{ target_id: string }>(sql`
      SELECT target_id FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND entity_type = 'project'
        AND source_id = ${owned.sourceProjectID}
    `)
    if (!project || project.target_id !== owned.targetProjectID) return
    const unownedWorkspace = yield* db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM workspace
      WHERE project_id = ${owned.targetProjectID} AND id NOT IN (
        SELECT target_id FROM product_migration_entity
        WHERE migration_id = ${input.migrationID} AND entity_type = 'workspace'
      )
    `)
    const unownedPermission = yield* db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM permission
      WHERE project_id = ${owned.targetProjectID} AND id NOT IN (
        SELECT target_id FROM product_migration_entity
        WHERE migration_id = ${input.migrationID} AND entity_type = 'permission'
      )
    `)
    const directories = yield* db.all<{ directory: string }>(sql`
      SELECT directory FROM project_directory WHERE project_id = ${owned.targetProjectID}
    `)
    if (
      (unownedWorkspace?.count ?? 0) > 0 ||
      (unownedPermission?.count ?? 0) > 0 ||
      directories.some((row) => !owned.projectDirectories?.includes(row.directory))
    ) {
      return
    }
    yield* db.run(sql`
      DELETE FROM product_migration_entity
      WHERE migration_id = ${input.migrationID} AND (
        (entity_type = 'project' AND source_id = ${owned.sourceProjectID}) OR
        (entity_type = 'workspace' AND target_id IN
          (SELECT id FROM workspace WHERE project_id = ${owned.targetProjectID})) OR
        (entity_type = 'permission' AND target_id IN
          (SELECT id FROM permission WHERE project_id = ${owned.targetProjectID}))
      )
    `)
    yield* db.run(sql`DELETE FROM project WHERE id = ${owned.targetProjectID}`)
  })
}

function readClosures(
  source: import("bun:sqlite").Database,
  selections: ReadonlyArray<Selection>,
  selectionInventory: ReadonlyArray<Selection>,
) {
  const tables = new Set(
    source
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const required = [
    "project",
    "project_directory",
    "workspace",
    "session",
    "message",
    "part",
    "session_message",
    "session_input",
    "todo",
    "permission",
  ]
  if (required.some((table) => !tables.has(table))) throw new Error("Unsupported OpenCode session schema")
  const requested = [
    ...new Map(selections.map((selection) => [`${selection.projectID}\0${selection.sessionID}`, selection])).values(),
  ]
  const inventory = new Map(selectionInventory.map((selection) => [selection.sessionID, selection]))
  const unique: Selection[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const include = (selection: Selection) => {
    if (visited.has(selection.sessionID) || visiting.has(selection.sessionID)) return
    visiting.add(selection.sessionID)
    const session = source.query<Row, [string]>("SELECT * FROM session WHERE id = ?").get(selection.sessionID)
    if (!session) throw new Error(`Selected session does not exist: ${selection.sessionID}`)
    const parentID = nullableText(session, "parent_id")
    const parent = parentID ? inventory.get(parentID) : undefined
    if (parent) include(parent)
    visiting.delete(selection.sessionID)
    visited.add(selection.sessionID)
    unique.push(selection)
  }
  requested.forEach(include)
  const selectedSessions = new Set(selectionInventory.map((selection) => selection.sessionID))
  const closures = unique.map((selection): Closure => {
    const projectBounds = sourceBounds(source, "project", "id", selection.projectID, 1)
    const sessionBounds = sourceBounds(source, "session", "id", selection.sessionID, 1)
    const project = source.query<Row, [string]>("SELECT * FROM project WHERE id = ?").get(selection.projectID)
    if (!project) throw new Error(`Selected project does not exist: ${selection.projectID}`)
    const session = source.query<Row, [string]>("SELECT * FROM session WHERE id = ?").get(selection.sessionID)
    if (!session) throw new Error(`Selected session does not exist: ${selection.sessionID}`)
    if (text(session, "project_id") !== selection.projectID) {
      throw new Error(`Session ${selection.sessionID} does not belong to project ${selection.projectID}`)
    }
    const workspaceID = nullableText(session, "workspace_id")
    const bounds = [
      projectBounds,
      sessionBounds,
      sourceBounds(source, "project_directory", "project_id", selection.projectID, 10_000),
      sourceBounds(source, "permission", "project_id", selection.projectID, 100_000),
      ...(workspaceID ? [sourceBounds(source, "workspace", "id", workspaceID, 1)] : []),
      sourceBounds(source, "message", "session_id", selection.sessionID, 100_000),
      sourceBounds(source, "part", "session_id", selection.sessionID, 500_000),
      sourceBounds(source, "session_message", "session_id", selection.sessionID, 100_000),
      sourceBounds(source, "session_input", "session_id", selection.sessionID, 100_000),
      sourceBounds(source, "todo", "session_id", selection.sessionID, 10_000),
    ]
    const bytes = bounds.reduce((total, bound) => total + bound.bytes, 0)
    if (bytes > snapshotMaxBytes) {
      throw new Error(`Selected session snapshot exceeds ${snapshotMaxBytes} encoded payload bytes`)
    }
    return {
      project,
      projectDirectories: source
        .query<Row, [string]>("SELECT * FROM project_directory WHERE project_id = ? ORDER BY directory")
        .all(selection.projectID),
      permissions: source
        .query<Row, [string]>("SELECT * FROM permission WHERE project_id = ? ORDER BY id")
        .all(selection.projectID),
      workspace: workspaceID
        ? (source.query<Row, [string]>("SELECT * FROM workspace WHERE id = ?").get(workspaceID) ?? undefined)
        : undefined,
      session,
      messages: source
        .query<Row, [string]>("SELECT * FROM message WHERE session_id = ? ORDER BY id")
        .all(selection.sessionID),
      parts: source
        .query<Row, [string]>("SELECT * FROM part WHERE session_id = ? ORDER BY id")
        .all(selection.sessionID),
      sessionMessages: source
        .query<Row, [string]>("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq")
        .all(selection.sessionID),
      inputs: source
        .query<Row, [string]>("SELECT * FROM session_input WHERE session_id = ? ORDER BY admitted_seq")
        .all(selection.sessionID),
      todos: source
        .query<Row, [string]>("SELECT * FROM todo WHERE session_id = ? ORDER BY position")
        .all(selection.sessionID),
      parentSelected: nullableText(session, "parent_id")
        ? selectedSessions.has(nullableText(session, "parent_id") ?? "")
        : false,
    }
  })
  return {
    sessionCount: source.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0,
    closures: orderClosures(closures),
  }
}

function sourceBounds(
  source: import("bun:sqlite").Database,
  table: string,
  filter: string,
  value: string,
  maxRows: number,
) {
  const columns = source.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all()
  if (columns.length > 256) throw new Error(`${table} column limit exceeded`)
  const payload = columns
    .map((column) => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)), 0)`)
    .join(" + ")
  const result = source
    .query<{ count: number; bytes: number | null }, [string]>(
      `SELECT COUNT(*) AS count, SUM(${payload || "0"}) AS bytes
       FROM "${table}" WHERE "${filter}" = ?`,
    )
    .get(value)
  const count = result?.count ?? 0
  if (count > maxRows) throw new Error(`${table} row limit exceeded: ${count} > ${maxRows}`)
  return { count, bytes: result?.bytes ?? 0 }
}

function orderClosures(closures: ReadonlyArray<Closure>) {
  const byID = new Map(closures.map((closure) => [text(closure.session, "id"), closure]))
  const output: Closure[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (closure: Closure) => {
    const id = text(closure.session, "id")
    if (visited.has(id)) return
    if (visiting.has(id)) return
    visiting.add(id)
    const parent = nullableText(closure.session, "parent_id")
    const ancestor = parent ? byID.get(parent) : undefined
    if (ancestor) visit(ancestor)
    visiting.delete(id)
    visited.add(id)
    output.push(closure)
  }
  closures.forEach(visit)
  return output
}

function importClosure(options: {
  readonly db: DatabaseService
  readonly fs: FSUtil.Interface
  readonly input: ImportInput
  readonly closure: Closure
  readonly sourceFingerprint: string
}) {
  return Effect.gen(function* () {
    const sourceSessionID = text(options.closure.session, "id")
    const projectRoot = yield* existingDirectory(text(options.closure.project, "worktree"))
    const sessionRoot = yield* existingDirectory(text(options.closure.session, "directory"))
    const attachmentRoot = yield* existingDirectory(path.join(options.input.sourceData, "attachments"))
    const detached = projectRoot === undefined || sessionRoot === undefined
    const missingParent = nullableText(options.closure.session, "parent_id") !== null && !options.closure.parentSelected
    const missingWorkspace =
      nullableText(options.closure.session, "workspace_id") !== null && !options.closure.workspace
    const needsAttention = detached || missingParent || missingWorkspace || active(options.closure)
    const status = needsAttention ? "needs_attention" : "ready"
    const checkpoint = needsAttention ? "paused" : "none"
    const missingFiles: string[] = []
    const rejectedFiles: string[] = []
    const createdFiles: string[] = []
    const copiedFiles = new Map<string, { readonly sha256: string; readonly size: number }>()

    const transaction = options.db.transaction((tx) =>
      Effect.gen(function* () {
        const project = yield* adoptEntity(tx, options, "project", text(options.closure.project, "id"))
        const workspace = options.closure.workspace
          ? yield* adoptEntity(tx, options, "workspace", text(options.closure.workspace, "id"))
          : undefined
        const session = yield* adoptEntity(tx, options, "session", sourceSessionID)
        const messages = yield* Effect.forEach(options.closure.messages, (row) =>
          adoptEntity(tx, options, "message", text(row, "id")),
        )
        const parts = yield* Effect.forEach(options.closure.parts, (row) =>
          adoptEntity(tx, options, "part", text(row, "id")),
        )
        const current = yield* Effect.forEach(options.closure.sessionMessages, (row) =>
          adoptEntity(tx, options, "session_message", text(row, "id")),
        )
        const inputs = yield* Effect.forEach(options.closure.inputs, (row) =>
          adoptEntity(
            tx,
            options,
            "session_input",
            text(row, "id"),
            current.find((item) => item.sourceID === text(row, "id"))?.targetID,
          ),
        )
        const todos = yield* Effect.forEach(options.closure.todos, (row) =>
          adoptEntity(tx, options, "todo", `${text(row, "session_id")}:${number(row, "position")}`),
        )
        const permissions = yield* Effect.forEach(options.closure.permissions, (row) =>
          adoptEntity(tx, options, "permission", text(row, "id")),
        )
        const entities = [
          project,
          ...(workspace ? [workspace] : []),
          session,
          ...messages,
          ...parts,
          ...current,
          ...inputs,
          ...todos,
          ...permissions,
        ]
        const target = (type: Entity["type"], sourceID: string) => {
          const entity = entities.find((item) => item.type === type && item.sourceID === sourceID)
          if (!entity) throw new Error(`Missing ${type} mapping for ${sourceID}`)
          return entity.targetID
        }
        const parentID = options.closure.parentSelected
          ? yield* mappedTarget(tx, options, "session", nullableText(options.closure.session, "parent_id") ?? "")
          : undefined
        const neutralStart = Math.max(
          -1,
          ...options.closure.sessionMessages.map((row) => number(row, "seq")),
          ...options.closure.inputs.flatMap((row) => [
            number(row, "admitted_seq"),
            nullableNumber(row, "promoted_seq") ?? -1,
          ]),
        )
        const pending = new Map(
          options.closure.inputs
            .filter((row) => nullableNumber(row, "promoted_seq") === null)
            .map((row, index) => [text(row, "id"), neutralStart + index + 1]),
        )
        const copy: CopyState = {
          fs: options.fs,
          sourceData: options.input.sourceData,
          targetData: options.input.targetData,
          attachmentRoots: [attachmentRoot, projectRoot, sessionRoot].filter(
            (root): root is string => root !== undefined,
          ),
          targetSessionID: session.targetID,
          missingFiles,
          rejectedFiles,
          createdFiles,
          copiedFiles,
        }

        yield* tx.run(sql`
          INSERT INTO project
            (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated,
             time_initialized, sandboxes, commands)
          VALUES
            (${project.targetID}, ${text(options.closure.project, "worktree")},
             ${nullableText(options.closure.project, "vcs")},
             ${detached ? `[Detached] ${nullableText(options.closure.project, "name") ?? path.basename(text(options.closure.project, "worktree"))}` : nullableText(options.closure.project, "name")},
             ${nullableText(options.closure.project, "icon_url")},
             ${nullableText(options.closure.project, "icon_url_override")},
             ${nullableText(options.closure.project, "icon_color")},
             ${number(options.closure.project, "time_created")}, ${number(options.closure.project, "time_updated")},
             ${nullableNumber(options.closure.project, "time_initialized")},
             ${text(options.closure.project, "sandboxes")}, ${nullableText(options.closure.project, "commands")})
          ON CONFLICT(id) DO NOTHING
        `)
        yield* Effect.forEach(
          options.closure.projectDirectories,
          (row) =>
            tx.run(sql`
              INSERT INTO project_directory (project_id, directory, type, strategy, time_created)
              VALUES (${project.targetID}, ${text(row, "directory")}, ${nullableText(row, "type")},
                      ${nullableText(row, "strategy")}, ${number(row, "time_created")})
              ON CONFLICT(project_id, directory) DO NOTHING
            `),
          { discard: true },
        )
        if (options.closure.workspace && workspace) {
          yield* tx.run(sql`
            INSERT INTO workspace (id, type, name, branch, directory, extra, project_id, time_used)
            VALUES (${workspace.targetID}, ${text(options.closure.workspace, "type")},
                    ${text(options.closure.workspace, "name")}, ${nullableText(options.closure.workspace, "branch")},
                    ${nullableText(options.closure.workspace, "directory")},
                    ${nullableText(options.closure.workspace, "extra")}, ${project.targetID},
                    ${number(options.closure.workspace, "time_used")})
            ON CONFLICT(id) DO NOTHING
          `)
        }

        const previous = yield* tx.get<{ metadata: string | null }>(sql`
          SELECT metadata FROM session WHERE id = ${session.targetID}
        `)
        if (previous && !sameImport(previous.metadata, options.input.migrationID, sourceSessionID)) {
          return yield* new ImportError({
            operation: "import session",
            sourceID: sourceSessionID,
            cause: new Error(`Target session ID is already in use: ${session.targetID}`),
          })
        }
        const metadata = sessionMetadata(
          nullableText(options.closure.session, "metadata"),
          options.input.migrationID,
          sourceSessionID,
          status,
          checkpoint,
          detached,
          missingParent,
          missingWorkspace,
          [...pending.keys()],
          options.closure,
          [],
        )
        const revert = sessionRevertData(nullableText(options.closure.session, "revert"), messages, current, parts)
        yield* tx.run(sql`
          INSERT INTO session
            (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
             summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input,
             tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model,
             time_created, time_updated, time_compacting, time_archived)
          VALUES
            (${session.targetID}, ${project.targetID}, ${workspace?.targetID ?? null}, ${parentID ?? null},
             ${text(options.closure.session, "slug")}, ${text(options.closure.session, "directory")},
             ${nullableText(options.closure.session, "path")}, ${text(options.closure.session, "title")},
             ${text(options.closure.session, "version")}, NULL,
             ${nullableNumber(options.closure.session, "summary_additions")},
             ${nullableNumber(options.closure.session, "summary_deletions")},
             ${nullableNumber(options.closure.session, "summary_files")},
             ${nullableText(options.closure.session, "summary_diffs")}, ${metadata},
             ${number(options.closure.session, "cost")}, ${number(options.closure.session, "tokens_input")},
             ${number(options.closure.session, "tokens_output")}, ${number(options.closure.session, "tokens_reasoning")},
             ${number(options.closure.session, "tokens_cache_read")},
             ${number(options.closure.session, "tokens_cache_write")},
             ${revert}, NULL,
             ${nullableText(options.closure.session, "agent")}, ${nullableText(options.closure.session, "model")},
             ${number(options.closure.session, "time_created")}, ${number(options.closure.session, "time_updated")},
             NULL, ${nullableNumber(options.closure.session, "time_archived")})
          ON CONFLICT(id) DO NOTHING
        `)

        yield* Effect.forEach(
          options.closure.messages,
          (row) =>
            Effect.gen(function* () {
              const data = legacyMessageData(row, session.targetID, target("message", text(row, "id")), messages)
              yield* tx.run(sql`
                INSERT INTO message (id, session_id, time_created, time_updated, data)
                VALUES (${target("message", text(row, "id"))}, ${session.targetID},
                        ${number(row, "time_created")}, ${number(row, "time_updated")}, ${data})
                ON CONFLICT(id) DO NOTHING
              `)
            }),
          { discard: true },
        )
        yield* Effect.forEach(
          options.closure.parts,
          (row) =>
            Effect.gen(function* () {
              const data = yield* legacyPartData(
                row,
                session.targetID,
                target("message", text(row, "message_id")),
                target("part", text(row, "id")),
                messages,
                copy,
              )
              yield* tx.run(sql`
                INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                VALUES (${target("part", text(row, "id"))}, ${target("message", text(row, "message_id"))},
                        ${session.targetID}, ${number(row, "time_created")}, ${number(row, "time_updated")}, ${data})
                ON CONFLICT(id) DO NOTHING
              `)
            }),
          { discard: true },
        )
        yield* Effect.forEach(
          options.closure.sessionMessages,
          (row) =>
            Effect.gen(function* () {
              const data = yield* currentMessageData(
                row,
                session.targetID,
                target("session_message", text(row, "id")),
                copy,
              )
              yield* tx.run(sql`
                INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
                VALUES (${target("session_message", text(row, "id"))}, ${session.targetID}, ${text(row, "type")},
                        ${number(row, "seq")}, ${number(row, "time_created")}, ${number(row, "time_updated")}, ${data})
                ON CONFLICT(id) DO NOTHING
              `)
            }),
          { discard: true },
        )
        yield* Effect.forEach(
          options.closure.inputs,
          (row) =>
            Effect.gen(function* () {
              const prompt = yield* promptData(text(row, "prompt"), copy)
              yield* tx.run(sql`
                INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
                VALUES (${target("session_input", text(row, "id"))}, ${session.targetID}, ${prompt},
                        ${text(row, "delivery")}, ${number(row, "admitted_seq")},
                        ${nullableNumber(row, "promoted_seq") ?? pending.get(text(row, "id"))},
                        ${number(row, "time_created")})
                ON CONFLICT(id) DO NOTHING
              `)
            }),
          { discard: true },
        )
        yield* Effect.forEach(
          options.closure.todos,
          (row) =>
            tx.run(sql`
              INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
              VALUES (${session.targetID}, ${text(row, "content")}, ${text(row, "status")},
                      ${text(row, "priority")}, ${number(row, "position")},
                      ${number(row, "time_created")}, ${number(row, "time_updated")})
              ON CONFLICT(session_id, position) DO NOTHING
            `),
          { discard: true },
        )
        yield* Effect.forEach(
          options.closure.permissions,
          (row) =>
            tx.run(sql`
              INSERT INTO permission (id, project_id, action, resource, time_created, time_updated)
              VALUES (${target("permission", text(row, "id"))}, ${project.targetID}, ${text(row, "action")},
                      ${text(row, "resource")}, ${number(row, "time_created")}, ${number(row, "time_updated")})
              ON CONFLICT(id) DO NOTHING
            `),
          { discard: true },
        )
        const completedMetadata = sessionMetadata(
          nullableText(options.closure.session, "metadata"),
          options.input.migrationID,
          sourceSessionID,
          status,
          checkpoint,
          detached,
          missingParent,
          missingWorkspace,
          [...pending.keys()],
          options.closure,
          [...copiedFiles]
            .map(([file, value]) => ({ file, ...value }))
            .toSorted((left, right) => ProductMigrationSource.ordinal(left.file, right.file)),
        )
        yield* tx.run(sql`UPDATE session SET metadata = ${completedMetadata} WHERE id = ${session.targetID}`)
        const sequence = Math.max(
          neutralStart,
          ...pending.values(),
          ...options.closure.inputs.map((row) => nullableNumber(row, "promoted_seq") ?? -1),
        )
        yield* tx.run(sql`
          INSERT INTO event_sequence (aggregate_id, seq, owner_id)
          VALUES (${session.targetID}, ${sequence}, NULL)
          ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(event_sequence.seq, excluded.seq)
        `)
      }),
    )
    yield* transaction.pipe(
      Effect.onError(() =>
        Effect.forEach(createdFiles, (file) => options.fs.remove(file).pipe(Effect.ignore), { discard: true }),
      ),
      Effect.mapError((cause) =>
        cause instanceof ImportError
          ? cause
          : new ImportError({ operation: "import session", sourceID: sourceSessionID, cause }),
      ),
    )
    const targetSession = yield* options.db
      .get<{ target_id: string }>(
        sql`
        SELECT target_id FROM product_migration_entity
        WHERE migration_id = ${options.input.migrationID} AND entity_type = 'session' AND source_id = ${sourceSessionID}
      `,
      )
      .pipe(
        Effect.mapError(
          (cause) => new ImportError({ operation: "read imported session", sourceID: sourceSessionID, cause }),
        ),
      )
    const targetProject = yield* options.db
      .get<{ target_id: string }>(
        sql`
        SELECT target_id FROM product_migration_entity
        WHERE migration_id = ${options.input.migrationID} AND entity_type = 'project'
          AND source_id = ${text(options.closure.project, "id")}
      `,
      )
      .pipe(
        Effect.mapError(
          (cause) => new ImportError({ operation: "read imported project", sourceID: sourceSessionID, cause }),
        ),
      )
    if (!targetSession || !targetProject) {
      return yield* new ImportError({
        operation: "read imported mappings",
        sourceID: sourceSessionID,
        cause: new Error("Missing committed mapping"),
      })
    }
    return {
      sourceID: sourceSessionID,
      targetID: targetSession.target_id,
      projectID: targetProject.target_id,
      status,
      checkpoint,
      detached,
      missingFiles: [...new Set(missingFiles)].sort(),
      rejectedFiles: [...new Set(rejectedFiles)].sort(),
    } satisfies ImportedSession
  })
}

function adoptEntity(
  db: QueryDatabase,
  options: { readonly input: ImportInput; readonly sourceFingerprint: string },
  type: Entity["type"],
  sourceID: string,
  preferred?: string,
) {
  return Effect.gen(function* () {
    const candidate = preferred ?? targetID(type)
    yield* db.run(sql`
      INSERT INTO product_migration_entity
        (migration_id, entity_type, source_id, source_fingerprint, target_id, time_created, time_updated)
      VALUES (${options.input.migrationID}, ${type}, ${sourceID}, ${options.sourceFingerprint},
              ${candidate}, ${Date.now()}, ${Date.now()})
      ON CONFLICT(migration_id, entity_type, source_id) DO NOTHING
    `)
    const row = yield* db.get<{ source_fingerprint: string; target_id: string }>(sql`
      SELECT source_fingerprint, target_id FROM product_migration_entity
      WHERE migration_id = ${options.input.migrationID} AND entity_type = ${type} AND source_id = ${sourceID}
    `)
    if (!row || row.source_fingerprint !== options.sourceFingerprint) {
      return yield* new ImportError({
        operation: "adopt entity mapping",
        sourceID,
        cause: new Error(!row ? "Mapping was not inserted" : "Source fingerprint changed"),
      })
    }
    if (preferred && row.target_id !== preferred) {
      return yield* new ImportError({
        operation: "adopt entity mapping",
        sourceID,
        cause: new Error("Related projection mappings disagree"),
      })
    }
    return { type, sourceID, targetID: row.target_id } satisfies Entity
  })
}

function mappedTarget(
  db: QueryDatabase,
  options: { readonly input: ImportInput; readonly sourceFingerprint: string },
  type: Entity["type"],
  sourceID: string,
) {
  return Effect.gen(function* () {
    const row = yield* db.get<{ source_fingerprint: string; target_id: string }>(sql`
      SELECT source_fingerprint, target_id FROM product_migration_entity
      WHERE migration_id = ${options.input.migrationID} AND entity_type = ${type} AND source_id = ${sourceID}
    `)
    if (!row || row.source_fingerprint !== options.sourceFingerprint) return undefined
    return row.target_id
  })
}

function targetID(type: Entity["type"]) {
  const id = randomUUID().replaceAll("-", "")
  if (type === "session") return `ses_${id}`
  if (type === "message" || type === "session_message" || type === "session_input") return `msg_${id}`
  if (type === "part") return `prt_${id}`
  if (type === "workspace") return `wrk_${id}`
  if (type === "project") return `migrated_${id}`
  if (type === "permission") return `permission_${id}`
  return `todo_${id}`
}

function legacyMessageData(row: Row, sessionID: string, id: string, messages: ReadonlyArray<Entity>) {
  const source = decodeLegacyMessage({
    ...parseRecord(text(row, "data")),
    id: text(row, "id"),
    sessionID: text(row, "session_id"),
  })
  const target =
    source.role === "assistant"
      ? {
          ...source,
          id: SessionV1.MessageID.ascending(id),
          sessionID: SessionSchema.ID.make(sessionID),
          parentID: SessionV1.MessageID.ascending(relatedTarget(messages, source.parentID, "legacy assistant parent")),
          time: source.time.completed ? source.time : { ...source.time, completed: number(row, "time_updated") },
          error: source.time.completed ? source.error : new SessionV1.AbortedError({ message: interrupted }).toObject(),
        }
      : { ...source, id: SessionV1.MessageID.ascending(id), sessionID: SessionSchema.ID.make(sessionID) }
  const encoded = encodeLegacyMessage(target)
  const { id: omittedID, sessionID: omittedSessionID, ...data } = encoded
  void omittedID
  void omittedSessionID
  return JSON.stringify(data)
}

function legacyPartData(
  row: Row,
  sessionID: string,
  messageID: string,
  id: string,
  messages: ReadonlyArray<Entity>,
  copy: CopyState,
) {
  return Effect.gen(function* () {
    const source = decodeLegacyPart({
      ...parseRecord(text(row, "data")),
      id: text(row, "id"),
      sessionID: text(row, "session_id"),
      messageID: text(row, "message_id"),
    })
    const base = {
      ...source,
      id: SessionV1.PartID.ascending(id),
      sessionID: SessionSchema.ID.make(sessionID),
      messageID: SessionV1.MessageID.ascending(messageID),
    }
    const target =
      source.type === "file"
        ? { ...base, url: yield* copyReference(source.url, "attachment", copy) }
        : source.type === "compaction"
          ? {
              ...base,
              tail_start_id: source.tail_start_id
                ? SessionV1.MessageID.ascending(relatedTarget(messages, source.tail_start_id, "legacy compaction tail"))
                : undefined,
            }
          : source.type === "tool"
            ? {
                ...base,
                state:
                  source.state.status === "completed"
                    ? {
                        ...source.state,
                        attachments: source.state.attachments
                          ? yield* Effect.forEach(source.state.attachments, (attachment) =>
                              copyReference(attachment.url, "attachment", copy).pipe(
                                Effect.map((url) => ({
                                  ...attachment,
                                  sessionID: SessionSchema.ID.make(sessionID),
                                  messageID: SessionV1.MessageID.ascending(messageID),
                                  url,
                                })),
                              ),
                            )
                          : undefined,
                      }
                    : source.state.status === "pending" || source.state.status === "running"
                      ? {
                          status: "error" as const,
                          input: source.state.input,
                          error: interrupted,
                          time: {
                            start:
                              source.state.status === "running" ? source.state.time.start : number(row, "time_created"),
                            end: number(row, "time_updated"),
                          },
                        }
                      : source.state,
              }
            : base
    const encoded = encodeLegacyPart(target)
    const { id: omittedID, sessionID: omittedSessionID, messageID: omittedMessageID, ...data } = encoded
    void omittedID
    void omittedSessionID
    void omittedMessageID
    return JSON.stringify(data)
  })
}

function currentMessageData(row: Row, sessionID: string, id: string, copy: CopyState) {
  return Effect.gen(function* () {
    const source = decodeCurrentMessage({
      ...parseRecord(text(row, "data")),
      id: text(row, "id"),
      type: text(row, "type"),
    })
    const messageID = SessionMessage.ID.make(id)
    const incompleteAssistant =
      source.type === "assistant" &&
      (!source.time.completed ||
        source.content.some(
          (item) => item.type === "tool" && (item.state.status === "pending" || item.state.status === "running"),
        ))
    const target =
      source.type === "user"
        ? {
            ...source,
            id: messageID,
            files: source.files
              ? yield* Effect.forEach(source.files, (file) =>
                  copyReference(file.uri, "attachment", copy).pipe(Effect.map((uri) => ({ ...file, uri }))),
                )
              : undefined,
          }
        : source.type === "synthetic"
          ? { ...source, id: messageID, sessionID: SessionSchema.ID.make(sessionID) }
          : source.type === "assistant"
            ? {
                ...source,
                id: messageID,
                content: yield* Effect.forEach(
                  source.content,
                  (item): Effect.Effect<SessionMessage.AssistantContent, ImportError> => {
                    if (item.type !== "tool") return Effect.succeed(item)
                    if (item.state.status === "pending" || item.state.status === "running") {
                      return Effect.succeed({
                        ...item,
                        state: {
                          status: "error" as const,
                          input: typeof item.state.input === "string" ? { raw: item.state.input } : item.state.input,
                          content: item.state.status === "running" ? item.state.content : [],
                          structured: item.state.status === "running" ? item.state.structured : {},
                          error: { type: "unknown" as const, message: interrupted },
                        },
                        time: {
                          ...item.time,
                          completed: item.time.completed ?? DateTime.makeUnsafe(number(row, "time_updated")),
                        },
                      })
                    }
                    if (item.state.status !== "completed") return Effect.succeed(item)
                    const state = item.state
                    return Effect.gen(function* () {
                      return {
                        ...item,
                        state: {
                          ...state,
                          outputPaths: state.outputPaths
                            ? yield* Effect.forEach(state.outputPaths, (output) =>
                                copyReference(output, "output", copy),
                              )
                            : undefined,
                          attachments: state.attachments
                            ? yield* Effect.forEach(state.attachments, (attachment) =>
                                copyReference(attachment.uri, "attachment", copy).pipe(
                                  Effect.map((uri) => ({ ...attachment, uri })),
                                ),
                              )
                            : undefined,
                        },
                      }
                    })
                  },
                ),
                time: incompleteAssistant
                  ? {
                      ...source.time,
                      completed: source.time.completed ?? DateTime.makeUnsafe(number(row, "time_updated")),
                    }
                  : source.time,
                error: incompleteAssistant
                  ? (source.error ?? { type: "unknown" as const, message: interrupted })
                  : source.error,
              }
            : { ...source, id: messageID }
    const encoded = encodeCurrentMessage(target)
    const { id: omittedID, type: omittedType, ...data } = encoded
    void omittedID
    void omittedType
    return JSON.stringify(data)
  })
}

function promptData(data: string, copy: CopyState) {
  return Effect.gen(function* () {
    const prompt = decodePrompt(JSON.parse(data))
    return JSON.stringify(
      encodePrompt({
        ...prompt,
        files: prompt.files
          ? yield* Effect.forEach(prompt.files, (file) =>
              copyReference(file.uri, "attachment", copy).pipe(Effect.map((uri) => ({ ...file, uri }))),
            )
          : undefined,
      }),
    )
  })
}

function sessionRevertData(
  value: string | null,
  messages: ReadonlyArray<Entity>,
  current: ReadonlyArray<Entity>,
  parts: ReadonlyArray<Entity>,
) {
  if (value === null) return null
  const source = decodeRevert(JSON.parse(value))
  const messageID = [...current, ...messages].find((item) => item.sourceID === source.messageID)?.targetID
  const partID = source.partID ? parts.find((item) => item.sourceID === source.partID)?.targetID : undefined
  if (!messageID || (source.partID && !partID))
    throw new Error("Session revert references an entity outside its closure")
  return JSON.stringify(
    encodeRevert({
      ...source,
      messageID: SessionMessage.ID.make(messageID),
      partID,
    }),
  )
}

function relatedTarget(entities: ReadonlyArray<Entity>, sourceID: string, relation: string) {
  const target = entities.find((item) => item.sourceID === sourceID)?.targetID
  if (!target) throw new Error(`Missing ${relation} mapping for ${sourceID}`)
  return target
}

function copyReference(reference: string, kind: "attachment" | "output", state: CopyState) {
  return Effect.gen(function* () {
    const roots =
      kind === "output"
        ? [yield* existingDirectory(path.join(state.sourceData, "tool-output"))].filter(
            (root): root is string => root !== undefined,
          )
        : state.attachmentRoots
    const inspected = yield* Effect.tryPromise({
      try: () =>
        ProductMigrationFile.inspectReference({
          reference,
          roots,
          maxBytes: ProductMigrationFile.referencedFileMaxBytes,
        }),
      catch: (cause) => new ImportError({ operation: "inspect referenced file", sourceID: reference, cause }),
    })
    if (inspected.status === "ignored") return reference
    if (inspected.status === "invalid") {
      return yield* new ImportError({
        operation: "decode file reference",
        sourceID: reference,
        cause: new Error("File reference URL is invalid"),
      })
    }
    if (inspected.status === "missing") {
      state.missingFiles.push(inspected.path)
      return missingReference(inspected.path)
    }
    if (inspected.status === "rejected") {
      state.rejectedFiles.push(inspected.path)
      return missingReference(inspected.path)
    }
    const temporary = path.join(state.targetData, `.product-migration-${randomUUID()}`)
    const copied = yield* Effect.tryPromise({
      try: () =>
        ProductMigrationFile.copyContainedFile({
          source: inspected.canonical,
          sourceRoot: inspected.root,
          target: temporary,
          targetRoot: state.targetData,
          maxBytes: ProductMigrationFile.referencedFileMaxBytes,
          remainingBytes:
            ProductMigrationFile.referencedSessionMaxBytes -
            [...state.copiedFiles.values()].reduce((total, file) => total + file.size, 0),
        }),
      catch: (cause) => new ImportError({ operation: "copy referenced file", sourceID: inspected.path, cause }),
    })
    state.createdFiles.push(temporary)
    const requestedTarget = path.join(
      state.targetData,
      "product-migration",
      state.targetSessionID,
      `${copied.sha256.slice(0, 16)}-${path.basename(copied.canonical)}`,
    )
    const target = yield* plannedDestination(requestedTarget, state.targetData)
    yield* state.fs
      .ensureDir(path.dirname(target))
      .pipe(
        Effect.mapError(
          (cause) => new ImportError({ operation: "prepare copied file", sourceID: inspected.path, cause }),
        ),
      )
    if (yield* state.fs.existsSafe(target)) {
      const existing = yield* Effect.tryPromise({
        try: () =>
          ProductMigrationFile.hashContainedFile({
            file: target,
            root: state.targetData,
            maxBytes: ProductMigrationFile.referencedFileMaxBytes,
          }),
        catch: (cause) => new ImportError({ operation: "validate copied file", sourceID: target, cause }),
      })
      if (existing.sha256 !== copied.sha256 || existing.size !== copied.size) {
        return yield* new ImportError({
          operation: "validate copied file",
          sourceID: target,
          cause: new Error("Existing destination content does not match source"),
        })
      }
      yield* state.fs
        .remove(temporary, { force: true })
        .pipe(
          Effect.mapError(
            (cause) => new ImportError({ operation: "remove copied file staging", sourceID: inspected.path, cause }),
          ),
        )
      state.copiedFiles.set(path.relative(state.targetData, target).replaceAll("\\", "/"), {
        sha256: copied.sha256,
        size: copied.size,
      })
      return reference.startsWith("file:") ? pathToFileURL(target).href : target
    }
    yield* state.fs
      .rename(temporary, target)
      .pipe(
        Effect.mapError(
          (cause) => new ImportError({ operation: "commit copied file", sourceID: inspected.path, cause }),
        ),
      )
    state.createdFiles.push(target)
    state.copiedFiles.set(path.relative(state.targetData, target).replaceAll("\\", "/"), {
      sha256: copied.sha256,
      size: copied.size,
    })
    return reference.startsWith("file:") ? pathToFileURL(target).href : target
  })
}

function plannedDestination(file: string, targetData: string) {
  return Effect.tryPromise({
    try: async () => {
      const existing = await nearestExistingAncestor(path.dirname(file))
      const canonical = await realpath(existing.ancestor)
      const parent = path.join(canonical, ...existing.suffix)
      if (!inside(targetData, parent)) throw new Error("Planned destination escaped the target data root")
      return path.join(parent, path.basename(file))
    },
    catch: (cause) => new ImportError({ operation: "plan copied file", sourceID: file, cause }),
  })
}

async function nearestExistingAncestor(
  directory: string,
): Promise<{ readonly ancestor: string; readonly suffix: ReadonlyArray<string> }> {
  const exists = await lstat(directory).then(
    () => true,
    (cause) => {
      if (hasCode(cause, "ENOENT")) return false
      throw cause
    },
  )
  if (exists) return { ancestor: directory, suffix: [] }
  const parent = path.dirname(directory)
  if (parent === directory) throw new Error(`No existing ancestor for ${directory}`)
  const existing = await nearestExistingAncestor(parent)
  return { ancestor: existing.ancestor, suffix: [...existing.suffix, path.basename(directory)] }
}

function hasCode(value: unknown, code: string): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value && value.code === code
}

function active(closure: Closure) {
  if (nullableNumber(closure.session, "time_compacting") !== null) return true
  if (closure.inputs.some((row) => nullableNumber(row, "promoted_seq") === null)) return true
  if (
    closure.messages.some((row) => {
      const message = decodeLegacyMessage({
        ...parseRecord(text(row, "data")),
        id: text(row, "id"),
        sessionID: text(row, "session_id"),
      })
      return message.role === "assistant" && message.time.completed === undefined
    })
  )
    return true
  if (
    closure.parts.some((row) => {
      const part = decodeLegacyPart({
        ...parseRecord(text(row, "data")),
        id: text(row, "id"),
        sessionID: text(row, "session_id"),
        messageID: text(row, "message_id"),
      })
      return part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
    })
  )
    return true
  return closure.sessionMessages.some((row) => {
    const message = decodeCurrentMessage({
      ...parseRecord(text(row, "data")),
      id: text(row, "id"),
      type: text(row, "type"),
    })
    return (
      message.type === "assistant" &&
      (!message.time.completed ||
        message.content.some(
          (item) => item.type === "tool" && (item.state.status === "pending" || item.state.status === "running"),
        ))
    )
  })
}

function sessionMetadata(
  source: string | null,
  migrationID: string,
  sourceID: string,
  status: ImportedSession["status"],
  checkpoint: ImportedSession["checkpoint"],
  detached: boolean,
  missingParent: boolean,
  missingWorkspace: boolean,
  neutralizedInputIDs: ReadonlyArray<string>,
  closure: Closure,
  copiedFiles: ReadonlyArray<{ readonly file: string; readonly sha256: string; readonly size: number }>,
) {
  const decoded = source === null ? {} : JSON.parse(source)
  const metadata = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {}
  return JSON.stringify({
    ...metadata,
    productMigration: {
      migrationID,
      sourceID,
      status,
      checkpoint,
      detached,
      missingParent,
      missingWorkspace,
      neutralizedInputIDs,
      closure: {
        legacyMessages: closure.messages.length,
        parts: closure.parts.length,
        currentMessages: closure.sessionMessages.length,
        inputs: closure.inputs.length,
        todos: closure.todos.length,
        projectID: text(closure.project, "id"),
        projectDirectoryCount: closure.projectDirectories.length,
        projectDirectories: closure.projectDirectories.map((row) => text(row, "directory")).toSorted(),
        workspaceID: closure.workspace ? text(closure.workspace, "id") : null,
        permissionCount: closure.permissions.length,
        permissionIDs: closure.permissions.map((row) => text(row, "id")).toSorted(),
      },
      copiedFileCount: copiedFiles.length,
      copiedFileBytes: copiedFiles.reduce((total, item) => total + item.size, 0),
      copiedFiles: copiedFiles.map((item) => ({ path: item.file, sha256: item.sha256, size: item.size })),
      replay: false,
    },
  })
}

function sameImport(metadata: string | null, migrationID: string, sourceID: string) {
  if (!metadata) return false
  const decoded: unknown = JSON.parse(metadata)
  if (!decoded || typeof decoded !== "object" || !("productMigration" in decoded)) return false
  const marker = decoded.productMigration
  return (
    marker !== null &&
    typeof marker === "object" &&
    "migrationID" in marker &&
    marker.migrationID === migrationID &&
    "sourceID" in marker &&
    marker.sourceID === sourceID
  )
}

function parseRecord(value: string) {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object")
  return parsed
}

function canonicalDirectory(fs: FSUtil.Interface, directory: string, operation: string) {
  return fs.realPath(directory).pipe(
    Effect.flatMap((canonical) =>
      fs
        .isDir(canonical)
        .pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.succeed(canonical)
              : Effect.fail(new ImportError({ operation, cause: new Error("Path is not a directory") })),
          ),
        ),
    ),
    Effect.mapError((cause) => (cause instanceof ImportError ? cause : new ImportError({ operation, cause }))),
  )
}

function canonicalFile(fs: FSUtil.Interface, file: string, operation: string) {
  return fs.realPath(file).pipe(
    Effect.flatMap((canonical) =>
      fs
        .isFile(canonical)
        .pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.succeed(canonical)
              : Effect.fail(new ImportError({ operation, cause: new Error("Path is not a file") })),
          ),
        ),
    ),
    Effect.mapError((cause) => (cause instanceof ImportError ? cause : new ImportError({ operation, cause }))),
  )
}

function existingDirectory(directory: string) {
  return Effect.tryPromise({
    try: () => ProductMigrationFile.resolveDirectory(directory),
    catch: (cause) => new ImportError({ operation: "resolve referenced directory", sourceID: directory, cause }),
  })
}

function overlaps(left: string, right: string) {
  return inside(left, right) || inside(right, left)
}

function inside(root: string, candidate: string) {
  const relation = path.relative(root, candidate)
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
}

function missingReference(source: string) {
  return `missing://product-migration/${encodeURIComponent(path.basename(source))}`
}

function text(row: Row, key: string) {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`Expected text column ${key}`)
  return value
}

function nullableText(row: Row, key: string) {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(`Expected nullable text column ${key}`)
  return value
}

function number(row: Row, key: string) {
  const value = row[key]
  if (typeof value !== "number") throw new Error(`Expected numeric column ${key}`)
  return value
}

function nullableNumber(row: Row, key: string) {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "number") throw new Error(`Expected nullable numeric column ${key}`)
  return value
}

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, FSUtil.node] })
