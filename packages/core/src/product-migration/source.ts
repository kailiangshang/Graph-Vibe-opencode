export * as ProductMigrationSource from "./source"

import path from "node:path"
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { LayerNode } from "../effect/layer-node"
import type { ProductMigration } from "@opencode-ai/schema/product-migration"

export interface CategorySummary {
  readonly category: "config" | "credentials" | "mcp"
  readonly available: boolean
  readonly estimatedBytes: number
}

export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly estimatedBytes: number
  readonly hasGraph: boolean
}

export interface ProjectSummary {
  readonly id: string
  readonly path: string
  readonly sessionCount: number
  readonly estimatedBytes: number
  readonly sessions: SessionSummary[]
}

export interface Discovery {
  readonly sourceFingerprint: string
  readonly database: string
  readonly databaseBytes: number
  readonly mixedGraph: boolean
  readonly sessionCount: number
  readonly categories: CategorySummary[]
  readonly projects: ProjectSummary[]
}

export class SourceNotFound extends Schema.TaggedErrorClass<SourceNotFound>()("ProductMigrationSourceNotFound", {
  path: Schema.String,
}) {}

export class SourceReadError extends Schema.TaggedErrorClass<SourceReadError>()("ProductMigrationSourceReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly discover: (input: {
    readonly data: string
    readonly config: string
    readonly state: string
    readonly database?: string
  }) => Effect.Effect<Discovery, SourceNotFound | SourceReadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationSource") {}

const directoryBytes = (fs: FSUtil.Interface, target: string): Effect.Effect<number> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(target).pipe(Effect.option)
    if (Option.isNone(info)) return 0
    if (info.value.type === "File") return Number(info.value.size)
    if (info.value.type !== "Directory") return 0
    const entries = yield* fs.readDirectoryEntries(target).pipe(Effect.orElseSucceed(() => []))
    return (yield* Effect.forEach(entries, (entry) => directoryBytes(fs, path.join(target, entry.name)), {
      concurrency: 8,
    })).reduce((total, size) => total + size, 0)
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const { Database } = yield* Effect.promise(() => import("bun:sqlite"))

    return Service.of({
      discover: Effect.fn("ProductMigrationSource.discover")(function* (input) {
        const database = input.database ?? path.join(input.data, "opencode.db")
        if (!(yield* fs.existsSafe(database))) return yield* new SourceNotFound({ path: database })
        const dbInfo = yield* fs
          .stat(database)
          .pipe(Effect.mapError((cause) => new SourceReadError({ path: database, cause })))
        const mtime = Option.getOrElse(dbInfo.mtime, () => new Date(0)).getTime()
        const snapshot = yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              const sqlite = new Database(database, { readonly: true, strict: true })
              sqlite.run("BEGIN")
              return sqlite
            },
            catch: (cause) => new SourceReadError({ path: database, cause }),
          }),
          (sqlite) =>
            Effect.try({
              try: () => {
                const tables = new Set(
                  sqlite
                    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
                    .all()
                    .map((row) => row.name),
                )
                if (!tables.has("project") || !tables.has("session")) throw new Error("Unsupported OpenCode database")
                const sessions = sqlite
                  .query<
                    { id: string; project_id: string; title: string; time_updated: number },
                    []
                  >("SELECT id, project_id, title, time_updated FROM session ORDER BY time_updated DESC")
                  .all()
                const graphSessions = tables.has("graph_node")
                  ? new Set(
                      sqlite
                        .query<{ session_id: string }, []>(
                          "SELECT DISTINCT session_id FROM graph_node WHERE session_id IS NOT NULL",
                        )
                        .all()
                        .map((row) => row.session_id),
                    )
                  : new Set<string>()
                const projects = sqlite
                  .query<{ id: string; worktree: string }, []>("SELECT id, worktree FROM project ORDER BY id")
                  .all()
                  .map((project): ProjectSummary => {
                    const selected = sessions.filter((session) => session.project_id === project.id)
                    return {
                      id: project.id,
                      path: project.worktree,
                      sessionCount: selected.length,
                      estimatedBytes: 0,
                      sessions: selected.map((session) => ({
                        id: session.id,
                        title: session.title,
                        updatedAt: session.time_updated,
                        estimatedBytes: 0,
                        hasGraph: graphSessions.has(session.id),
                      })),
                    }
                  })
                const credentialCount = tables.has("credential")
                  ? (sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM credential").get()?.count ?? 0)
                  : 0
                return { tables, projects, sessions, credentialCount }
              },
              catch: (cause) => new SourceReadError({ path: database, cause }),
            }),
          (sqlite) =>
            Effect.sync(() => {
              sqlite.close(false)
            }),
        )
        const configBytes = yield* directoryBytes(fs, input.config)
        const authPath = path.join(input.data, "auth.json")
        const mcpPath = path.join(input.data, "mcp-auth.json")
        const authBytes = yield* directoryBytes(fs, authPath)
        const mcpBytes = yield* directoryBytes(fs, mcpPath)
        const databaseBytes = Number(dbInfo.size)
        const sourceFingerprint = createHash("sha256")
          .update(`${database}\0${databaseBytes}\0${mtime}\0${snapshot.sessions.length}`)
          .digest("hex")
        const categories: Array<CategorySummary & { category: ProductMigration.Category }> = [
          { category: "config", available: configBytes > 0, estimatedBytes: configBytes },
          {
            category: "credentials",
            available: authBytes > 0 || snapshot.credentialCount > 0,
            estimatedBytes: authBytes,
          },
          { category: "mcp", available: mcpBytes > 0, estimatedBytes: mcpBytes },
        ]
        return {
          sourceFingerprint,
          database,
          databaseBytes,
          mixedGraph: snapshot.tables.has("graph_node"),
          sessionCount: snapshot.sessions.length,
          categories,
          projects: snapshot.projects.map((project) => ({
            ...project,
            estimatedBytes: Math.floor(databaseBytes / Math.max(snapshot.projects.length, 1)),
            sessions: project.sessions.map((session) => ({
              ...session,
              estimatedBytes: Math.floor(databaseBytes / Math.max(snapshot.sessions.length, 1)),
            })),
          })),
        }
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })
