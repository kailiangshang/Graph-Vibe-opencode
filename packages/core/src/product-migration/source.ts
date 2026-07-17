export * as ProductMigrationSource from "./source"

import path from "node:path"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { LayerNode } from "../effect/layer-node"
import type { ProductMigration } from "@opencode-ai/schema/product-migration"
import npa from "npm-package-arg"
import { parse } from "jsonc-parser"
import { ProductMigrationConfigPolicy } from "./config-policy"
import { ProductMigrationFile } from "./file"
import { ProductMigrationSnapshot } from "./snapshot"

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
  readonly archived?: boolean
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
  readonly databaseFingerprint: string
  readonly database: string
  readonly databaseBytes: number
  readonly mixedGraph: boolean
  readonly sessionCount: number
  readonly categories: CategorySummary[]
  readonly projects: ProjectSummary[]
  readonly expected: ExpectedInventory
}

export interface ExpectedInventory {
  readonly configPaths: ReadonlyArray<string>
  readonly configSources: ReadonlyArray<ExpectedFile>
  readonly auth: ExpectedFile | null
  readonly mcpAuth: ExpectedFile | null
  readonly dependencies: ReadonlyArray<{ readonly name: string; readonly version: string }>
  readonly credentialIDs: ReadonlyArray<string>
}

export interface ExpectedFile {
  readonly path: string
  readonly sha256: string
}

export function fingerprint(input: {
  readonly database: string
  readonly databaseBytes: number
  readonly sessionCount: number
  readonly identity: DatabaseIdentity
  readonly manifestFingerprint?: string
}) {
  return createHash("sha256")
    .update(
      `graph-vibe-product-migration-source-fingerprint\0v2\0${input.database}\0${input.databaseBytes}\0${input.sessionCount}` +
        `\0${input.identity.version}\0${input.identity.size}\0${input.identity.sha256}` +
        `\0${input.manifestFingerprint ?? ""}`,
    )
    .digest("hex")
}

export type DatabaseIdentity = ProductMigrationSnapshot.DatabaseIdentity
export const databaseIdentity = ProductMigrationSnapshot.databaseIdentity
export const sameDatabaseIdentity = ProductMigrationSnapshot.sameDatabaseIdentity

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
    readonly snapshotDirectory?: string
    readonly snapshot?: ProductMigrationSnapshot.Snapshot
  }) => Effect.Effect<Discovery, SourceNotFound | SourceReadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationSource") {}

const manifestMaxDepth = 32
const manifestMaxEntries = 10_000
const manifestMaxBytes = 128 * 1024 * 1024
const databaseMaxProjects = 10_000
const databaseMaxSessions = 10_000
const databaseMaxCredentials = 10_000
const databaseIDMaxBytes = 256
const databasePathMaxBytes = 4_096
const databaseTitleMaxBytes = 64 * 1024
const databaseInventoryMaxBytes = 16 * 1024 * 1024
const referenceValueMaxBytes = 8 * 1024 * 1024
export const referencePageRows = 256
const referenceLimits = {
  rowBytes: referenceValueMaxBytes,
  scanBytes: 16 * 1024 * 1024 * 1024,
  scanRows: 1_000_000,
  pageRows: referencePageRows,
  pageBytes: 8 * 1024 * 1024,
  retainedCount: 100_000,
  retainedBytes: 64 * 1024 * 1024,
  retainedValueBytes: ProductMigrationFile.referenceRawMaxBytes,
}
export const referenceConcurrency = 16
const PackageDependencies = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const decodePackageDependencies = Schema.decodeUnknownOption(Schema.fromJsonString(PackageDependencies))
const decodeReferenceJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function registryDependencies(content: string) {
  const decoded = decodePackageDependencies(content)
  if (Option.isNone(decoded)) throw new Error("Invalid package dependency manifest")
  return Object.entries(decoded.value.dependencies ?? {})
    .map(([name, version]) => {
      if (name.length > 256 || version.length > 256) throw new Error("Dependency specification is too long")
      const spec = npa.resolve(name, version)
      if (!spec.registry || !["version", "range", "tag"].includes(spec.type)) {
        throw new Error("Dependency is not a registry package")
      }
      return { name, version }
    })
    .toSorted((left, right) => ordinal(left.name, right.name))
}

export function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function openReadTransaction<Database extends { run: (sql: string) => unknown; close: (throwOnError?: boolean) => void }>(
  open: () => Database,
) {
  const database = open()
  try {
    database.run("BEGIN")
    return database
  } catch (cause) {
    database.close(false)
    throw cause
  }
}

export function preflightTextRows(
  sqlite: import("bun:sqlite").Database,
  input: {
    readonly table: string
    readonly columns: ReadonlyArray<{ readonly name: string; readonly label: string; readonly maxBytes: number }>
    readonly aggregateMaxBytes: number
    readonly aggregateLabel: string
    readonly filter?: { readonly name: string; readonly value: import("bun:sqlite").SQLQueryBindings }
  },
) {
  if (
    !/^[a-z_]+$/.test(input.table) ||
    input.columns.some((column) => !/^[a-z_]+$/.test(column.name)) ||
    (input.filter && !/^[a-z_]+$/.test(input.filter.name))
  ) {
    throw new Error("Invalid SQLite inventory identifier")
  }
  const lengths = input.columns.map(
    (column) => `COALESCE(length(CAST("${column.name}" AS BLOB)), 0)`,
  )
  const row = sqlite
    .query<Record<string, number | null>, import("bun:sqlite").SQLQueryBindings[]>(
      `SELECT COUNT(*) AS count, SUM(${lengths.join(" + ") || "0"}) AS total,
              ${lengths.map((value, index) => `MAX(${value}) AS max_${index}`).join(", ")}
       FROM "${input.table}"${input.filter ? ` WHERE "${input.filter.name}" = ?` : ""}`,
    )
    .get(...(input.filter ? [input.filter.value] : []))
  const count = row?.count ?? 0
  const bytes = row?.total ?? 0
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${input.aggregateLabel} is invalid`)
  }
  input.columns.forEach((column, index) => {
    const maximum = row?.[`max_${index}`] ?? 0
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > column.maxBytes) {
      throw new Error(`${column.label} byte limit exceeded`)
    }
  })
  if (bytes > input.aggregateMaxBytes) throw new Error(`${input.aggregateLabel} byte limit exceeded`)
  return { count, bytes }
}

interface SourceManifest {
  readonly fingerprint: string
  readonly configBytes: number
  readonly authBytes: number
  readonly mcpBytes: number
  readonly configPaths: ReadonlyArray<string>
  readonly configSources: ReadonlyArray<ExpectedFile>
  readonly auth: ExpectedFile | null
  readonly mcpAuth: ExpectedFile | null
  readonly dependencies: ReadonlyArray<{ readonly name: string; readonly version: string }>
}

interface DirectoryIdentity {
  readonly canonical: string
  readonly dev: number
  readonly ino: number
  readonly mtime: number
}

interface Reference {
  readonly kind: "attachment" | "output"
  readonly value: string
}

interface ReferenceLimits {
  readonly rowBytes: number
  readonly scanBytes: number
  readonly scanRows: number
  readonly pageRows: number
  readonly pageBytes: number
  readonly retainedCount: number
  readonly retainedBytes: number
  readonly retainedValueBytes: number
}

interface ReferenceScanState {
  rows: number
  scannedBytes: number
  retainedCount: number
  retainedBytes: number
  pages: number
}

interface SessionReferenceInventory {
  readonly sessionID: string
  readonly projectRoot: string
  readonly sessionRoot: string | null
  readonly references: ReadonlyArray<Reference>
}

interface ReferenceEstimate {
  readonly sessionID: string
  readonly bytes: number
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly size: number
    readonly dev: number
    readonly ino: number
    readonly mode: number
    readonly mtimeNs: string
    readonly ctimeNs: string
  }>
}

function sourceManifest(fs: FSUtil.Interface, input: { data: string; config: string }) {
  return Effect.gen(function* () {
    const entries: Array<{ path: string; bytes: number; hash: string }> = []
    const configDocuments: Array<{ name: string; content: string }> = []
    const state = {
      count: 1,
      bytes: 0,
      dependencies: [] as Array<{ readonly name: string; readonly version: string }>,
    }
    const configRoot = yield* Effect.tryPromise({
      try: async () => {
        const info = await lstat(input.config)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Source config root is not a directory")
        return realpath(input.config)
      },
      catch: (cause) => new SourceReadError({ path: input.config, cause }),
    })
    const dataRoot = yield* Effect.tryPromise({
      try: () => realpath(input.data),
      catch: (cause) => new SourceReadError({ path: input.data, cause }),
    })
    const readDirectory = Effect.fnUntraced(function* (directory: string, accept: (entry: Dirent) => boolean) {
      const before = yield* Effect.tryPromise({
        try: () => directoryIdentity(directory, configRoot),
        catch: (cause) => new SourceReadError({ path: directory, cause }),
      })
      const children = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => opendir(directory),
          catch: (cause) => new SourceReadError({ path: directory, cause }),
        }),
        (handle) =>
          Effect.tryPromise({
            try: async () => {
              const accepted: Dirent[] = []
              while (true) {
                const entry = await handle.read()
                if (!entry) return accepted
                if (!accept(entry)) continue
                if (accepted.length >= manifestMaxEntries - state.count) {
                  throw new Error("Source manifest has too many entries")
                }
                accepted.push(entry)
              }
            },
            catch: (cause) => new SourceReadError({ path: directory, cause }),
          }),
        (handle) =>
          Effect.promise(async () => {
            await handle.close()
          }),
      )
      const after = yield* Effect.tryPromise({
        try: () => directoryIdentity(directory, configRoot),
        catch: (cause) => new SourceReadError({ path: directory, cause }),
      })
      if (
        before.canonical !== after.canonical ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtime !== after.mtime
      ) {
        return yield* manifestFailure(directory, "Source manifest directory identity changed")
      }
      return children
    })
    const addFile = Effect.fnUntraced(function* (file: string, relative: string, root: string) {
      state.count++
      if (state.count > manifestMaxEntries) return yield* manifestFailure(file, "Source manifest has too many entries")
      const content = yield* Effect.tryPromise({
        try: () =>
          ProductMigrationFile.readContainedFile({
            file,
            root,
            maxBytes: Math.min(
              manifestMaxBytes - state.bytes,
              relative.startsWith("data/")
                ? ProductMigrationFile.credentialFileMaxBytes
                : ProductMigrationFile.configFileMaxBytes,
            ),
          }).then((result) => result.content),
        catch: (cause) => new SourceReadError({ path: file, cause }),
      })
      if (relative === "config/package.json") {
        const dependencies = yield* Effect.try({
          try: () => registryDependencies(new TextDecoder().decode(content)),
          catch: () => new SourceReadError({ path: file, cause: new Error("Package dependencies are unsupported") }),
        })
        state.dependencies.push(...dependencies)
      }
      if (["config/config.json", "config/opencode.json", "config/opencode.jsonc"].includes(relative)) {
        configDocuments.push({ name: path.basename(relative), content: new TextDecoder().decode(content) })
      }
      state.bytes += content.byteLength
      if (state.bytes > manifestMaxBytes) return yield* manifestFailure(file, "Source manifest exceeds byte limit")
      const normalized = relative.replaceAll(path.sep, "/")
      if (normalized.length > 4_096) return yield* manifestFailure(file, "Source manifest path is too long")
      entries.push({
        path: normalized,
        bytes: content.byteLength,
        hash: createHash("sha256").update(content).digest("hex"),
      })
      return content.byteLength
    })
    const scanDirectory = Effect.fnUntraced(function* (directory: string, relative: string, depth: number) {
      if (depth > manifestMaxDepth) return yield* manifestFailure(directory, "Source manifest exceeds depth limit")
      state.count++
      if (state.count > manifestMaxEntries)
        return yield* manifestFailure(directory, "Source manifest has too many entries")
      const accepted = yield* readDirectory(
        directory,
        (entry) => !ProductMigrationConfigPolicy.isDisposable(entry.name),
      )
      return yield* Effect.forEach(
        accepted.toSorted((left, right) => ordinal(left.name, right.name)),
        (entry): Effect.Effect<number, SourceReadError> => {
          const child = path.join(directory, entry.name)
          const childRelative = path.join(relative, entry.name)
          if (entry.isSymbolicLink()) return manifestFailure(child, "Source manifest contains a symlink")
          if (entry.isDirectory()) return scanDirectory(child, childRelative, depth + 1)
          if (entry.isFile()) return addFile(child, childRelative, configRoot)
          return manifestFailure(child, "Source manifest contains an unsupported entry")
        },
        { concurrency: 1 },
      ).pipe(Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)))
    })
    const acceptedConfigEntries = yield* readDirectory(
      input.config,
      (entry) =>
        ProductMigrationConfigPolicy.manifestRootFiles.has(entry.name) ||
        ProductMigrationConfigPolicy.directories.has(entry.name),
    )
    const configBytes = yield* Effect.forEach(
      acceptedConfigEntries.toSorted((left, right) => ordinal(left.name, right.name)),
      (entry): Effect.Effect<number, SourceReadError> => {
        const target = path.join(input.config, entry.name)
        if (entry.isSymbolicLink()) return manifestFailure(target, "Source manifest contains a symlink")
        if (entry.isDirectory() && ProductMigrationConfigPolicy.directories.has(entry.name)) {
          return scanDirectory(target, path.join("config", entry.name), 1)
        }
        if (entry.isFile() && ProductMigrationConfigPolicy.manifestRootFiles.has(entry.name)) {
          return addFile(target, path.join("config", entry.name), configRoot)
        }
        return manifestFailure(target, "Source manifest entry has an invalid type")
      },
      { concurrency: 1 },
    ).pipe(Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)))
    const optional = (
      name: string,
    ): Effect.Effect<{ readonly exists: boolean; readonly bytes: number }, SourceReadError> =>
      fs
        .existsSafe(path.join(input.data, name))
        .pipe(
          Effect.flatMap(
            (exists): Effect.Effect<{ readonly exists: boolean; readonly bytes: number }, SourceReadError> =>
              exists
                ? addFile(path.join(input.data, name), path.join("data", name), dataRoot).pipe(
                    Effect.map((bytes) => ({ exists, bytes })),
                  )
                : Effect.succeed({ exists, bytes: 0 }),
          ),
        )
    const auth = yield* optional("auth.json")
    const mcp = yield* optional("mcp-auth.json")
    const configPaths = mappedConfigPaths(entries, configDocuments)
    const expectedFile = (name: string) => {
      const entry = entries.find((item) => item.path === name)
      return entry ? { path: path.basename(name), sha256: entry.hash } : null
    }
    return {
      fingerprint: createHash("sha256")
        .update(JSON.stringify(entries.toSorted((left, right) => ordinal(left.path, right.path))))
        .digest("hex"),
      configBytes,
      authBytes: auth.bytes,
      mcpBytes: mcp.bytes,
      configPaths,
      configSources: entries
        .flatMap((entry) => {
          if (!entry.path.startsWith("config/")) return []
          const relative = entry.path.slice("config/".length)
          if (relative === "package.json") return []
          return [{ path: relative, sha256: entry.hash }]
        })
        .toSorted((left, right) => ordinal(left.path, right.path)),
      auth: expectedFile("data/auth.json"),
      mcpAuth: expectedFile("data/mcp-auth.json"),
      dependencies: state.dependencies,
    } satisfies SourceManifest
  })
}

async function directoryIdentity(directory: string, root: string): Promise<DirectoryIdentity> {
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Source manifest entry is not a directory")
  const canonical = await realpath(directory)
  const relative = path.relative(root, canonical)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Source manifest directory escapes the config root")
  }
  return { canonical, dev: info.dev, ino: info.ino, mtime: Math.trunc(info.mtimeMs) }
}

function mappedConfigPaths(
  entries: ReadonlyArray<{ readonly path: string }>,
  documents: ReadonlyArray<{ readonly name: string; readonly content: string }>,
) {
  const paths = new Set(
    entries.flatMap((entry) => {
      if (!entry.path.startsWith("config/")) return []
      const relative = entry.path.slice("config/".length)
      if (["config.json", "opencode.json", "opencode.jsonc", "package.json"].includes(relative)) return []
      return [relative]
    }),
  )
  if (documents.length > 0) paths.add("graph-vibe.json")
  if (!paths.has("tui.json") && !paths.has("tui.jsonc") && documents.some(hasLegacyTuiSettings)) paths.add("tui.json")
  return [...paths].toSorted()
}

function hasLegacyTuiSettings(document: { readonly content: string }) {
  const errors: Parameters<typeof parse>[1] = []
  const value: unknown = parse(document.content, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (typeof config.theme === "string") return true
  if (config.keybinds && typeof config.keybinds === "object" && !Array.isArray(config.keybinds)) return true
  if (!config.tui || typeof config.tui !== "object" || Array.isArray(config.tui)) return false
  const tui = config.tui as Record<string, unknown>
  return (
    typeof tui.scroll_speed === "number" ||
    (tui.scroll_acceleration !== null && typeof tui.scroll_acceleration === "object") ||
    tui.diff_style === "auto" ||
    tui.diff_style === "stacked"
  )
}

function manifestFailure(path: string, message: string) {
  return Effect.fail(new SourceReadError({ path, cause: new Error(message) }))
}

function sessionReferenceInventory(
  sqlite: import("bun:sqlite").Database,
  tables: ReadonlySet<string>,
  sessions: ReadonlyArray<{ readonly id: string; readonly project_id: string; readonly directory: string | null }>,
  projects: ReadonlyArray<{ readonly id: string; readonly worktree: string }>,
) {
  const projectsByID = new Map(projects.map((project) => [project.id, project.worktree]))
  const state = { rows: 0, scannedBytes: 0, retainedCount: 0, retainedBytes: 0, pages: 0 }
  return sessions.map((session): SessionReferenceInventory => {
    const references: Reference[] = []
    const scan = (table: string, column: string, kind: "part" | "message" | "prompt", maxRows: number) => {
      if (!tables.has(table)) return
      scanReferenceRows({
        sqlite,
        table,
        column,
        kind,
        sessionID: session.id,
        maxRows,
        state,
        references,
        limits: referenceLimits,
      })
    }
    scan("part", "data", "part", 500_000)
    scan("session_message", "data", "message", 100_000)
    scan("session_input", "prompt", "prompt", 100_000)
    return {
      sessionID: session.id,
      projectRoot: projectsByID.get(session.project_id) ?? "",
      sessionRoot: session.directory,
      references,
    }
  })
}

export function scanReferenceRows(input: {
  readonly sqlite: import("bun:sqlite").Database
  readonly table: string
  readonly column: string
  readonly kind: "part" | "message" | "prompt"
  readonly sessionID: string
  readonly maxRows: number
  readonly state: ReferenceScanState
  readonly references: Reference[]
  readonly limits: ReferenceLimits
}) {
  if (!/^[a-z_]+$/.test(input.table) || !/^[a-z_]+$/.test(input.column)) {
    throw new Error("Invalid reference inventory identifier")
  }
  const columns = input.sqlite
    .query<{ name: string; pk: number }, []>(`PRAGMA table_info("${input.table}")`)
    .all()
  const id = columns.find((item) => item.name === "id")
  const primary = columns.filter((item) => item.pk > 0)
  if (
    columns.length > 256 ||
    !id ||
    id.pk !== 1 ||
    primary.length !== 1 ||
    !columns.some((item) => item.name === input.column)
  ) {
    throw new Error(`${input.table} reference schema is unsupported`)
  }
  const bounds = preflightTextRows(input.sqlite, {
    table: input.table,
    columns: [
      { name: "id", label: `${input.table}.id`, maxBytes: databaseIDMaxBytes },
      { name: input.column, label: `${input.table}.${input.column}`, maxBytes: input.limits.rowBytes },
    ],
    aggregateMaxBytes: input.limits.scanBytes,
    aggregateLabel: `${input.table} reference scan`,
    filter: { name: "session_id", value: input.sessionID },
  })
  if (bounds.count > input.maxRows) {
    throw new Error(`${input.table} row limit exceeded: ${bounds.count} > ${input.maxRows}`)
  }
  input.state.rows += bounds.count
  input.state.scannedBytes += bounds.bytes
  if (input.state.rows > input.limits.scanRows) throw new Error("Reference discovery row limit exceeded")
  if (input.state.scannedBytes > input.limits.scanBytes) {
    throw new Error("Reference discovery scan byte limit exceeded")
  }

  let cursor: string | null = null
  while (true) {
    const candidates = input.sqlite
      .query<
        { id: string; bytes: number },
        [string, string | null, string | null, number]
      >(`SELECT id, length(CAST(id AS BLOB)) + length(CAST("${input.column}" AS BLOB)) AS bytes
         FROM "${input.table}"
         WHERE session_id = ? AND (? IS NULL OR id COLLATE BINARY > ?)
         ORDER BY id COLLATE BINARY LIMIT ?`)
      .all(input.sessionID, cursor, cursor, input.limits.pageRows)
    if (candidates.length === 0) return
    if (
      candidates.some(
        (row) =>
          typeof row.id !== "string" ||
          !Number.isSafeInteger(row.bytes) ||
          row.bytes < 0 ||
          row.bytes > input.limits.rowBytes + databaseIDMaxBytes,
      )
    ) {
      throw new Error(`${input.table} reference page metadata is invalid`)
    }
    const page = candidates.reduce(
      (result, row) => {
        if (result.full || (result.rows.length > 0 && result.bytes + row.bytes > input.limits.pageBytes)) {
          return { ...result, full: true }
        }
        return { rows: [...result.rows, row], bytes: result.bytes + row.bytes, full: false }
      },
      { rows: [] as Array<{ id: string; bytes: number }>, bytes: 0, full: false },
    )
    const last = page.rows.at(-1)
    if (!last) throw new Error(`${input.table} reference page is empty`)
    const rows = input.sqlite
      .query<
        { id: string; value: string },
        [string, string | null, string | null, string]
      >(`SELECT id, "${input.column}" AS value FROM "${input.table}"
         WHERE session_id = ? AND (? IS NULL OR id COLLATE BINARY > ?)
           AND id COLLATE BINARY <= ? ORDER BY id COLLATE BINARY`)
      .all(input.sessionID, cursor, cursor, last.id)
    if (
      rows.length !== page.rows.length ||
      rows.some((row, index) => row.id !== page.rows[index]?.id || typeof row.value !== "string")
    ) {
      throw new Error(`${input.table} reference payload is corrupt`)
    }
    input.state.pages++
    rows.forEach((row) =>
      extractReferences(row.value, input.kind, (kind, value) => retainReference(input, kind, value)),
    )
    cursor = last.id
  }
}

function retainReference(
  input: {
    readonly state: ReferenceScanState
    readonly references: Reference[]
    readonly limits: ReferenceLimits
  },
  kind: Reference["kind"],
  value: string,
) {
  const bytes = Buffer.byteLength(value)
  if (ProductMigrationFile.referencePath(value).status === "ignored") return
  if (bytes > input.limits.retainedValueBytes) return
  if (input.state.retainedCount + 1 > input.limits.retainedCount) {
    throw new Error("Retained reference count limit exceeded")
  }
  if (input.state.retainedBytes + bytes > input.limits.retainedBytes) {
    throw new Error("Retained reference byte limit exceeded")
  }
  input.state.retainedCount++
  input.state.retainedBytes += bytes
  input.references.push({ kind, value })
}

function extractReferences(
  value: string,
  kind: "part" | "message" | "prompt",
  retain: (kind: Reference["kind"], value: string) => void,
) {
  if (kind === "part") return partReferences(value, retain)
  if (kind === "message") return messageReferences(value, retain)
  return promptReferences(value, retain)
}

function promptReferences(value: string, retain: (kind: Reference["kind"], value: string) => void) {
  const prompt = referenceRecord(value)
  if (!Array.isArray(prompt.files)) return
  prompt.files.forEach((item) => {
    const file = record(item)
    if (file && typeof file.uri === "string") retain("attachment", file.uri)
  })
}

function messageReferences(value: string, retain: (kind: Reference["kind"], value: string) => void) {
  const message = referenceRecord(value)
  if (Array.isArray(message.files)) {
    message.files.forEach((item) => {
      const file = record(item)
      if (file && typeof file.uri === "string") retain("attachment", file.uri)
    })
  }
  if (!Array.isArray(message.content)) return
  message.content.forEach((item) => {
    const content = record(item)
    const state = content?.type === "tool" ? record(content.state) : undefined
    if (state?.status !== "completed") return
    if (Array.isArray(state.outputPaths)) {
      state.outputPaths.forEach((output) => {
        if (typeof output === "string") retain("output", output)
      })
    }
    if (Array.isArray(state.attachments)) {
      state.attachments.forEach((item) => {
        const attachment = record(item)
        if (attachment && typeof attachment.uri === "string") retain("attachment", attachment.uri)
      })
    }
  })
}

function partReferences(value: string, retain: (kind: Reference["kind"], value: string) => void) {
  const part = referenceRecord(value)
  if (part.type === "file" && typeof part.url === "string") retain("attachment", part.url)
  const state = part.type === "tool" ? record(part.state) : undefined
  if (state?.status !== "completed" || !Array.isArray(state.attachments)) return
  state.attachments.forEach((item) => {
    const attachment = record(item)
    if (attachment && typeof attachment.url === "string") retain("attachment", attachment.url)
  })
}

function referenceRecord(value: string) {
  const parsed = decodeReferenceJson(value)
  const result = Option.isSome(parsed) ? record(parsed.value) : undefined
  if (!result) throw new Error("Session reference payload is invalid")
  return result
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function referenceEstimates(data: string, inventory: ReadonlyArray<SessionReferenceInventory>) {
  return Effect.gen(function* () {
    const directories = yield* Effect.tryPromise({
      try: async () => ({
        attachment: await ProductMigrationFile.resolveDirectory(path.join(data, "attachments")),
        output: await ProductMigrationFile.resolveDirectory(path.join(data, "tool-output")),
      }),
      catch: (cause) => cause,
    })
    return yield* Effect.forEach(
      inventory,
      (session) =>
        Effect.tryPromise({
          try: async (): Promise<ReferenceEstimate> => {
            const attachmentRoots = [
              directories.attachment,
              await ProductMigrationFile.resolveDirectory(session.projectRoot),
              ...(session.sessionRoot ? [await ProductMigrationFile.resolveDirectory(session.sessionRoot)] : []),
            ].filter((root): root is string => root !== undefined)
            const files = new Map<string, ReferenceEstimate["files"][number]>()
            for (const reference of session.references) {
              const roots =
                reference.kind === "output"
                  ? [directories.output].filter((root): root is string => !!root)
                  : attachmentRoots
              const inspected = await ProductMigrationFile.inspectReference({
                reference: reference.value,
                roots,
                maxBytes: ProductMigrationFile.referencedFileMaxBytes,
              })
              if (inspected.status !== "accepted") continue
              files.set(inspected.canonical, {
                path: inspected.canonical,
                size: inspected.size,
                dev: inspected.dev,
                ino: inspected.ino,
                mode: inspected.mode,
                mtimeNs: inspected.mtimeNs,
                ctimeNs: inspected.ctimeNs,
              })
            }
            const selected = [...files.values()].toSorted((left, right) => ordinal(left.path, right.path))
            const bytes = selected.reduce((total, file) => total + file.size, 0)
            if (bytes > ProductMigrationFile.referencedSessionMaxBytes) {
              throw new Error("Session referenced files exceed byte limit")
            }
            return { sessionID: session.sessionID, bytes, files: selected }
          },
          catch: (cause) => cause,
        }),
      { concurrency: referenceConcurrency },
    )
  })
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const { Database } = yield* Effect.promise(() => import("bun:sqlite"))

    return Service.of({
      discover: Effect.fn("ProductMigrationSource.discover")(function* (input) {
        const requested = input.database ?? path.join(input.data, "opencode.db")
        if (!(yield* fs.existsSafe(requested))) return yield* new SourceNotFound({ path: requested })
        const database = yield* fs
          .realPath(requested)
          .pipe(Effect.mapError((cause) => new SourceReadError({ path: requested, cause })))
        const readSnapshot = (copy: ProductMigrationSnapshot.Snapshot) =>
          Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                return openReadTransaction(() => new Database(copy.database, { readonly: true, strict: true }))
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
                  const projectBounds = preflightTextRows(sqlite, {
                    table: "project",
                    columns: [
                      { name: "id", label: "project.id", maxBytes: databaseIDMaxBytes },
                      { name: "worktree", label: "project.worktree", maxBytes: databasePathMaxBytes },
                    ],
                    aggregateMaxBytes: databaseInventoryMaxBytes,
                    aggregateLabel: "project aggregate",
                  })
                  const projectCount = projectBounds.count
                  if (!Number.isSafeInteger(projectCount) || projectCount < 0 || projectCount > databaseMaxProjects) {
                    throw new Error("OpenCode project inventory exceeds the supported limit")
                  }
                  const sessionColumns = new Set(
                    sqlite
                      .query<{ name: string }, []>("PRAGMA table_info(session)")
                      .all()
                      .map((column) => column.name),
                  )
                  const sessionBounds = preflightTextRows(sqlite, {
                    table: "session",
                    columns: [
                      { name: "id", label: "session.id", maxBytes: databaseIDMaxBytes },
                      { name: "project_id", label: "session.project_id", maxBytes: databaseIDMaxBytes },
                      { name: "title", label: "session.title", maxBytes: databaseTitleMaxBytes },
                      { name: "time_updated", label: "session.time_updated", maxBytes: 32 },
                      ...(sessionColumns.has("time_archived")
                        ? [{ name: "time_archived", label: "session.time_archived", maxBytes: 32 }]
                        : []),
                      ...(sessionColumns.has("directory")
                        ? [{ name: "directory", label: "session.directory", maxBytes: databasePathMaxBytes }]
                        : []),
                    ],
                    aggregateMaxBytes: databaseInventoryMaxBytes,
                    aggregateLabel: "session aggregate",
                  })
                  const sessionCount = sessionBounds.count
                  if (!Number.isSafeInteger(sessionCount) || sessionCount < 0 || sessionCount > databaseMaxSessions) {
                    throw new Error("OpenCode session inventory exceeds the supported limit")
                  }
                  const sessions = sqlite
                    .query<
                      {
                        id: string
                        project_id: string
                        title: string
                        time_updated: number
                        time_archived: number | null
                        directory: string | null
                      },
                      []
                    >(
                      `SELECT id, project_id, title, time_updated,
                                ${sessionColumns.has("time_archived") ? "time_archived" : "NULL"} AS time_archived,
                                ${sessionColumns.has("directory") ? "directory" : "NULL"} AS directory
                         FROM session ORDER BY time_updated DESC, id`,
                    )
                    .all()
                  const graphSessions = tables.has("graph_node")
                    ? new Set(
                        sqlite
                          .query<{ session_id: string }, [number]>(
                            `SELECT DISTINCT graph_node.session_id
                           FROM graph_node
                           INNER JOIN session ON session.id = graph_node.session_id
                           WHERE graph_node.session_id IS NOT NULL
                           LIMIT ?`,
                          )
                          .all(databaseMaxSessions + 1)
                          .map((row) => row.session_id),
                      )
                    : new Set<string>()
                  const projectRows = sqlite
                    .query<{ id: string; worktree: string }, []>("SELECT id, worktree FROM project ORDER BY id")
                    .all()
                  if (
                    projectRows.some(
                      (project) => typeof project.id !== "string" || typeof project.worktree !== "string",
                    ) ||
                    sessions.some(
                      (session) =>
                        typeof session.id !== "string" ||
                        typeof session.project_id !== "string" ||
                        typeof session.title !== "string" ||
                        !Number.isFinite(session.time_updated) ||
                        (session.time_archived !== null && !Number.isFinite(session.time_archived)) ||
                        (session.directory !== null && typeof session.directory !== "string"),
                    )
                  ) {
                    throw new Error("OpenCode database inventory is corrupt")
                  }
                  const projectsByID = new Set(projectRows.map((project) => project.id))
                  if (sessions.some((session) => !projectsByID.has(session.project_id))) {
                    throw new Error("OpenCode session inventory references a missing project")
                  }
                  const sessionsByProject = new Map<string, typeof sessions>()
                  sessions.forEach((session) => {
                    const selected = sessionsByProject.get(session.project_id) ?? []
                    selected.push(session)
                    sessionsByProject.set(session.project_id, selected)
                  })
                  const projects = projectRows.map((project): ProjectSummary => {
                    const selected = sessionsByProject.get(project.id) ?? []
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
                        archived: session.time_archived !== null,
                      })),
                    }
                  })
                  const credentialCount = tables.has("credential")
                    ? (sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM credential").get()?.count ??
                      0)
                    : 0
                  if (
                    !Number.isSafeInteger(credentialCount) ||
                    credentialCount < 0 ||
                    credentialCount > databaseMaxCredentials
                  ) {
                    throw new Error("OpenCode credential inventory exceeds the supported limit")
                  }
                  const credentialIDs = tables.has("credential")
                    ? (() => {
                        preflightTextRows(sqlite, {
                          table: "credential",
                          columns: [{ name: "id", label: "credential.id", maxBytes: databaseIDMaxBytes }],
                          aggregateMaxBytes: databaseInventoryMaxBytes,
                          aggregateLabel: "credential id aggregate",
                        })
                        return sqlite
                          .query<{ id: string }, []>("SELECT id FROM credential ORDER BY id")
                          .all()
                          .map((row) => row.id)
                      })()
                    : []
                  if (credentialIDs.some((id) => typeof id !== "string" || id.length > 256)) {
                    throw new Error("OpenCode credential inventory is corrupt")
                  }
                  return {
                    tables,
                    projects,
                    sessions,
                    credentialCount,
                    credentialIDs,
                    identity: copy.identity,
                    references: sessionReferenceInventory(sqlite, tables, sessions, projectRows),
                  }
                },
                catch: (cause) => new SourceReadError({ path: database, cause }),
              }),
            (sqlite) =>
              Effect.sync(() => {
                sqlite.close(false)
              }),
          )
        const snapshot = yield* (
          input.snapshot
            ? readSnapshot(input.snapshot)
            : ProductMigrationSnapshot.use(
                {
                  database,
                  directory: input.snapshotDirectory,
                },
                readSnapshot,
              )
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof SourceReadError ? cause : new SourceReadError({ path: database, cause }),
          ),
        )
        const estimates = yield* referenceEstimates(input.data, snapshot.references).pipe(
          Effect.mapError((cause) => new SourceReadError({ path: input.data, cause })),
        )
        const estimatesBySession = new Map(estimates.map((estimate) => [estimate.sessionID, estimate]))
        const manifest = yield* sourceManifest(fs, input)
        const expected: ExpectedInventory = {
          configPaths: manifest.configPaths,
          configSources: manifest.configSources,
          auth: manifest.auth,
          mcpAuth: manifest.mcpAuth,
          dependencies: manifest.dependencies,
          credentialIDs: snapshot.credentialIDs,
        }
        const expectedFingerprint = createHash("sha256").update(JSON.stringify(expected)).digest("hex")
        const databaseBytes = snapshot.identity.size
        const databaseFingerprint = fingerprint({
          database,
          databaseBytes,
          sessionCount: snapshot.sessions.length,
          identity: snapshot.identity,
        })
        const sourceFingerprint = fingerprint({
          database,
          databaseBytes,
          sessionCount: snapshot.sessions.length,
          identity: snapshot.identity,
          manifestFingerprint: `${manifest.fingerprint}\0${expectedFingerprint}\0${createHash("sha256")
            .update(JSON.stringify(estimates))
            .digest("hex")}`,
        })
        const categories: Array<CategorySummary & { category: ProductMigration.Category }> = [
          { category: "config", available: manifest.configBytes > 0, estimatedBytes: manifest.configBytes },
          {
            category: "credentials",
            available: manifest.authBytes > 0 || snapshot.credentialCount > 0,
            estimatedBytes: manifest.authBytes,
          },
          { category: "mcp", available: manifest.mcpBytes > 0, estimatedBytes: manifest.mcpBytes },
        ]
        return {
          sourceFingerprint,
          databaseFingerprint,
          database,
          databaseBytes,
          mixedGraph: snapshot.tables.has("graph_node"),
          sessionCount: snapshot.sessions.length,
          categories,
          expected,
          projects: snapshot.projects.map((project) => ({
            ...project,
            estimatedBytes: Math.floor(databaseBytes / Math.max(snapshot.projects.length, 1)),
            sessions: project.sessions.map((session) => ({
              ...session,
              estimatedBytes:
                Math.floor(databaseBytes / Math.max(snapshot.sessions.length, 1)) +
                (estimatesBySession.get(session.id)?.bytes ?? 0),
            })),
          })),
        }
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })
