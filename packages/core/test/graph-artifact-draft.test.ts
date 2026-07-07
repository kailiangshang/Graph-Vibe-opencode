import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { hashContent } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"

const PID = ProjectV2.ID.make("proj_artifact_draft")
const PID_OTHER = ProjectV2.ID.make("proj_artifact_draft_other")
const SID = SessionSchema.ID.make("ses_artifact_draft")
const SID_OTHER = SessionSchema.ID.make("ses_artifact_draft_other")
const SID_FOREIGN = SessionSchema.ID.make("ses_artifact_draft_foreign")
const NODE_ID = GraphStorage.NodeID.make("node_artifact_draft")
const NODE_ID_FOREIGN = GraphStorage.NodeID.make("node_artifact_draft_foreign")
const WORKTREE = AbsolutePath.make("/tmp/graph-artifact-draft")

const makeDraftLayer = (filename: string) => {
  const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(filename))) as Layer.Layer<
    Database.Service | GraphStorage.Service
  >
  return GraphArtifactDraft.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
    Database.Service | GraphStorage.Service | GraphArtifactDraft.Service
  >
}

const draftLayer = makeDraftLayer(":memory:")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: PID, worktree: WORKTREE, vcs: "git", sandboxes: [], time_created: 0, time_updated: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectTable)
    .values({ id: PID_OTHER, worktree: WORKTREE, vcs: "git", sandboxes: [], time_created: 0, time_updated: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SID,
      project_id: PID,
      slug: "draft",
      directory: WORKTREE,
      title: "draft",
      version: "0",
      time_created: 0,
      time_updated: 0,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SID_OTHER,
      project_id: PID,
      slug: "draft-other",
      directory: WORKTREE,
      title: "draft other",
      version: "0",
      time_created: 0,
      time_updated: 0,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: SID_FOREIGN,
      project_id: PID_OTHER,
      slug: "draft-foreign",
      directory: WORKTREE,
      title: "draft foreign",
      version: "0",
      time_created: 0,
      time_updated: 0,
    })
    .run()
    .pipe(Effect.orDie)
  const storage = yield* GraphStorage.Service
  yield* storage.node.create({
    id: NODE_ID,
    projectID: PID,
    sessionID: SID,
    type: "atomic",
    name: "BuildMe",
    level: "L2",
  })
  yield* storage.node.create({
    id: NODE_ID_FOREIGN,
    projectID: PID_OTHER,
    sessionID: SID_FOREIGN,
    type: "atomic",
    name: "OtherBuildMe",
    level: "L2",
  })
})

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphArtifactDraft.Service>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      return yield* effect
    }).pipe(Effect.provide(draftLayer), Effect.scoped),
  )

const runIn = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphArtifactDraft.Service>,
) => Effect.runPromise(effect.pipe(Effect.provide(makeDraftLayer(filename)), Effect.scoped))

const runSeededIn = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, Database.Service | GraphStorage.Service | GraphArtifactDraft.Service>,
) =>
  runIn(
    filename,
    Effect.gen(function* () {
      yield* seed
      return yield* effect
    }),
  )

async function withTempDraftDatabase<A>(body: (filename: string) => Promise<A>) {
  const directory = await mkdtemp(join(tmpdir(), "graph-artifact-draft-"))
  try {
    return await body(join(directory, "draft.db"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function holdDraftUpdate(filename: string, statement: string, params: ReadonlyArray<string>) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `const sqlite = await import("bun:sqlite")
const db = new sqlite.Database(process.argv[1])
db.run("PRAGMA busy_timeout = 5000")
db.run("BEGIN IMMEDIATE")
db.query(process.argv[2]).run(...JSON.parse(process.argv[3]))
console.log("ready")
await Bun.sleep(200)
db.run("COMMIT")
db.close()`,
      filename,
      statement,
      JSON.stringify(params),
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  await waitForChildReady(child)
  return child
}

async function waitForChildReady(child: ReturnType<typeof Bun.spawn>) {
  if (!(child.stdout instanceof ReadableStream)) throw new Error("draft lock child stdout is not readable")
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (!output.includes("ready\n")) {
    const result = await reader.read()
    if (result.done) {
      const stderr = child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : ""
      throw new Error(`draft lock child exited before ready: ${stderr}`)
    }
    output += decoder.decode(result.value)
  }
  reader.releaseLock()
}

describe("GraphArtifactDraft", () => {
  test("create, get, and list round-trip ownership and file metadata", async () => {
    await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test src/a.test.ts",
          files: [{ path: "src/a.ts", expectedChunks: 2, expectedSha256: hashContent("ab") }],
        })

        const draft = yield* drafts.get(id)
        expect(draft.id).toBe(id)
        expect(draft.projectID).toBe(PID)
        expect(draft.sessionID).toBe(SID)
        expect(draft.nodeID).toBe(NODE_ID)
        expect(draft.status).toBe("open")
        expect(draft.test).toBe("bun test src/a.test.ts")
        expect(draft.files).toEqual([
          { path: "src/a.ts", expectedChunks: 2, expectedSha256: hashContent("ab"), chunks: [] },
        ])

        const listed = yield* drafts.list({ projectID: PID, sessionID: SID, nodeID: NODE_ID })
        expect(listed.map((item) => item.id)).toEqual([id])

        const otherSession = yield* drafts.list({ projectID: PID, sessionID: SID_OTHER })
        expect(otherSession).toEqual([])
      }),
    )
  })

  test("putChunk replaces chunks by file path and index before sealing in index order", async () => {
    await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test",
          files: [{ path: "src/a.ts", expectedChunks: 2 }],
        })

        yield* drafts.putChunk({ id, path: "src/a.ts", index: 1, content: "b" })
        yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "a" })
        const draft = yield* drafts.putChunk({ id, path: "src/a.ts", index: 1, content: "c" })

        expect(draft.files[0]?.chunks).toEqual([
          { index: 0, content: "a" },
          { index: 1, content: "c" },
        ])

        const sealed = yield* drafts.seal(id)
        expect(sealed.artifact.files).toEqual([{ path: "src/a.ts", code: "ac" }])
      }),
    )
  })

  test("seal succeeds with a files artifact containing the declared test and content", async () => {
    await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test src/a.test.ts",
          files: [{ path: "src/a.ts", expectedChunks: 2, expectedSha256: hashContent("export const a = 1\n") }],
        })

        yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "export const " })
        yield* drafts.putChunk({ id, path: "src/a.ts", index: 1, content: "a = 1\n" })
        const sealed = yield* drafts.seal(id)

        expect(sealed.status).toBe("sealed")
        expect(sealed.artifact).toEqual({
          mode: "files",
          test: "bun test src/a.test.ts",
          files: [{ path: "src/a.ts", code: "export const a = 1\n" }],
        })
        expect((yield* drafts.get(id)).status).toBe("sealed")
      }),
    )
  })

  test("seal fails when declared expected chunks are missing", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test",
          files: [{ path: "src/a.ts", expectedChunks: 2 }],
        })

        yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "a" })
        return yield* drafts.seal(id).pipe(Effect.flip)
      }),
    )

    expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
    if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
    expect(failure.rule).toBe("seal.missing_chunk")
  })

  test("seal fails when assembled content does not match expected sha", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test",
          files: [{ path: "src/a.ts", expectedSha256: hashContent("expected") }],
        })

        yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "actual" })
        return yield* drafts.seal(id).pipe(Effect.flip)
      }),
    )

    expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
    if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
    expect(failure.rule).toBe("seal.sha_mismatch")
  })

  test("create rejects a session from another project", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        return yield* drafts
          .create({
            projectID: PID,
            sessionID: SID_FOREIGN,
            nodeID: NODE_ID,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          .pipe(Effect.flip)
      }),
    )

    expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
    if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
    expect(failure.rule).toBe("draft.session_project_mismatch")
  })

  test("create rejects a node from another project", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        return yield* drafts
          .create({
            projectID: PID,
            sessionID: SID,
            nodeID: NODE_ID_FOREIGN,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          .pipe(Effect.flip)
      }),
    )

    expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
    if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
    expect(failure.rule).toBe("draft.node_project_mismatch")
  })

  test("create rejects a node from another session in the project", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        return yield* drafts
          .create({
            projectID: PID,
            sessionID: SID_OTHER,
            nodeID: NODE_ID,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          .pipe(Effect.flip)
      }),
    )

    expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
    if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
    expect(failure.rule).toBe("draft.node_session_mismatch")
  })

  test("putChunk preserves chunks committed after a stale read", async () => {
    await withTempDraftDatabase((filename) =>
      runSeededIn(
        filename,
        Effect.gen(function* () {
          const drafts = yield* GraphArtifactDraft.Service
          const id = yield* drafts.create({
            projectID: PID,
            sessionID: SID,
            nodeID: NODE_ID,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          const child = yield* Effect.promise(() =>
            holdDraftUpdate(filename, "UPDATE graph_artifact_draft SET files = ? WHERE id = ?", [
              JSON.stringify([{ path: "src/a.ts", chunks: [{ index: 0, content: "a" }] }]),
              id,
            ]),
          )
          const draft = yield* drafts.putChunk({ id, path: "src/a.ts", index: 1, content: "b" })
          expect(yield* Effect.promise(() => child.exited)).toBe(0)
          expect(draft.files[0]?.chunks).toEqual([
            { index: 0, content: "a" },
            { index: 1, content: "b" },
          ])
        }),
      ),
    )
  })

  test("putChunk rejects a draft cancelled after a stale read without mutating files", async () => {
    await withTempDraftDatabase((filename) =>
      runSeededIn(
        filename,
        Effect.gen(function* () {
          const drafts = yield* GraphArtifactDraft.Service
          const id = yield* drafts.create({
            projectID: PID,
            sessionID: SID,
            nodeID: NODE_ID,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "a" })
          const child = yield* Effect.promise(() =>
            holdDraftUpdate(filename, "UPDATE graph_artifact_draft SET status = 'cancelled' WHERE id = ?", [id]),
          )
          const failure = yield* drafts.putChunk({ id, path: "src/a.ts", index: 1, content: "b" }).pipe(Effect.flip)
          expect(yield* Effect.promise(() => child.exited)).toBe(0)
          expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
          if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
          expect(failure.rule).toBe("put_chunk.open_draft_required")
          expect((yield* drafts.get(id)).files[0]?.chunks).toEqual([{ index: 0, content: "a" }])
        }),
      ),
    )
  })

  test("markApplied transitions a sealed draft to applied", async () => {
    await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test",
          files: [{ path: "src/a.ts" }],
        })

        yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "a" })
        yield* drafts.seal(id)
        const applied = yield* drafts.markApplied(id)

        expect(applied.status).toBe("applied")
        expect((yield* drafts.get(id)).status).toBe("applied")
      }),
    )
  })

  test("markApplied rejects a draft made non-sealed after a stale read", async () => {
    await withTempDraftDatabase((filename) =>
      runSeededIn(
        filename,
        Effect.gen(function* () {
          const drafts = yield* GraphArtifactDraft.Service
          const id = yield* drafts.create({
            projectID: PID,
            sessionID: SID,
            nodeID: NODE_ID,
            test: "bun test",
            files: [{ path: "src/a.ts" }],
          })
          yield* drafts.putChunk({ id, path: "src/a.ts", index: 0, content: "a" })
          yield* drafts.seal(id)
          const child = yield* Effect.promise(() =>
            holdDraftUpdate(filename, "UPDATE graph_artifact_draft SET status = 'open' WHERE id = ?", [id]),
          )
          const failure = yield* drafts.markApplied(id).pipe(Effect.flip)
          expect(yield* Effect.promise(() => child.exited)).toBe(0)
          expect(failure).toBeInstanceOf(GraphArtifactDraft.ValidationError)
          if (!(failure instanceof GraphArtifactDraft.ValidationError)) throw failure
          expect(failure.rule).toBe("mark_applied.sealed_draft_required")
          expect((yield* drafts.get(id)).status).toBe("open")
        }),
      ),
    )
  })

  test("cancel transitions an open draft to cancelled", async () => {
    await run(
      Effect.gen(function* () {
        const drafts = yield* GraphArtifactDraft.Service
        const id = yield* drafts.create({
          projectID: PID,
          sessionID: SID,
          nodeID: NODE_ID,
          test: "bun test",
          files: [{ path: "src/a.ts" }],
        })

        const cancelled = yield* drafts.cancel(id)

        expect(cancelled.status).toBe("cancelled")
        expect((yield* drafts.get(id)).status).toBe("cancelled")
      }),
    )
  })
})
