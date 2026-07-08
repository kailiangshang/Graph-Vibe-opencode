export * as GraphArtifactDraft from "./artifact-draft"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { LayerNode } from "../../effect/layer-node"
import { SessionSchema } from "../../session/schema"
import { SessionTable } from "../../session/sql"
import { GraphNodeTable } from "../sql"
import { GraphArtifact } from "./artifact"
import { GraphArtifactDraftTable } from "./artifact-draft.sql"
import type { ProjectV2 } from "../../project"
import type { NodeID } from "../storage"
import type { DraftStatus, StoredDraftChunk, StoredDraftFile } from "./artifact-draft.sql"

export type DraftID = string & { readonly "GraphArtifactDraft.ID": unique symbol }
export const DraftID = {
  create: () => `gad_${crypto.randomUUID()}` as DraftID,
  make: (id: string) => id as DraftID,
}

export type Status = DraftStatus
export type DraftChunk = StoredDraftChunk
export type DraftFile = StoredDraftFile

export interface DraftFileCreate {
  readonly path: string
  readonly expectedChunks?: number
  readonly expectedSha256?: string
}

export interface CreateInput {
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly nodeID: NodeID
  readonly test: string
  readonly files: ReadonlyArray<DraftFileCreate>
}

export interface DraftFilter {
  readonly projectID: ProjectV2.ID
  readonly sessionID?: string
  readonly nodeID?: NodeID
  readonly status?: Status
}

export interface PutChunkInput {
  readonly id: DraftID
  readonly path: string
  readonly index: number
  readonly content: string
}

export interface Draft {
  readonly id: DraftID
  readonly projectID: ProjectV2.ID
  readonly sessionID: string
  readonly nodeID: NodeID
  readonly status: Status
  readonly test: string
  readonly files: ReadonlyArray<DraftFile>
  readonly artifact?: GraphArtifact.FilesArtifact
  readonly timeCreated: number
  readonly timeUpdated: number
}

export type SealedDraft = Draft & {
  readonly status: "sealed"
  readonly artifact: GraphArtifact.FilesArtifact
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("GraphArtifactDraft.NotFoundError", {
  id: Schema.String,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("GraphArtifactDraft.ValidationError", {
  rule: Schema.String,
  message: Schema.String,
  path: Schema.String.pipe(Schema.optional),
  index: Schema.Number.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<DraftID, ValidationError>
  readonly get: (id: DraftID) => Effect.Effect<Draft, NotFoundError>
  readonly list: (filter: DraftFilter) => Effect.Effect<ReadonlyArray<Draft>>
  readonly putChunk: (input: PutChunkInput) => Effect.Effect<Draft, NotFoundError | ValidationError>
  readonly seal: (id: DraftID) => Effect.Effect<SealedDraft, NotFoundError | ValidationError>
  readonly markApplied: (id: DraftID) => Effect.Effect<Draft, NotFoundError | ValidationError>
  readonly cancel: (id: DraftID) => Effect.Effect<Draft, NotFoundError | ValidationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphArtifactDraft") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("GraphArtifactDraft.get")(function* (id: DraftID) {
      const row = yield* db
        .select()
        .from(GraphArtifactDraftTable)
        .where(eq(GraphArtifactDraftTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ id })
      return draftFromRow(row)
    })

    const create = Effect.fn("GraphArtifactDraft.create")(function* (input: CreateInput) {
      const validation = validateCreate(input)
      if (validation) return yield* validation
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const session = yield* tx
                .select({ projectID: SessionTable.project_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(input.sessionID)))
                .get()
                .pipe(Effect.orDie)
              if (!session) {
                return yield* new ValidationError({
                  rule: "draft.unknown_session",
                  message: `artifact draft session ${input.sessionID} does not exist`,
                })
              }
              if (session.projectID !== input.projectID) {
                return yield* new ValidationError({
                  rule: "draft.session_project_mismatch",
                  message: `artifact draft session ${input.sessionID} does not belong to project ${input.projectID}`,
                })
              }

              const node = yield* tx
                .select({ projectID: GraphNodeTable.project_id, sessionID: GraphNodeTable.session_id })
                .from(GraphNodeTable)
                .where(eq(GraphNodeTable.id, input.nodeID))
                .get()
                .pipe(Effect.orDie)
              if (!node) {
                return yield* new ValidationError({
                  rule: "draft.unknown_node",
                  message: `artifact draft node ${input.nodeID} does not exist`,
                })
              }
              if (node.projectID !== input.projectID) {
                return yield* new ValidationError({
                  rule: "draft.node_project_mismatch",
                  message: `artifact draft node ${input.nodeID} does not belong to project ${input.projectID}`,
                })
              }
              if (node.sessionID !== input.sessionID) {
                return yield* new ValidationError({
                  rule: "draft.node_session_mismatch",
                  message: `artifact draft node ${input.nodeID} does not belong to session ${input.sessionID}`,
                })
              }

              const id = DraftID.create()
              yield* tx
                .insert(GraphArtifactDraftTable)
                .values({
                  id,
                  project_id: input.projectID,
                  session_id: input.sessionID,
                  node_id: input.nodeID,
                  status: "open",
                  test: input.test,
                  files: input.files.map(createFile),
                })
                .run()
                .pipe(Effect.orDie)
              return id
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const list = Effect.fn("GraphArtifactDraft.list")(function* (filter: DraftFilter) {
      const conds = [eq(GraphArtifactDraftTable.project_id, filter.projectID)]
      if (filter.sessionID !== undefined) conds.push(eq(GraphArtifactDraftTable.session_id, filter.sessionID))
      if (filter.nodeID !== undefined) conds.push(eq(GraphArtifactDraftTable.node_id, filter.nodeID))
      if (filter.status !== undefined) conds.push(eq(GraphArtifactDraftTable.status, filter.status))
      const rows = yield* db
        .select()
        .from(GraphArtifactDraftTable)
        .where(and(...conds))
        .orderBy(asc(GraphArtifactDraftTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return rows.map(draftFromRow)
    })

    const putChunk = Effect.fn("GraphArtifactDraft.putChunk")(function* (input: PutChunkInput) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(GraphArtifactDraftTable)
                .where(eq(GraphArtifactDraftTable.id, input.id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ id: input.id })
              const draft = draftFromRow(row)
              const validation = validatePutChunk(draft, input)
              if (validation) return yield* validation
              const updated = yield* tx
                .update(GraphArtifactDraftTable)
                .set({
                  files: draft.files.map((file) =>
                    file.path === input.path
                      ? {
                          ...file,
                          chunks: [
                            ...file.chunks.filter((chunk) => chunk.index !== input.index),
                            { index: input.index, content: input.content },
                          ].sort((a, b) => a.index - b.index),
                        }
                      : file,
                  ),
                })
                .where(eq(GraphArtifactDraftTable.id, input.id))
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ id: input.id })
              return draftFromRow(updated)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const seal = Effect.fn("GraphArtifactDraft.seal")(function* (id: DraftID) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(GraphArtifactDraftTable)
                .where(eq(GraphArtifactDraftTable.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ id })
              const draft = draftFromRow(row)
              const openValidation = validateStatus(draft, "open", "seal.open_draft_required")
              if (openValidation) return yield* openValidation
              const artifact = validateSeal(draft)
              if (artifact instanceof ValidationError) return yield* artifact
              const updated = yield* tx
                .update(GraphArtifactDraftTable)
                .set({ status: "sealed" })
                .where(eq(GraphArtifactDraftTable.id, id))
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ id })
              return { ...draftFromRow(updated), status: "sealed" as const, artifact }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const markApplied = Effect.fn("GraphArtifactDraft.markApplied")(function* (id: DraftID) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(GraphArtifactDraftTable)
                .where(eq(GraphArtifactDraftTable.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ id })
              const draft = draftFromRow(row)
              const validation = validateStatus(draft, "sealed", "mark_applied.sealed_draft_required")
              if (validation) return yield* validation
              const updated = yield* tx
                .update(GraphArtifactDraftTable)
                .set({ status: "applied" })
                .where(eq(GraphArtifactDraftTable.id, id))
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ id })
              return draftFromRow(updated)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const cancel = Effect.fn("GraphArtifactDraft.cancel")(function* (id: DraftID) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(GraphArtifactDraftTable)
                .where(eq(GraphArtifactDraftTable.id, id))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ id })
              const draft = draftFromRow(row)
              const validation = validateStatus(draft, "open", "cancel.open_draft_required")
              if (validation) return yield* validation
              const updated = yield* tx
                .update(GraphArtifactDraftTable)
                .set({ status: "cancelled" })
                .where(eq(GraphArtifactDraftTable.id, id))
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ id })
              return draftFromRow(updated)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    return Service.of({ create, get, list, putChunk, seal, markApplied, cancel })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.layerFromPath(Database.path())))

function draftFromRow(row: typeof GraphArtifactDraftTable.$inferSelect): Draft {
  const files = row.files.map(normalizeFile)
  const base = {
    id: DraftID.make(row.id),
    projectID: row.project_id,
    sessionID: row.session_id,
    nodeID: row.node_id,
    status: row.status,
    test: row.test,
    files,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
  if (row.status !== "sealed" && row.status !== "applied") return base
  return { ...base, artifact: assembleArtifact(row.test, files) }
}

function createFile(file: DraftFileCreate): DraftFile {
  return {
    path: file.path,
    ...(file.expectedChunks === undefined ? {} : { expectedChunks: file.expectedChunks }),
    ...(file.expectedSha256 === undefined ? {} : { expectedSha256: file.expectedSha256 }),
    chunks: [],
  }
}

function normalizeFile(file: DraftFile): DraftFile {
  return {
    path: file.path,
    ...(file.expectedChunks === undefined ? {} : { expectedChunks: file.expectedChunks }),
    ...(file.expectedSha256 === undefined ? {} : { expectedSha256: file.expectedSha256 }),
    chunks: [...file.chunks].sort((a, b) => a.index - b.index),
  }
}

function validateCreate(input: CreateInput) {
  if (input.test.length === 0) {
    return new ValidationError({ rule: "draft.empty_test", message: "artifact draft test is required" })
  }
  if (input.files.length === 0) {
    return new ValidationError({ rule: "draft.empty_files", message: "artifact draft needs at least one file" })
  }
  const emptyPath = input.files.find((file) => file.path.length === 0)
  if (emptyPath) return new ValidationError({ rule: "file.empty_path", message: "artifact draft file path is required" })
  const invalidExpectedChunks = input.files.find(
    (file) => file.expectedChunks !== undefined && (!Number.isInteger(file.expectedChunks) || file.expectedChunks < 1),
  )
  if (invalidExpectedChunks) {
    return new ValidationError({
      rule: "file.invalid_expected_chunks",
      message: `expectedChunks must be a positive integer for ${invalidExpectedChunks.path}`,
      path: invalidExpectedChunks.path,
    })
  }
  const duplicate = input.files.find(
    (file, index) => input.files.findIndex((candidate) => candidate.path === file.path) !== index,
  )
  if (duplicate) {
    return new ValidationError({
      rule: "file.duplicate_path",
      message: `artifact draft declares ${duplicate.path} more than once`,
      path: duplicate.path,
    })
  }
}

function validatePutChunk(draft: Draft, input: PutChunkInput) {
  const status = validateStatus(draft, "open", "put_chunk.open_draft_required")
  if (status) return status
  if (!Number.isInteger(input.index) || input.index < 0) {
    return new ValidationError({
      rule: "chunk.invalid_index",
      message: "chunk index must be a non-negative integer",
      index: input.index,
    })
  }
  if (!draft.files.some((file) => file.path === input.path)) {
    return new ValidationError({
      rule: "chunk.unknown_file",
      message: `artifact draft does not declare ${input.path}`,
      path: input.path,
    })
  }
}

function validateStatus(draft: Draft, expected: Status, rule: string) {
  if (draft.status === expected) return undefined
  return new ValidationError({ rule, message: `artifact draft ${draft.id} is ${draft.status}` })
}

function validateSeal(draft: Draft) {
  const missing = draft.files.flatMap((file) => {
    if (file.expectedChunks === undefined) return []
    const indexes = new Set(file.chunks.map((chunk) => chunk.index))
    return Array.from({ length: file.expectedChunks }, (_, index) => index)
      .filter((index) => !indexes.has(index))
      .map((index) => ({ path: file.path, index }))
  })[0]
  if (missing) {
    return new ValidationError({
      rule: "seal.missing_chunk",
      message: `artifact draft is missing chunk ${missing.index} for ${missing.path}`,
      path: missing.path,
      index: missing.index,
    })
  }
  const unexpected = draft.files.flatMap((file) => {
    if (file.expectedChunks === undefined) return []
    const expectedChunks = file.expectedChunks
    return file.chunks
      .filter((chunk) => chunk.index >= expectedChunks)
      .map((chunk) => ({ path: file.path, index: chunk.index }))
  })[0]
  if (unexpected) {
    return new ValidationError({
      rule: "seal.unexpected_chunk",
      message: `artifact draft has unexpected chunk ${unexpected.index} for ${unexpected.path}`,
      path: unexpected.path,
      index: unexpected.index,
    })
  }
  const mismatch = draft.files.find(
    (file) => file.expectedSha256 !== undefined && GraphArtifact.hashContent(assembleFile(file)) !== file.expectedSha256,
  )
  if (mismatch) {
    return new ValidationError({
      rule: "seal.sha_mismatch",
      message: `artifact draft content hash mismatch for ${mismatch.path}`,
      path: mismatch.path,
    })
  }
  const artifact = assembleArtifact(draft.test, draft.files)
  const issue = GraphArtifact.validateArtifact(artifact)[0]
  if (issue) return new ValidationError({ rule: `artifact.${issue.code}`, message: issue.message, path: issue.path })
  return artifact
}

function assembleArtifact(test: string, files: ReadonlyArray<DraftFile>): GraphArtifact.FilesArtifact {
  return { mode: "files", test, files: files.map((file) => ({ path: file.path, code: assembleFile(file) })) }
}

function assembleFile(file: DraftFile) {
  return [...file.chunks]
    .sort((a, b) => a.index - b.index)
    .map((chunk) => chunk.content)
    .join("")
}
