export * as ProductMigrationConfig from "./config"

import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, realpath, rmdir } from "node:fs/promises"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { parse } from "jsonc-parser"
import { Credential } from "../credential"
import { CredentialTable } from "../credential/sql"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { FSUtil } from "../fs-util"
import { ConfigV1 } from "../v1/config/config"
import { Integration } from "@opencode-ai/schema/integration"
import { ProductMigration } from "@opencode-ai/schema/product-migration"
import { ProductMigrationConfigPolicy } from "./config-policy"
import { ProductMigrationFile } from "./file"
import { ProductMigrationSnapshot } from "./snapshot"
import { ProductMigrationSource } from "./source"

export class TargetConflict extends Schema.TaggedErrorClass<TargetConflict>()("ProductMigrationConfigTargetConflict", {
  path: Schema.String,
}) {}

export class InvalidPath extends Schema.TaggedErrorClass<InvalidPath>()("ProductMigrationConfigInvalidPath", {
  path: Schema.String,
}) {}

export class MigrationError extends Schema.TaggedErrorClass<MigrationError>()("ProductMigrationConfigError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class SourceChanged extends Schema.TaggedErrorClass<SourceChanged>()("ProductMigrationConfigSourceChanged", {
  path: Schema.String,
}) {}

export interface Result {
  readonly configFiles: number
  readonly credentialFiles: number
  readonly databaseCredentials: number
}

export interface Interface {
  readonly migrate: (input: {
    readonly sourceConfig: string
    readonly sourceData: string
    readonly sourceDatabase: string
    readonly targetConfig: string
    readonly targetData: string
    readonly snapshotDirectory?: string
    readonly snapshot?: ProductMigrationSnapshot.Snapshot
    readonly databaseFingerprint: string
    readonly categories?: ReadonlyArray<"config" | "credentials" | "mcp">
    readonly expected: ProductMigrationSource.ExpectedInventory
  }) => Effect.Effect<Result, TargetConflict | InvalidPath | MigrationError | SourceChanged>
  readonly validate: (input: {
    readonly sourceDatabase: string
    readonly targetConfig: string
    readonly targetData: string
    readonly categories: ReadonlyArray<"config" | "credentials" | "mcp">
    readonly expected: ProductMigrationSource.ExpectedInventory
  }) => Effect.Effect<ProductMigration.ValidationIssue[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationConfig") {}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeCredential = Schema.decodeUnknownOption(Credential.Value)
const ProviderAuthFile = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("oauth"),
      refresh: Schema.String,
      access: Schema.String,
      expires: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      accountId: Schema.optional(Schema.String),
      enterpriseUrl: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("api"),
      key: Schema.String,
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
    Schema.Struct({ type: Schema.Literal("wellknown"), key: Schema.String, token: Schema.String }),
  ]),
)
const McpAuthFile = Schema.Record(
  Schema.String,
  Schema.Struct({
    tokens: Schema.optional(
      Schema.Struct({
        accessToken: Schema.String,
        refreshToken: Schema.optional(Schema.String),
        expiresAt: Schema.optional(Schema.Number),
        scope: Schema.optional(Schema.String),
      }),
    ),
    clientInfo: Schema.optional(
      Schema.Struct({
        clientId: Schema.String,
        clientSecret: Schema.optional(Schema.String),
        clientIdIssuedAt: Schema.optional(Schema.Number),
        clientSecretExpiresAt: Schema.optional(Schema.Number),
      }),
    ),
    codeVerifier: Schema.optional(Schema.String),
    oauthState: Schema.optional(Schema.String),
    serverUrl: Schema.optional(Schema.String),
  }),
)
const TuiKeyStroke = Schema.Struct({
  name: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  super: Schema.optional(Schema.Boolean),
  hyper: Schema.optional(Schema.Boolean),
})
const TuiBindingObject = Schema.StructWithRest(
  Schema.Struct({
    key: Schema.Union([Schema.String, TuiKeyStroke]),
    event: Schema.optional(Schema.Literals(["press", "release"])),
    preventDefault: Schema.optional(Schema.Boolean),
    fallthrough: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
const TuiBindingItem = Schema.Union([Schema.String, TuiKeyStroke, TuiBindingObject])
const TuiBinding = Schema.Union([
  Schema.Literal(false),
  Schema.Literal("none"),
  TuiBindingItem,
  Schema.Array(TuiBindingItem),
])
const TuiFile = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String),
  keybinds: Schema.optional(Schema.Record(Schema.String, TuiBinding)),
  plugin: Schema.optional(
    Schema.Array(
      Schema.Union([Schema.String, Schema.Tuple([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])]),
    ),
  ),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  leader_timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  attention: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      notifications: Schema.optional(Schema.Boolean),
      sound: Schema.optional(Schema.Boolean),
      volume: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))),
      sound_pack: Schema.optional(Schema.String),
      sounds: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  prompt: Schema.optional(
    Schema.Struct({
      max_height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      max_width: Schema.optional(Schema.Union([Schema.Int.check(Schema.isGreaterThan(0)), Schema.Literal("auto")])),
    }),
  ),
  scroll_speed: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))),
  scroll_acceleration: Schema.optional(Schema.Struct({ enabled: Schema.Boolean })),
  diff_style: Schema.optional(Schema.Literals(["auto", "stacked"])),
  mouse: Schema.optional(Schema.Boolean),
})
const decodeTui = Schema.decodeUnknownOption(TuiFile)

interface StagedCredential {
  readonly target: string
  readonly temporary: string
}

interface InventoryState {
  readonly expected: ReadonlyMap<string, string>
  readonly opened: Set<string>
}

function overlaps(left: string, right: string) {
  const relative = path.relative(left, right)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function statOptional(fs: FSUtil.Interface, target: string) {
  return fs.stat(target).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
    Effect.mapError((cause) => new MigrationError({ path: target, cause })),
  )
}

function readOptionalContained(fs: FSUtil.Interface, target: string, root: string, maxBytes: number) {
  return fs.existsSafe(target).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.tryPromise({
            try: () => ProductMigrationFile.readContainedFile({ file: target, root, maxBytes }),
            catch: (cause) => new MigrationError({ path: target, cause }),
          }).pipe(Effect.map((result) => Option.some(result.content)))
        : Effect.succeed(Option.none<Uint8Array>()),
    ),
  )
}

function canonicalTarget(fs: FSUtil.Interface, target: string): Effect.Effect<string, MigrationError> {
  return fs.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target)
      if (parent === target) return Effect.succeed(target)
      return canonicalTarget(fs, parent).pipe(Effect.map((resolved) => path.join(resolved, path.basename(target))))
    }),
    Effect.mapError((cause) => new MigrationError({ path: target, cause })),
  )
}

function copyTree(
  fs: FSUtil.Interface,
  source: string,
  target: string,
  sourceRoot: string,
  inventory: InventoryState,
  root = true,
): Effect.Effect<number, MigrationError> {
  return Effect.gen(function* () {
    const entries = yield* fs
      .readDirectoryEntries(source)
      .pipe(Effect.mapError((cause) => new MigrationError({ path: source, cause })))
    const copied = yield* Effect.forEach(entries, (entry): Effect.Effect<number, MigrationError> => {
      if (entry.type === "symlink" || ProductMigrationConfigPolicy.isDisposable(entry.name)) return Effect.succeed(0)
      if (root && entry.type === "directory" && !ProductMigrationConfigPolicy.directories.has(entry.name))
        return Effect.succeed(0)
      if (root && entry.type === "file" && !ProductMigrationConfigPolicy.copiedRootFiles.has(entry.name))
        return Effect.succeed(0)
      const from = path.join(source, entry.name)
      const to = path.join(target, entry.name)
      if (entry.type === "directory") {
        return fs.ensureDir(to).pipe(
          Effect.mapError((cause) => new MigrationError({ path: to, cause })),
          Effect.andThen(copyTree(fs, from, to, sourceRoot, inventory, false)),
        )
      }
      if (entry.type !== "file") return Effect.succeed(0)
      return Effect.tryPromise({
        try: () =>
          ProductMigrationFile.readContainedFile({
            file: from,
            root: sourceRoot,
            maxBytes: ProductMigrationFile.configFileMaxBytes,
          }),
        catch: (cause) => new MigrationError({ path: from, cause }),
      }).pipe(
        Effect.flatMap((content) => {
          const relative = path.relative(sourceRoot, from).replaceAll(path.sep, "/")
          const expected = inventory.expected.get(relative)
          if (!expected || createHash("sha256").update(content.content).digest("hex") !== expected) {
            return Effect.fail(new MigrationError({ path: from, cause: new Error("Config source hash mismatch") }))
          }
          inventory.opened.add(relative)
          const validate =
            root && ProductMigrationConfigPolicy.copiedRootFiles.has(entry.name)
              ? Effect.try({
                  try: () => {
                    const errors: Parameters<typeof parse>[1] = []
                    const value = parse(new TextDecoder().decode(content.content), errors, { allowTrailingComma: true })
                    if (errors.length > 0 || Option.isNone(decodeTui(value))) throw new Error(`Invalid ${entry.name}`)
                  },
                  catch: (cause) => new MigrationError({ path: from, cause }),
                })
              : Effect.void
          return validate.pipe(
            Effect.andThen(fs.writeWithDirs(to, content.content, content.mode)),
            Effect.mapError((cause) =>
              cause instanceof MigrationError ? cause : new MigrationError({ path: to, cause }),
            ),
          )
        }),
        Effect.as(1),
      )
    })
    return copied.reduce((total, count) => total + count, 0)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(source).reduce((merged, [key, value]) => {
    const current = merged[key]
    return {
      ...merged,
      [key]: isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value,
    }
  }, target)
}

function stageConfigFiles(
  fs: FSUtil.Interface,
  source: string,
  sourceRoot: string,
  staging: string,
  inventory: InventoryState,
) {
  return Effect.gen(function* () {
    const documents = (yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.existsSafe(path.join(source, name)).pipe(
        Effect.flatMap((exists) =>
          exists
            ? Effect.tryPromise({
                try: () =>
                  ProductMigrationFile.readContainedFile({
                    file: path.join(source, name),
                    root: sourceRoot,
                    maxBytes: ProductMigrationFile.configFileMaxBytes,
                  }),
                catch: (cause) => new MigrationError({ path: path.join(source, name), cause }),
              }).pipe(Effect.map((content) => [{ name, content: content.content }]))
            : Effect.succeed([]),
        ),
      ),
    )).flat()
    if (documents.length === 0) return 0
    const parsed = yield* Effect.forEach(documents, (document) =>
      Effect.try({
        try: () => {
          const expected = inventory.expected.get(document.name)
          if (!expected || createHash("sha256").update(document.content).digest("hex") !== expected) {
            throw new Error(`Config source hash mismatch: ${document.name}`)
          }
          inventory.opened.add(document.name)
          const errors: Parameters<typeof parse>[1] = []
          const value = parse(new TextDecoder().decode(document.content), errors, { allowTrailingComma: true })
          if (
            errors.length > 0 ||
            !isRecord(value) ||
            Option.isNone(Schema.decodeUnknownOption(ConfigV1.Info)(value))
          ) {
            throw new Error(`Invalid OpenCode configuration: ${document.name}`)
          }
          return value
        },
        catch: (cause) => new MigrationError({ path: path.join(source, document.name), cause }),
      }),
    )
    const merged = parsed.reduce(mergeConfig, {})
    const tui = isRecord(merged.tui) ? merged.tui : {}
    const legacyTui = {
      ...(typeof merged.theme === "string" ? { theme: merged.theme } : {}),
      ...(isRecord(merged.keybinds) ? { keybinds: merged.keybinds } : {}),
      ...(typeof tui.scroll_speed === "number" ? { scroll_speed: tui.scroll_speed } : {}),
      ...(isRecord(tui.scroll_acceleration) ? { scroll_acceleration: tui.scroll_acceleration } : {}),
      ...(tui.diff_style === "auto" || tui.diff_style === "stacked" ? { diff_style: tui.diff_style } : {}),
    }
    delete merged.theme
    delete merged.keybinds
    delete merged.tui
    yield* fs
      .writeWithDirs(path.join(staging, "graph-vibe.json"), JSON.stringify(merged, null, 2))
      .pipe(Effect.mapError((cause) => new MigrationError({ path: staging, cause })))
    const tuiExists = yield* Effect.all([
      statOptional(fs, path.join(staging, "tui.json")),
      statOptional(fs, path.join(staging, "tui.jsonc")),
    ]).pipe(Effect.map((items) => items.some(Option.isSome)))
    if (tuiExists || Object.keys(legacyTui).length === 0) return 1
    yield* fs
      .writeWithDirs(
        path.join(staging, "tui.json"),
        JSON.stringify({ $schema: "https://opencode.ai/tui.json", ...legacyTui }, null, 2),
      )
      .pipe(Effect.mapError((cause) => new MigrationError({ path: staging, cause })))
    return 2
  })
}

function sameTree(
  fs: FSUtil.Interface,
  left: string,
  right: string,
  leftRoot: string,
  rightRoot: string,
): Effect.Effect<boolean, MigrationError> {
  return Effect.gen(function* () {
    const leftAll = yield* fs
      .readDirectoryEntries(left)
      .pipe(Effect.mapError((cause) => new MigrationError({ path: left, cause })))
    const rightAll = yield* fs
      .readDirectoryEntries(right)
      .pipe(Effect.mapError((cause) => new MigrationError({ path: right, cause })))
    if (
      [...leftAll, ...rightAll].some(
        (entry) => entry.type === "symlink" || (entry.type !== "file" && entry.type !== "directory"),
      )
    ) {
      return false
    }
    const leftEntries = leftAll
      .filter((entry) => !ProductMigrationConfigPolicy.isDisposable(entry.name))
      .toSorted((a, b) => ProductMigrationSource.ordinal(a.name, b.name))
    const rightEntries = rightAll
      .filter((entry) => !ProductMigrationConfigPolicy.isDisposable(entry.name))
      .toSorted((a, b) => ProductMigrationSource.ordinal(a.name, b.name))
    if (leftEntries.length !== rightEntries.length) return false
    return (yield* Effect.forEach(leftEntries, (entry, index) => {
      const other = rightEntries[index]
      if (!other || entry.name !== other.name || entry.type !== other.type || entry.type === "symlink") {
        return Effect.succeed(false)
      }
      if (entry.type === "directory") {
        return sameTree(fs, path.join(left, entry.name), path.join(right, entry.name), leftRoot, rightRoot)
      }
      if (entry.type !== "file") return Effect.succeed(false)
      const leftFile = path.join(left, entry.name)
      const rightFile = path.join(right, entry.name)
      return Effect.tryPromise({
        try: async () => {
          const leftInfo = await lstat(leftFile)
          const rightInfo = await lstat(rightFile).catch(() => undefined)
          if (!rightInfo) return false
          if (
            leftInfo.size > ProductMigrationFile.configFileMaxBytes ||
            rightInfo.size > ProductMigrationFile.configFileMaxBytes
          ) {
            return false
          }
          const leftHash = await ProductMigrationFile.hashContainedFile({
            file: leftFile,
            root: leftRoot,
            maxBytes: ProductMigrationFile.configFileMaxBytes,
          })
          const rightHash = await ProductMigrationFile.hashContainedFile({
            file: rightFile,
            root: rightRoot,
            maxBytes: ProductMigrationFile.configFileMaxBytes,
          }).catch(() => undefined)
          if (!rightHash) return false
          return leftHash.size === rightHash.size && leftHash.sha256 === rightHash.sha256
        },
        catch: (cause) => new MigrationError({ path: leftFile, cause }),
      })
    })).every(Boolean)
  })
}

function stageCredential(
  fs: FSUtil.Interface,
  source: string,
  sourceRoot: string,
  target: string,
  targetRoot: string,
  expected: ProductMigrationSource.ExpectedFile | null,
): Effect.Effect<StagedCredential[], MigrationError | TargetConflict> {
  return Effect.gen(function* () {
    const content = yield* readOptionalContained(fs, source, sourceRoot, ProductMigrationFile.credentialFileMaxBytes)
    if (Option.isNone(content)) {
      if (expected)
        return yield* new MigrationError({ path: source, cause: new Error("Expected credential is missing") })
      return []
    }
    if (!expected || createHash("sha256").update(content.value).digest("hex") !== expected.sha256) {
      return yield* new MigrationError({ path: source, cause: new Error("Credential source hash mismatch") })
    }
    const json = decodeJson(new TextDecoder().decode(content.value))
    const schema = path.basename(source) === "auth.json" ? ProviderAuthFile : McpAuthFile
    if (Option.isNone(json) || Option.isNone(Schema.decodeUnknownOption(schema)(json.value))) {
      return yield* new MigrationError({ path: source, cause: new Error(`Invalid ${path.basename(source)}`) })
    }
    const info = yield* Effect.promise(() => lstat(target).catch(() => undefined))
    if (info && !info.isSymbolicLink() && (!info.isFile() || info.size > ProductMigrationFile.credentialFileMaxBytes)) {
      return yield* new TargetConflict({ path: target })
    }
    const existing = info?.isSymbolicLink()
      ? Option.none<Uint8Array>()
      : yield* readOptionalContained(fs, target, targetRoot, ProductMigrationFile.credentialFileMaxBytes).pipe(
          Effect.mapError(() => new TargetConflict({ path: target })),
        )
    if (Option.isSome(existing) && !Buffer.from(existing.value).equals(Buffer.from(content.value))) {
      return yield* new TargetConflict({ path: target })
    }
    const temporary = `${target}.migration-staging`
    yield* fs.ensureDir(path.dirname(temporary)).pipe(
      Effect.mapError((cause) => new MigrationError({ path: temporary, cause })),
      Effect.andThen(fs.remove(temporary, { force: true })),
      Effect.andThen(fs.writeFile(temporary, content.value, { flag: "wx", mode: 0o600 })),
      Effect.mapError((cause) => new MigrationError({ path: temporary, cause })),
    )
    return [{ target, temporary }]
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const sqliteModule = yield* Effect.promise(() => import("bun:sqlite"))

    return Service.of({
      migrate: Effect.fn("ProductMigrationConfig.migrate")(function* (input) {
        const categories = new Set(input.categories ?? ["config", "credentials", "mcp"])
        const paths = [input.sourceConfig, input.sourceData, input.sourceDatabase, input.targetConfig, input.targetData]
        const invalid = paths.find((item) => !path.isAbsolute(item))
        if (invalid) return yield* new InvalidPath({ path: invalid })

        const sourceRoots = yield* Effect.forEach(
          [input.sourceConfig, input.sourceData, input.sourceDatabase],
          (item) => fs.realPath(item).pipe(Effect.mapError((cause) => new MigrationError({ path: item, cause }))),
        )
        const targetRoots = yield* Effect.forEach([input.targetConfig, input.targetData], (item) =>
          canonicalTarget(fs, item),
        )
        const overlap = targetRoots.find((target) =>
          sourceRoots.some((source) => overlaps(source, target) || overlaps(target, source)),
        )
        if (overlap) return yield* new InvalidPath({ path: overlap })
        if (overlaps(targetRoots[0], targetRoots[1]) || overlaps(targetRoots[1], targetRoots[0])) {
          return yield* new InvalidPath({ path: input.targetData })
        }

        const readCredentials = (copy: ProductMigrationSnapshot.Snapshot) =>
          Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                return ProductMigrationSource.openReadTransaction(
                  () => new sqliteModule.Database(copy.database, { readonly: true, strict: true }),
                )
              },
              catch: (cause) => new MigrationError({ path: input.sourceDatabase, cause }),
            }),
            (sqlite) =>
              Effect.try({
                try: () => {
                  const exists = sqlite
                    .query<
                      { name: string },
                      []
                    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
                    .get()
                  const sessionTable = sqlite
                    .query<
                      { name: string },
                      []
                    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
                    .get()
                  const sessionCount = sessionTable
                    ? (sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count ?? 0)
                    : 0
                  if (!categories.has("credentials")) {
                    return { rows: [], sessionCount, identity: copy.identity }
                  }
                  const expected = input.expected.credentialIDs.toSorted()
                  if (!exists) {
                    if (expected.length > 0) throw new SourceChanged({ path: input.sourceDatabase })
                    return { rows: [], sessionCount, identity: copy.identity }
                  }
                  ProductMigrationSource.preflightTextRows(sqlite, {
                    table: "credential",
                    columns: [
                      { name: "id", label: "credential.id", maxBytes: 256 },
                      { name: "integration_id", label: "credential.integration_id", maxBytes: 256 },
                      { name: "label", label: "credential.label", maxBytes: 4_096 },
                      {
                        name: "value",
                        label: "credential.value",
                        maxBytes: ProductMigrationFile.credentialFileMaxBytes,
                      },
                      { name: "connector_id", label: "credential.connector_id", maxBytes: 256 },
                      { name: "method_id", label: "credential.method_id", maxBytes: 256 },
                      { name: "active", label: "credential.active", maxBytes: 32 },
                      { name: "time_created", label: "credential.time_created", maxBytes: 32 },
                      { name: "time_updated", label: "credential.time_updated", maxBytes: 32 },
                    ],
                    aggregateMaxBytes: 32 * 1024 * 1024,
                    aggregateLabel: "credential aggregate",
                  })
                  const count =
                    sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM credential").get()?.count ?? 0
                  if (count !== expected.length) throw new SourceChanged({ path: input.sourceDatabase })
                  const ids = sqlite
                    .query<{ id: string }, [number]>("SELECT id FROM credential ORDER BY id LIMIT ?")
                    .all(expected.length + 1)
                    .map((row) => row.id)
                  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
                    throw new SourceChanged({ path: input.sourceDatabase })
                  }
                  const largest = sqlite
                    .query<{ bytes: number | null; total: number | null }, []>(
                      `SELECT MAX(length(CAST(value AS BLOB))) AS bytes,
                                    SUM(length(CAST(value AS BLOB))) AS total
                             FROM credential`,
                    )
                    .get()
                  if ((largest?.bytes ?? 0) > ProductMigrationFile.credentialFileMaxBytes) {
                    throw new Error("Credential value exceeds the secret byte limit")
                  }
                  if ((largest?.total ?? 0) > ProductMigrationFile.credentialInventoryMaxBytes) {
                    throw new Error("Credential inventory exceeds the aggregate byte limit")
                  }
                  const rows = sqlite
                    .query<
                        {
                          id: string
                          integration_id: string | null
                          label: string
                          value: string
                          connector_id: string | null
                          method_id: string | null
                          active: number | null
                          time_created: number
                          time_updated: number
                        },
                        [number]
                    >(`SELECT id, integration_id, label, value, connector_id, method_id,
                              active, time_created, time_updated
                       FROM credential ORDER BY id LIMIT ?`)
                    .all(expected.length + 1)
                  if (
                    rows.some(
                      (row) =>
                        typeof row.id !== "string" ||
                        (row.integration_id !== null && typeof row.integration_id !== "string") ||
                        typeof row.label !== "string" ||
                        typeof row.value !== "string" ||
                        (row.connector_id !== null && typeof row.connector_id !== "string") ||
                        (row.method_id !== null && typeof row.method_id !== "string") ||
                        (row.active !== null && !Number.isFinite(row.active)) ||
                        !Number.isFinite(row.time_created) ||
                        !Number.isFinite(row.time_updated),
                    )
                  ) {
                    throw new Error("Credential text fields are invalid")
                  }
                  return {
                    rows,
                    sessionCount,
                    identity: copy.identity,
                  }
                },
                catch: (cause) =>
                  cause instanceof SourceChanged ? cause : new MigrationError({ path: input.sourceDatabase, cause }),
              }),
            (sqlite) => Effect.sync(() => sqlite.close(false)),
          )
        const credentialSnapshot = yield* (
          input.snapshot
            ? readCredentials(input.snapshot)
            : ProductMigrationSnapshot.use(
                { database: input.sourceDatabase, directory: input.snapshotDirectory },
                readCredentials,
              )
        ).pipe(
          Effect.mapError((cause) => {
            if (cause instanceof SourceChanged || cause instanceof MigrationError) return cause
            if (cause instanceof ProductMigrationSnapshot.SnapshotError && cause.reason === "changed") {
              return new SourceChanged({ path: input.sourceDatabase })
            }
            return new MigrationError({ path: input.sourceDatabase, cause })
          }),
        )
        const fingerprint = ProductMigrationSource.fingerprint({
          database: sourceRoots[2],
          databaseBytes: credentialSnapshot.identity.size,
          sessionCount: credentialSnapshot.sessionCount,
          identity: credentialSnapshot.identity,
        })
        if (!input.databaseFingerprint || fingerprint !== input.databaseFingerprint) {
          return yield* new SourceChanged({ path: input.sourceDatabase })
        }
        const credentialRows = credentialSnapshot.rows

        const staging = `${input.targetConfig}.migration-${Bun.randomUUIDv7()}`
        yield* fs
          .remove(staging, { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => new MigrationError({ path: staging, cause })))
        const configFiles = categories.has("config")
          ? yield* Effect.gen(function* () {
              const inventory: InventoryState = {
                expected: new Map(input.expected.configSources.map((file) => [file.path, file.sha256])),
                opened: new Set(),
              }
              yield* fs
                .ensureDir(staging)
                .pipe(Effect.mapError((cause) => new MigrationError({ path: staging, cause })))
              const copied = yield* copyTree(fs, input.sourceConfig, staging, sourceRoots[0], inventory)
              const config = yield* stageConfigFiles(fs, input.sourceConfig, sourceRoots[0], staging, inventory)
              if (inventory.opened.size !== inventory.expected.size) {
                return yield* new MigrationError({
                  path: input.sourceConfig,
                  cause: new Error("Expected config source is missing"),
                })
              }
              return copied + config
            }).pipe(Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)))
          : 0

        return yield* Effect.gen(function* () {
          const targetInfo = categories.has("config") ? yield* statOptional(fs, input.targetConfig) : Option.none()
          if (Option.isSome(targetInfo) && targetInfo.value.type !== "Directory") {
            return yield* new TargetConflict({ path: input.targetConfig })
          }
          if (Option.isSome(targetInfo)) {
            const entry = (yield* fs
              .readDirectoryEntries(path.dirname(input.targetConfig))
              .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetConfig, cause })))).find(
              (candidate) => candidate.name === path.basename(input.targetConfig),
            )
            if (entry?.type === "symlink") return yield* new TargetConflict({ path: input.targetConfig })
          }
          const targetEntries = Option.isSome(targetInfo)
            ? yield* fs
                .readDirectoryEntries(input.targetConfig)
                .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetConfig, cause })))
            : []
          const targetEmpty = Option.isSome(targetInfo) && targetEntries.length === 0
          if (
            Option.isSome(targetInfo) &&
            !targetEmpty &&
            !(yield* sameTree(fs, input.targetConfig, staging, targetRoots[0], staging))
          ) {
            return yield* new TargetConflict({ path: input.targetConfig })
          }

          const credentials = yield* Effect.forEach(credentialRows, (row) => {
            const integrationID = row.integration_id ?? row.connector_id
            const json = decodeJson(row.value)
            const value = Option.isSome(json) ? decodeCredential(json.value) : Option.none()
            if (!integrationID || Option.isNone(value)) {
              return Effect.fail(
                new MigrationError({
                  path: `${input.sourceDatabase}#credential:${row.id}`,
                  cause: new Error("Invalid credential"),
                }),
              )
            }
            return Effect.succeed({
              id: Credential.ID.make(row.id),
              integration_id: Integration.ID.make(integrationID),
              label: row.label,
              value: value.value,
              connector_id: row.connector_id,
              method_id: row.method_id,
              active: row.active === null ? null : row.active === 1,
              time_created: row.time_created,
              time_updated: row.time_updated,
            })
          })
          const existingCredentials = yield* db
            .select()
            .from(CredentialTable)
            .all()
            .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetData, cause })))
          const existingByID = new Map(existingCredentials.map((credential) => [credential.id, credential]))
          const conflict = credentials.find((credential) => {
            const existing = existingByID.get(credential.id)
            return existing && JSON.stringify(existing) !== JSON.stringify(credential)
          })
          if (conflict) return yield* new TargetConflict({ path: `${input.targetData}#credential:${conflict.id}` })
          const pendingCredentials = credentials.filter((credential) => !existingByID.has(credential.id))
          const credentialFiles = [
            ...(categories.has("credentials") ? ["auth.json"] : []),
            ...(categories.has("mcp") ? ["mcp-auth.json"] : []),
          ]
          const stagedCredentials = (yield* Effect.forEach(credentialFiles, (name) =>
            stageCredential(
              fs,
              path.join(input.sourceData, name),
              sourceRoots[1],
              path.join(input.targetData, name),
              targetRoots[1],
              name === "auth.json" ? input.expected.auth : input.expected.mcpAuth,
            ),
          ).pipe(
            Effect.onError(() =>
              Effect.forEach(credentialFiles, (name) =>
                fs
                  .remove(path.join(input.targetData, `${name}.migration-staging`), { force: true })
                  .pipe(Effect.ignore),
              ),
            ),
          )).flat()

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (categories.has("config") && (Option.isNone(targetInfo) || targetEmpty)) {
                if (targetEmpty) {
                  const current = yield* fs
                    .readDirectoryEntries(input.targetConfig)
                    .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetConfig, cause })))
                  if (current.length > 0) return yield* new TargetConflict({ path: input.targetConfig })
                  yield* Effect.tryPromise({
                    try: () => rmdir(input.targetConfig),
                    catch: () => new TargetConflict({ path: input.targetConfig }),
                  })
                }
                yield* fs
                  .rename(staging, input.targetConfig)
                  .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetConfig, cause })))
              }
              yield* Effect.forEach(stagedCredentials, (credential) =>
                fs
                  .rename(credential.temporary, credential.target)
                  .pipe(Effect.mapError((cause) => new MigrationError({ path: credential.target, cause }))),
              )
              if (pendingCredentials.length > 0) {
                yield* db
                  .insert(CredentialTable)
                  .values(pendingCredentials)
                  .run()
                  .pipe(Effect.mapError((cause) => new MigrationError({ path: input.targetData, cause })))
              }
            }),
          ).pipe(
            Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
            Effect.ensuring(
              Effect.forEach(stagedCredentials, (credential) =>
                fs.remove(credential.temporary, { force: true }).pipe(Effect.ignore),
              ),
            ),
          )
          return {
            configFiles,
            credentialFiles: stagedCredentials.length,
            databaseCredentials: pendingCredentials.length,
          }
        }).pipe(
          Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
          Effect.ensuring(
            Effect.forEach(["auth.json", "mcp-auth.json"], (name) =>
              fs.remove(path.join(input.targetData, `${name}.migration-staging`), { force: true }).pipe(Effect.ignore),
            ),
          ),
        )
      }),
      validate: Effect.fn("ProductMigrationConfig.validate")(function* (input) {
        const categories = new Set(input.categories)
        const configIssues = categories.has("config")
          ? input.expected.configPaths.length === 0
            ? [{ code: "config_missing", message: "Migrated configuration inventory is empty" }]
            : (yield* Effect.forEach(input.expected.configPaths, (relative) => {
                const target = path.resolve(input.targetConfig, relative)
                const contained = path.relative(input.targetConfig, target)
                if (
                  contained === "" ||
                  path.isAbsolute(contained) ||
                  contained === ".." ||
                  contained.startsWith(`..${path.sep}`)
                ) {
                  return Effect.succeed([
                    { code: "config_missing", message: `Migrated configuration path ${relative} is invalid` },
                  ])
                }
                return Effect.promise(() =>
                  lstat(target).then(
                    (info) => info,
                    () => undefined,
                  ),
                ).pipe(
                  Effect.map((info) =>
                    info?.isFile() && !info.isSymbolicLink()
                      ? []
                      : [{ code: "config_missing", message: `Migrated configuration ${relative} is missing` }],
                  ),
                )
              })).flat()
          : []
        const authPresent =
          !categories.has("credentials") ||
          input.expected.auth === null ||
          (yield* fs.existsSafe(path.join(input.targetData, "auth.json")))
        const targetCredentialIDs = categories.has("credentials")
          ? new Set(
              (yield* db.select({ id: CredentialTable.id }).from(CredentialTable).all().pipe(Effect.orDie)).map(
                (row) => row.id,
              ),
            )
          : new Set<string>()
        const missingCredentialIDs = categories.has("credentials")
          ? input.expected.credentialIDs.filter((id) => !targetCredentialIDs.has(Credential.ID.make(id)))
          : []
        const mcpPresent =
          !categories.has("mcp") ||
          input.expected.mcpAuth === null ||
          (yield* fs.existsSafe(path.join(input.targetData, "mcp-auth.json")))
        const requiredIssues: ProductMigration.ValidationIssue[] = [
          ...(!authPresent ? [{ code: "credential_missing", message: "Migrated auth.json is missing" }] : []),
          ...missingCredentialIDs.map((id) => ({
            code: "credential_missing",
            message: `Migrated credential ${id} is missing`,
          })),
          ...(categories.has("credentials") && input.expected.auth === null && input.expected.credentialIDs.length === 0
            ? [{ code: "credential_missing", message: "Migrated credential inventory is empty" }]
            : []),
          ...(!mcpPresent ? [{ code: "mcp_missing", message: "Migrated mcp-auth.json is missing" }] : []),
          ...(categories.has("mcp") && input.expected.mcpAuth === null
            ? [{ code: "mcp_missing", message: "Migrated MCP authentication inventory is empty" }]
            : []),
        ]
        const configFormatIssues = categories.has("config")
          ? (yield* Effect.forEach(
              [
                { name: "graph-vibe.json", schema: ConfigV1.Info },
                { name: "graph-vibe.jsonc", schema: ConfigV1.Info },
                { name: "tui.json", schema: TuiFile },
                { name: "tui.jsonc", schema: TuiFile },
              ],
              (item) => {
                const target = path.join(input.targetConfig, item.name)
                return Effect.gen(function* () {
                  if (!(yield* fs.existsSafe(target))) return []
                  const info = yield* Effect.promise(() => lstat(target).catch(() => undefined))
                  if (!info || !info.isFile() || info.isSymbolicLink()) {
                    return [{ code: "config_unreadable", message: `Migrated ${item.name} is unreadable` }]
                  }
                  if (info.size > ProductMigrationFile.configFileMaxBytes) {
                    return [{ code: "config_limit", message: `Migrated ${item.name} exceeds the config byte limit` }]
                  }
                  return yield* Effect.tryPromise({
                    try: () =>
                      ProductMigrationFile.readContainedFile({
                        file: target,
                        root: input.targetConfig,
                        maxBytes: ProductMigrationFile.configFileMaxBytes,
                      }),
                    catch: () => new Error(`Migrated ${item.name} is unreadable`),
                  }).pipe(
                    Effect.map((result) => {
                      const content = new TextDecoder().decode(result.content)
                      const errors: Parameters<typeof parse>[1] = []
                      const value: unknown = parse(content, errors, { allowTrailingComma: true })
                      if (errors.length === 0 && Option.isSome(Schema.decodeUnknownOption(item.schema)(value)))
                        return []
                      return [{ code: "config_invalid", message: `Migrated ${item.name} is invalid` }]
                    }),
                    Effect.catch(() =>
                      Effect.succeed([{ code: "config_unreadable", message: `Migrated ${item.name} is unreadable` }]),
                    ),
                  )
                })
              },
            )).flat()
          : []
        const credentialIssues = (yield* Effect.forEach(
          [
            ...(categories.has("credentials") && input.expected.auth !== null
              ? [{ name: "auth.json", schema: ProviderAuthFile }]
              : []),
            ...(categories.has("mcp") && input.expected.mcpAuth !== null
              ? [{ name: "mcp-auth.json", schema: McpAuthFile }]
              : []),
          ],
          (item) => {
            const target = path.join(input.targetData, item.name)
            return Effect.gen(function* () {
              if (!(yield* fs.existsSafe(target))) return []
              const info = yield* Effect.tryPromise({ try: () => lstat(target), catch: () => undefined }).pipe(
                Effect.option,
              )
              if (Option.isNone(info) || !info.value.isFile() || info.value.isSymbolicLink()) {
                return [{ code: "credential_invalid", message: `Migrated ${item.name} is not a regular file` }]
              }
              const issues: ProductMigration.ValidationIssue[] = []
              if (process.platform !== "win32" && (info.value.mode & 0o077) !== 0) {
                issues.push({ code: "credential_mode", message: `Migrated ${item.name} permissions are not private` })
              }
              if (info.value.size > ProductMigrationFile.credentialFileMaxBytes) {
                issues.push({
                  code: "credential_limit",
                  message: `Migrated ${item.name} exceeds the secret byte limit`,
                })
                return issues
              }
              const content = yield* Effect.promise(() =>
                ProductMigrationFile.readContainedFile({
                  file: target,
                  root: input.targetData,
                  maxBytes: ProductMigrationFile.credentialFileMaxBytes,
                }).then(
                  (result) => new TextDecoder().decode(result.content),
                  () => undefined,
                ),
              )
              const json = content === undefined ? Option.none() : decodeJson(content)
              if (Option.isNone(json) || Option.isNone(Schema.decodeUnknownOption(item.schema)(json.value))) {
                issues.push({ code: "credential_invalid", message: `Migrated ${item.name} is invalid` })
              }
              return issues
            })
          },
        )).flat()
        return [...configIssues, ...requiredIssues, ...configFormatIssues, ...credentialIssues].slice(0, 32)
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, FSUtil.node] })
