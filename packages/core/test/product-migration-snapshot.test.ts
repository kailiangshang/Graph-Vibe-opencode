import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, rename, rm, symlink, truncate } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { ProductMigrationSnapshot } from "@opencode-ai/core/product-migration/snapshot"
import { tmpdir } from "./fixture/tmpdir"

const sqlite = await import("bun:sqlite")

test("enforces exact private directory modes only on POSIX platforms", () => {
  expect(ProductMigrationSnapshot.enforcesPosixDirectoryPermissions("linux")).toBe(true)
  expect(ProductMigrationSnapshot.enforcesPosixDirectoryPermissions("darwin")).toBe(true)
  expect(ProductMigrationSnapshot.enforcesPosixDirectoryPermissions("win32")).toBe(false)
})

test("reads committed WAL rows from one private snapshot artifact without changing source DB or WAL", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const snapshots = path.join(tmp.path, "snapshots")
  const database = path.join(source, "opencode.db")
  await Promise.all([mkdir(source), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)")
  writer.run("INSERT INTO item VALUES ('wal-only', 'visible')")
  const before = await sourceState(database)

  const result = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, (snapshot) =>
      Effect.promise(async () => {
        const reader = new sqlite.Database(snapshot.database, { readonly: true, strict: true })
        const rows = reader.query<{ id: string; value: string }, []>("SELECT id, value FROM item ORDER BY id").all()
        reader.close(false)
        return {
          database: snapshot.database,
          identity: snapshot.identity,
          directoryMode: (await lstat(path.dirname(snapshot.database))).mode & 0o7777,
          databaseMode: (await lstat(snapshot.database)).mode & 0o7777,
          files: await readdir(path.dirname(snapshot.database)),
          rows,
        }
      }),
    ),
  )

  expect(result.database).not.toBe(database)
  expect(result.identity.version).toBe(1)
  expect(result.identity.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.directoryMode).toBe(0o700)
  expect(result.databaseMode).toBe(0o600)
  expect(result.files).toEqual(["opencode.db"])
  expect(result.rows).toEqual([{ id: "wal-only", value: "visible" }])
  expect(await sourceState(database)).toEqual(before)
  expect(await readdir(snapshots)).toEqual([])
  writer.close(false)
})

test("excludes an open writer transaction and leaves the writer usable", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
  writer.run("INSERT INTO item VALUES ('committed', 'visible')")
  writer.run("BEGIN IMMEDIATE")
  writer.run("INSERT INTO item VALUES ('uncommitted', 'contradiction')")

  const rows = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, (snapshot) =>
      Effect.sync(() => {
        const reader = new sqlite.Database(snapshot.database, { readonly: true, strict: true })
        const result = reader.query<{ id: string; value: string }, []>("SELECT id, value FROM item ORDER BY id").all()
        reader.close(false)
        return result
      }),
    ),
  )

  expect(rows).toEqual([{ id: "committed", value: "visible" }])
  writer.run("COMMIT")
  writer.run("INSERT INTO item VALUES ('after', 'usable')")
  expect(writer.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM item").get()?.count).toBe(3)
  expect(await readdir(snapshots)).toEqual([])
  writer.close(false)
})

test("returns typed changed and cleans the snapshot when a commit occurs during use", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY)")

  const error = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, () =>
      Effect.sync(() => writer.run("INSERT INTO item VALUES ('committed-during-use')")),
    ).pipe(Effect.flip),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationSnapshotError", reason: "changed" })
  expect(await readdir(snapshots)).toEqual([])
  writer.close(false)
})

test("cleans the snapshot when use is interrupted", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY)")

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* ProductMigrationSnapshot.use({ database, directory: snapshots }, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }),
  )

  expect(await readdir(snapshots)).toEqual([])
  writer.close(false)
})

test("reports snapshot release failures through the typed error channel", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY)")

  const exit = await Effect.runPromise(
    Effect.exit(
      ProductMigrationSnapshot.use({ database, directory: snapshots }, () =>
        Effect.promise(() => chmod(snapshots, 0o500)),
      ),
    ),
  )
  await chmod(snapshots, 0o700)

  expect(Exit.isFailure(exit)).toBe(true)
  const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
  expect(error).toBeInstanceOf(ProductMigrationSnapshot.SnapshotError)
  expect(error && "reason" in error ? error.reason : undefined).toBe("unreadable")
  await readdir(snapshots).then((entries) =>
    Promise.all(entries.map((entry) => rm(path.join(snapshots, entry), { recursive: true, force: true }))),
  )
  writer.close(false)
})

test("rejects source replacement while retaining the opened source identity", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const replacement = path.join(tmp.path, "replacement.db")
  const original = path.join(tmp.path, "original.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY)")
  const next = new sqlite.Database(replacement, { create: true })
  next.run("CREATE TABLE item (id TEXT PRIMARY KEY)")
  next.close(false)

  const error = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, () =>
      Effect.promise(async () => {
        await rename(database, original)
        await rename(replacement, database)
      }),
    ).pipe(Effect.flip),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationSnapshotError", reason: "changed" })
  expect(await readdir(snapshots)).toEqual([])
  writer.close(false)
})

test("rejects a source replacement during generation instead of retrying against the replacement", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const replacement = path.join(tmp.path, "replacement.db")
  const original = path.join(tmp.path, "original.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("CREATE TABLE marker (value TEXT NOT NULL)")
  writer.run("INSERT INTO marker VALUES ('original')")
  writer.run("CREATE TABLE payload (value BLOB NOT NULL)")
  writer.run("INSERT INTO payload VALUES (zeroblob(67108864))")
  writer.close(false)
  const next = new sqlite.Database(replacement, { create: true })
  next.run("CREATE TABLE marker (value TEXT NOT NULL)")
  next.run("INSERT INTO marker VALUES ('replacement')")
  next.close(false)
  const swapped = waitForEntry(snapshots).then(async () => {
    await rename(database, original)
    await rename(replacement, database)
  })

  const exit = await Effect.runPromise(
    Effect.exit(
      ProductMigrationSnapshot.use({ database, directory: snapshots }, (snapshot) =>
        Effect.sync(() => {
          const reader = new sqlite.Database(snapshot.database, { readonly: true, strict: true })
          const value = reader.query<{ value: string }, []>("SELECT value FROM marker").get()?.value
          reader.close(false)
          return value
        }),
      ),
    ),
  )
  await swapped

  expect(Exit.isFailure(exit)).toBe(true)
  const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
  expect(error).toBeInstanceOf(ProductMigrationSnapshot.SnapshotError)
  expect(error && "reason" in error ? error.reason : undefined).toBe("changed")
  expect(await readdir(snapshots)).toEqual([])
})

test("rejects a symlink source", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "source.db")
  const database = path.join(tmp.path, "linked.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await mkdir(snapshots)
  const writer = new sqlite.Database(target, { create: true })
  writer.run("CREATE TABLE item (id TEXT PRIMARY KEY)")
  writer.close(false)
  await symlink(target, database)

  const error = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, () => Effect.void).pipe(Effect.flip),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationSnapshotError", reason: "unreadable" })
  expect(await readdir(snapshots)).toEqual([])
})

test("rejects a source above the 16 GiB DB and WAL snapshot limit without leaving temporary files", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  await Bun.write(database, "")
  await truncate(database, 16 * 1024 * 1024 * 1024 + 1)

  const error = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, () => Effect.void).pipe(Effect.flip),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationSnapshotError", reason: "unreadable" })
  expect(await readdir(snapshots)).toEqual([])
})

test("rejects a symlink snapshot root", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const target = path.join(tmp.path, "target")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(target)])
  await symlink(target, snapshots)
  const writer = new sqlite.Database(database, { create: true })
  writer.run("CREATE TABLE item (id INTEGER PRIMARY KEY)")
  writer.close(false)

  const error = await Effect.runPromise(
    ProductMigrationSnapshot.use({ database, directory: snapshots }, () => Effect.void).pipe(Effect.flip),
  )

  expect(error).toMatchObject({ _tag: "ProductMigrationSnapshotError", reason: "unreadable" })
  expect(await readdir(target)).toEqual([])
})

test("an active writer race returns a consistent snapshot or typed changed", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "source", "opencode.db")
  const snapshots = path.join(tmp.path, "snapshots")
  await Promise.all([mkdir(path.dirname(database)), mkdir(snapshots)])
  const writer = new sqlite.Database(database, { create: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("PRAGMA wal_autocheckpoint = 0")
  writer.run("CREATE TABLE revision (value INTEGER NOT NULL)")
  writer.run("CREATE TABLE item (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL)")
  writer.run("INSERT INTO revision VALUES (0)")
  const insert = writer.query("INSERT INTO item VALUES (?, 0, zeroblob(1048576))")
  Array.from({ length: 32 }, (_, id) => insert.run(id))
  const mutation = (async () => {
    for (const revision of Array.from({ length: 20 }, (_, index) => index + 1)) {
      writer.transaction(() => {
        writer.run("UPDATE revision SET value = ?", [revision])
        writer.run("UPDATE item SET revision = ?", [revision])
      })()
      await Bun.sleep(1)
    }
  })()

  const exit = await Effect.runPromise(
    Effect.exit(
      ProductMigrationSnapshot.use({ database, directory: snapshots }, (snapshot) =>
        Effect.sync(() => {
          const reader = new sqlite.Database(snapshot.database, { readonly: true, strict: true })
          const revision = reader.query<{ value: number }, []>("SELECT value FROM revision").get()?.value
          const mixed = reader
            .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM item WHERE revision != ?")
            .get(revision ?? -1)?.count
          reader.close(false)
          return { revision, mixed }
        }),
      ),
    ),
  )
  await mutation
  writer.close(false)

  if (Exit.isSuccess(exit)) expect(exit.value.mixed).toBe(0)
  else {
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    expect(error).toBeInstanceOf(ProductMigrationSnapshot.SnapshotError)
    expect(error && "reason" in error ? error.reason : undefined).toBe("changed")
  }
  expect(await readdir(snapshots)).toEqual([])
})

async function sourceState(database: string) {
  return Promise.all(
    [database, `${database}-wal`].map(async (file) => {
      const info = await lstat(file, { bigint: true })
      const content = await Bun.file(file).bytes()
      return {
        file: path.basename(file),
        dev: info.dev.toString(),
        ino: info.ino.toString(),
        mode: Number(info.mode & 0o7777n),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString(),
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      }
    }),
  )
}

async function waitForEntry(directory: string) {
  const deadline = Date.now() + 5_000
  while ((await readdir(directory)).length === 0) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for snapshot generation")
    await Bun.sleep(1)
  }
}
