import { describe, expect, test } from "bun:test"
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
const SID = SessionSchema.ID.make("ses_artifact_draft")
const SID_OTHER = SessionSchema.ID.make("ses_artifact_draft_other")
const NODE_ID = GraphStorage.NodeID.make("node_artifact_draft")
const WORKTREE = AbsolutePath.make("/tmp/graph-artifact-draft")

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const draftLayer = GraphArtifactDraft.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphArtifactDraft.Service
>

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: PID, worktree: WORKTREE, vcs: "git", sandboxes: [], time_created: 0, time_updated: 0 })
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
  const storage = yield* GraphStorage.Service
  yield* storage.node.create({
    id: NODE_ID,
    projectID: PID,
    sessionID: SID,
    type: "atomic",
    name: "BuildMe",
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
