export * as ProductMigrationSnapshot from "./snapshot"

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"

const chunkBytes = 256 * 1024
const maximumBytes = 16 * 1024 * 1024 * 1024
const attempts = 3
const hashDomain = "graph-vibe-product-migration-sqlite-snapshot\0v1\0"

export interface DatabaseIdentity {
  readonly version: 1
  readonly size: number
  readonly sha256: string
}

export interface Snapshot {
  readonly database: string
  readonly identity: DatabaseIdentity
}

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()("ProductMigrationSnapshotError", {
  path: Schema.String,
  reason: Schema.Literals(["changed", "unreadable"]),
  cause: Schema.Defect(),
}) {}

interface SourceIdentity {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
}

interface OpenedSource {
  readonly handle: FileHandle
  readonly identity: SourceIdentity
  readonly sqlite: import("bun:sqlite").Database
  readonly dataVersion: number
}

interface Resource extends Snapshot {
  readonly source: OpenedSource
  readonly directory: string
}

class SourceChanged extends Error {}

export function use<A, E, R>(
  input: { readonly database: string; readonly directory?: string },
  f: (snapshot: Snapshot) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SnapshotError, R> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => create(input),
      catch: (cause) => snapshotError(input.database, cause),
    }),
    (snapshot) =>
      f(snapshot).pipe(
        Effect.tap(() =>
          Effect.tryPromise({
            try: () => verify(snapshot),
            catch: (cause) => snapshotError(input.database, cause),
          }),
        ),
      ),
    (snapshot) =>
      Effect.tryPromise({
        try: () => release(snapshot),
        catch: (cause) => snapshotError(input.database, cause),
      }),
  )
}

export async function databaseIdentity(database: string): Promise<DatabaseIdentity> {
  const snapshot = await create({ database })
  return release(snapshot).then(() => snapshot.identity)
}

export function sameDatabaseIdentity(left: DatabaseIdentity, right: DatabaseIdentity) {
  return left.version === right.version && left.size === right.size && left.sha256 === right.sha256
}

async function create(input: { readonly database: string; readonly directory?: string }): Promise<Resource> {
  const source = await canonicalSource(input.database)
  const root = await prepareRoot(input.directory ?? path.join(os.tmpdir(), "graph-vibe"), source.path)
  return retryChanged(() => createAttempt(source, root))
}

async function createAttempt(identity: SourceIdentity, root: string): Promise<Resource> {
  const source = await openSource(identity)
  let directory: string | undefined
  try {
    directory = await createDirectory(root)
    const target = path.join(directory, path.basename(identity.path))
    source.sqlite.run("VACUUM INTO ?", [target])
    await chmod(target, 0o600)
    const snapshot = await snapshotIdentity(target)
    await verifySource(source)
    return { database: target, identity: snapshot, source, directory }
  } catch (cause) {
    const cleanup = await Promise.allSettled([closeSource(source), ...(directory ? [remove(directory)] : [])])
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
    throw cause
  }
}

async function openSource(identity: SourceIdentity): Promise<OpenedSource> {
  const handle = await open(identity.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((cause) => {
    if (hasCode(cause, "ENOENT") || hasCode(cause, "ELOOP")) {
      throw new SourceChanged("Source database identity changed before opening")
    }
    throw cause
  })
  let sqlite: import("bun:sqlite").Database | undefined
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new Error("Source database is not a regular file")
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) {
      throw new SourceChanged("Source database identity changed before opening")
    }
    if (opened.size > BigInt(maximumBytes)) throw new Error("Source database snapshot exceeds the 16 GiB limit")
    await preflightWal(identity.path, opened.size)
    const { Database } = await import("bun:sqlite")
    await verifyPathIdentity(identity, handle)
    // Bun opens SQLite by pathname and exposes no database fd, so bracket its constructor with inode checks.
    sqlite = new Database(identity.path, { readonly: true, strict: true })
    await verifyPathIdentity(identity, handle)
    const source = {
      handle,
      identity,
      sqlite,
      dataVersion: readDataVersion(sqlite),
    }
    return source
  } catch (cause) {
    const changed = await verifyPathIdentity(identity, handle).then(
      () => undefined,
      (failure) => failure,
    )
    await Promise.allSettled([
      ...(sqlite ? [Promise.resolve(sqlite).then((database) => database.close(false))] : []),
      handle.close(),
    ])
    if (changed) throw changed
    throw cause
  }
}

async function preflightWal(database: string, databaseBytes: bigint) {
  const wal = await lstat(`${database}-wal`, { bigint: true }).then(
    (value) => value,
    (cause) => {
      if (hasCode(cause, "ENOENT")) return undefined
      throw cause
    },
  )
  if (!wal) return
  if (wal.isSymbolicLink() || !wal.isFile()) throw new Error("Source WAL is not a regular file")
  if (databaseBytes + wal.size > BigInt(maximumBytes)) {
    throw new Error("Source database snapshot exceeds the 16 GiB limit")
  }
}

async function snapshotIdentity(database: string): Promise<DatabaseIdentity> {
  const handle = await open(database, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error("SQLite snapshot is not a regular file")
    if (before.size > BigInt(maximumBytes)) throw new Error("SQLite snapshot exceeds the 16 GiB limit")
    const hash = createHash("sha256").update(hashDomain)
    const buffer = Buffer.allocUnsafe(chunkBytes)
    let size = 0
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
      if (size > maximumBytes) throw new Error("SQLite snapshot exceeds the 16 GiB limit")
      hash.update(buffer.subarray(0, result.bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    if (!sameOpenedFile(before, after) || size !== Number(after.size)) {
      throw new SourceChanged("SQLite snapshot changed while hashing")
    }
    return { version: 1, size, sha256: hash.digest("hex") }
  } finally {
    await handle.close()
  }
}

async function verify(snapshot: Resource) {
  await verifySource(snapshot.source)
}

async function verifySource(source: OpenedSource) {
  await verifyPathIdentity(source.identity, source.handle)
  if (readDataVersion(source.sqlite) !== source.dataVersion) {
    throw new SourceChanged("Source database changed while using the snapshot")
  }
}

async function verifyPathIdentity(identity: SourceIdentity, handle: FileHandle) {
  const [opened, current] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(identity.path, { bigint: true }).catch((cause) => {
      if (hasCode(cause, "ENOENT")) throw new SourceChanged("Source database path disappeared")
      throw cause
    }),
  ])
  if (
    !opened.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    opened.dev !== identity.dev ||
    opened.ino !== identity.ino ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new SourceChanged("Source database identity changed")
  }
}

function readDataVersion(sqlite: import("bun:sqlite").Database) {
  const value = sqlite.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) throw new Error("Invalid SQLite data version")
  return value
}

async function canonicalSource(database: string) {
  const before = await lstat(database, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Source database is not a regular file")
  const canonical = await realpath(database)
  const after = await lstat(canonical, { bigint: true })
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new SourceChanged("Source database identity changed")
  }
  return { path: canonical, dev: after.dev, ino: after.ino, size: after.size }
}

async function prepareRoot(directory: string, database: string) {
  const enforce = enforcesPosixDirectoryPermissions(process.platform)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const before = await lstat(directory)
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("Snapshot root is not a regular directory")
  if (enforce && typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("Snapshot root is owned by another user")
  }
  if (enforce) await chmod(directory, 0o700)
  const root = await realpath(directory)
  const after = await lstat(root)
  if (!after.isDirectory() || (enforce && (after.mode & 0o7777) !== 0o700) || !sameStat(before, after)) {
    throw new Error("Snapshot root identity changed")
  }
  if (overlaps(path.dirname(database), root)) throw new Error("Snapshot storage overlaps the source database")
  return root
}

async function createDirectory(root: string) {
  const directory = await mkdtemp(path.join(root, "product-migration-source-"))
  try {
    const enforce = enforcesPosixDirectoryPermissions(process.platform)
    if (enforce) await chmod(directory, 0o700)
    const canonical = await realpath(directory)
    const info = await lstat(canonical)
    if (
      canonical !== directory ||
      !inside(root, canonical) ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (enforce && (info.mode & 0o7777) !== 0o700) ||
      (enforce && typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new Error("Snapshot directory is not private")
    }
    return canonical
  } catch (cause) {
    await remove(directory)
    throw cause
  }
}

export function enforcesPosixDirectoryPermissions(platform: NodeJS.Platform) {
  return platform !== "win32"
}

async function closeSource(source: OpenedSource) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => source.sqlite.close(false)),
    source.handle.close(),
  ])
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

async function release(snapshot: Resource) {
  const results = await Promise.allSettled([closeSource(snapshot.source), remove(snapshot.directory)])
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

function sameOpenedFile(
  left: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint },
  right: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint },
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function sameStat(
  left: { readonly dev: number; readonly ino: number; readonly size: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number },
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

async function retryChanged<A>(f: () => Promise<A>, attempt = 0): Promise<A> {
  try {
    return await f()
  } catch (cause) {
    if (cause instanceof SourceChanged && attempt + 1 < attempts) return retryChanged(f, attempt + 1)
    throw cause
  }
}

async function remove(directory: string, retries = 20): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(async (cause) => {
    if (retries === 0 || !["EBUSY", "ENOTEMPTY", "EPERM"].some((code) => hasCode(cause, code))) throw cause
    await chmod(directory, 0o700).catch(() => undefined)
    await Bun.sleep(25)
    return remove(directory, retries - 1)
  })
}

function overlaps(left: string, right: string) {
  return inside(left, right) || inside(right, left)
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function hasCode(value: unknown, code: string): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value && value.code === code
}

function snapshotError(path: string, cause: unknown) {
  return new SnapshotError({ path, reason: cause instanceof SourceChanged ? "changed" : "unreadable", cause })
}
