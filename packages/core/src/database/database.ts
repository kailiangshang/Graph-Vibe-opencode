export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join, relative, sep } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { Product } from "../product"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function pathFor(input: {
  profile: Product.Profile
  data: string
  openCodeData: string
  channel: string
  database?: string
  disableChannel?: boolean
  allowOpenCodePaths?: boolean
}) {
  const database = input.database
    ? input.database === ":memory:" || isAbsolute(input.database)
      ? input.database
      : join(input.data, input.database)
    : join(
        input.data,
        ["latest", "beta", "prod"].includes(input.channel) || input.disableChannel
          ? input.profile.database
          : input.profile.database.replace(/\.db$/, `-${input.channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`),
      )
  if (input.profile !== Product.GraphVibe || input.allowOpenCodePaths || database === ":memory:") return database

  const relation = relative(input.openCodeData, database)
  if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) {
    throw new Error(`Graph Vibe refuses an OpenCode database path: ${database}`)
  }
  return database
}

export function path() {
  return pathFor({
    profile: Product.current(),
    data: Global.Path.data,
    openCodeData: Global.paths(Product.OpenCode).data,
    channel: InstallationChannel,
    database: Flag.OPENCODE_DB,
    disableChannel:
      process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true",
    allowOpenCodePaths: Flag.GRAPH_VIBE_ALLOW_OPENCODE_PATHS,
  })
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
