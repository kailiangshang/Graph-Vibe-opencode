import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Product } from "@opencode-ai/core/product"
import { ProductMigrationState } from "@opencode-ai/core/product-migration/state"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(PtyTicket.node))
const itExpiring = testEffect(
  Layer.effect(PtyTicket.Service, PtyTicket.make(5)).pipe(
    Layer.provide(LayerNode.compile(ProductMigrationState.node)),
  ),
)
const graphVibe = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ProductMigrationState.node, PtyTicket.node]),
    [[Product.node, Product.layerWith(Product.GraphVibe)]],
  ),
)

describe("PTY websocket tickets", () => {
  graphVibe.effect("blocks ticket cache mutation until migration completion", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const scope = { ptyID: PtyID.ascending(), directory: "/tmp/a" }
      const failures = yield* Effect.all([
        tickets.issue(scope).pipe(Effect.exit),
        tickets.consume({ ...scope, ticket: "blocked" }).pipe(Effect.exit),
      ])

      expect(
        failures.every(
          (exit: Exit.Exit<unknown, unknown>) =>
            Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ProductMigration.Required,
        ),
      ).toBe(true)

      yield* (yield* ProductMigrationState.Service).freshStart({ expectedRevision: 0 })
      const issued = yield* tickets.issue(scope)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )

  it.live("consumes tickets once", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const scope = { ptyID: PtyID.ascending(), directory: "/tmp/a" }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different request", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const issued = yield* tickets.issue({ ptyID, directory: "/tmp/a" })

      expect(yield* tickets.consume({ ptyID, directory: "/tmp/b", ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ptyID, directory: "/tmp/a", ticket: issued.ticket })).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const issued = yield* tickets.issue({ ptyID })

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(yield* tickets.consume({ ptyID, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different workspace", () =>
    Effect.gen(function* () {
      const tickets = yield* PtyTicket.Service
      const ptyID = PtyID.ascending()
      const workspaceID = WorkspaceV2.ID.ascending()
      const issued = yield* tickets.issue({ ptyID, workspaceID })

      expect(yield* tickets.consume({ ptyID, workspaceID: WorkspaceV2.ID.ascending(), ticket: issued.ticket })).toBe(
        false,
      )
      expect(yield* tickets.consume({ ptyID, workspaceID, ticket: issued.ticket })).toBe(true)
    }),
  )
})
