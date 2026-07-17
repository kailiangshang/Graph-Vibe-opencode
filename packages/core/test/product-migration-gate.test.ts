import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Location } from "@opencode-ai/core/location"
import { Product } from "@opencode-ai/core/product"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

function testLayer(profile: Product.Profile, execution: Layer.Layer<SessionExecution.Service>) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ProductMigrationState.node,
      MoveSession.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [Product.node, Product.layerWith(profile)],
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
    ],
  )
}

const wakeCount = Ref.makeUnsafe(0)
const resumeCount = Ref.makeUnsafe(0)
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    wake: () => Ref.update(wakeCount, (count) => count + 1),
    resume: () => Ref.update(resumeCount, (count) => count + 1),
    interrupt: () => Effect.void,
  }),
)
const it = testEffect(testLayer(Product.GraphVibe, execution))
const openCode = testEffect(testLayer(Product.OpenCode, SessionExecution.noopLayer))
const localExecution = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, ProductMigrationState.node, SessionExecutionLocal.node]), [
    [Product.node, Product.layerWith(Product.GraphVibe)],
    [LocationServiceMap.node, buildLocationServiceMap()],
  ]),
)

describe("Graph Vibe product migration gate", () => {
  it.effect("blocks session creation until fresh start finalizes migration", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const migration = yield* ProductMigrationState.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

      expect(yield* session.create({ location }).pipe(Effect.flip)).toMatchObject({
        _tag: "ProductMigrationRequired",
      })

      yield* migration.freshStart({ expectedRevision: 0 })
      expect(yield* session.create({ location })).toMatchObject({ location })
    }),
  )

  it.effect("blocks prompt admission, wake, and resume for an existing session until completion", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const migration = yield* ProductMigrationState.Service
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_existing_migration_gate")
      yield* seedSession(sessionID)

      expect(
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "blocked" }) }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProductMigrationRequired" })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toMatchObject({
        _tag: "ProductMigrationRequired",
      })
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* Ref.get(wakeCount)).toBe(0)
      expect(yield* Ref.get(resumeCount)).toBe(0)

      yield* migration.freshStart({ expectedRevision: 0 })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "admitted" }) })
      yield* session.resume(sessionID)

      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* Ref.get(wakeCount)).toBe(1)
      expect(yield* Ref.get(resumeCount)).toBe(1)
    }),
  )

  it.effect("blocks model, agent, and revert writes before completion", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_existing_write_gate")
      yield* seedSession(sessionID)

      const failures = yield* Effect.all([
        session.switchAgent({ sessionID, agent: "build" }).pipe(Effect.exit),
        session
          .switchModel({
            sessionID,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }),
          })
          .pipe(Effect.exit),
        session.revert
          .stage({ sessionID, messageID: SessionMessage.ID.make("msg_missing"), files: false })
          .pipe(Effect.exit),
        session.revert.clear(sessionID).pipe(Effect.exit),
        session.revert.commit(sessionID).pipe(Effect.exit),
      ])

      const isRequired = (failure: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(failure) && Cause.squash(failure.cause) instanceof ProductMigration.Required
      expect(failures.every(isRequired)).toBe(true)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("blocks moving a session before filesystem or event side effects", () =>
    Effect.gen(function* () {
      const move = yield* MoveSession.Service
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_existing_move_gate")
      yield* seedSession(sessionID)

      const exit = yield* move
        .moveSession({
          sessionID,
          destination: { directory: AbsolutePath.make("/destination") },
          moveChanges: false,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ProductMigration.Required).toBe(true)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  openCode.effect("does not gate OpenCode session creation", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

      expect(yield* session.create({ location })).toMatchObject({ location })
    }),
  )

  localExecution.effect("blocks direct process-local wake and resume before completion", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      const sessionID = SessionSchema.ID.make("ses_direct_execution_gate")

      expect(Exit.isFailure(yield* execution.wake(sessionID).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* execution.resume(sessionID).pipe(Effect.exit))).toBe(true)
    }),
  )
})

function seedSession(sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: "existing",
        directory: AbsolutePath.make("/project"),
        title: "Existing session",
        version: InstallationVersion,
      })
      .run()
      .pipe(Effect.orDie)
  })
}
