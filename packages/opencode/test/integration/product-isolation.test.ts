import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

const runtimeScript = String.raw`
  const path = await import("node:path")
  const { createHash } = await import("node:crypto")
  const { lstat, readdir } = await import("node:fs/promises")
  const { pathToFileURL } = await import("node:url")
  const { NodeFileSystem } = await import("@effect/platform-node")
  const { Effect } = await import("effect")
  const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Global } = await import("@opencode-ai/core/global")
  const { Product } = await import("@opencode-ai/core/product")
  const { Daemon } = await import("../cli/src/services/daemon")
  const { PluginMeta } = await import("./src/plugin/meta")

  const marker = process.env.RUNTIME_MARKER
  if (!marker) throw new Error("Missing runtime marker")
  if (process.env.RUNTIME_FAIL === marker) throw new Error("Requested runtime failure")
  const barrier = process.env.RUNTIME_BARRIER
  if (!barrier) throw new Error("Missing runtime barrier")
  const roots = JSON.parse(process.env.RUNTIME_ROOTS ?? "{}")
  const other = marker === "opencode" ? "graph-vibe" : "opencode"
  const waitFor = async (name) => {
    const file = path.join(barrier, name)
    const deadline = Date.now() + 60_000
    while (!(await Bun.file(file).exists())) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for " + name)
      await Bun.sleep(10)
    }
  }
  const rendezvous = async (phase) => {
    await Bun.write(path.join(barrier, marker + "." + phase), String(Date.now()))
    await waitFor(other + "." + phase)
  }
  const rootManifest = async () => {
    const inspect = async (label, target, relative) => {
      const info = await lstat(target)
      const entry = {
        path: label + ":" + relative.replaceAll(path.sep, "/"),
        mode: info.mode & 0o7777,
        bytes: info.size,
      }
      if (info.isDirectory()) {
        const children = await readdir(target)
        return [
          { ...entry, type: "directory", sha256: null },
          ...(await Promise.all(children.toSorted().map((child) =>
            inspect(label, path.join(target, child), relative === "." ? child : path.join(relative, child)),
          ))).flat(),
        ]
      }
      if (!info.isFile()) return [{ ...entry, type: "other", sha256: null }]
      return [{
        ...entry,
        type: "file",
        sha256: createHash("sha256").update(await Bun.file(target).bytes()).digest("hex"),
      }]
    }
    return (await Promise.all(Object.entries(roots).map(([label, root]) => inspect(label, root, "."))))
      .flat()
      .toSorted((left, right) => left.path.localeCompare(right.path))
  }
  const profile = Product.current()
  const database = Database.path()
  await rendezvous("initialized")
  const initializedManifest = await rootManifest()
  const beforeMutation = await rootManifest()
  await rendezvous("before-mutation")
  let startedAt = 0

  const databaseState = await Effect.runPromise(
    Database.Service.use(({ db }) =>
      Effect.gen(function* () {
        yield* db.run("CREATE TABLE runtime_marker (value TEXT NOT NULL)")
        yield* db.run("INSERT INTO runtime_marker VALUES ('" + marker + "')")
        startedAt = Date.now()
        yield* Effect.promise(() => rendezvous("mutation-started"))
        const tables = yield* db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        const tableRows = yield* Effect.forEach(tables, (table) =>
          db.get('SELECT COUNT(*) AS count FROM "' + table.name.replaceAll('"', '""') + '"').pipe(
            Effect.map((row) => ({ name: table.name, rows: row?.count ?? 0 })),
          ),
        )
        const markers = yield* db.all("SELECT value FROM runtime_marker ORDER BY value")
        const integrity = yield* db.get("PRAGMA integrity_check")
        const foreignKeys = yield* db.all("PRAGMA foreign_key_check")
        return {
          wal: database + "-wal",
          walBytes: Bun.file(database + "-wal").size,
          summary: {
            tables: tableRows,
            markers: markers.map((row) => row.value),
            integrity: integrity?.integrity_check ?? "missing",
            foreignKeyViolations: foreignKeys.length,
          },
        }
      }),
    ).pipe(Effect.provide(AppNodeBuilder.build(Database.node))),
  )

  const daemon = await Effect.runPromise(
    Effect.scoped(
      Daemon.Service.use((service) =>
        Effect.gen(function* () {
          yield* service.password(marker)
          const password = yield* Effect.promise(async () => {
            const files = [...new Bun.Glob("**/*").scanSync({ cwd: Global.Path.state, onlyFiles: true })]
            for (const relative of files) {
              const file = path.join(Global.Path.state, relative)
              if (await Bun.file(file).text().catch(() => "") === marker) return file
            }
            throw new Error("Daemon password path was not observed")
          })
          yield* service.register({ _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 })
          const registration = yield* Effect.promise(async () => {
            const files = [...new Bun.Glob("**/*.json").scanSync({ cwd: Global.Path.state, onlyFiles: true })]
            for (const relative of files) {
              const file = path.join(Global.Path.state, relative)
              const value = await Bun.file(file).json().catch(() => undefined)
              if (value?.pid === process.pid && value?.url === "http://127.0.0.1:43123") return { file, value }
            }
            throw new Error("Daemon registration path was not observed")
          })
          return {
            password,
            registration: registration.file,
            registrationValue: registration.value,
            registrationContent: yield* Effect.promise(() => Bun.file(registration.file).text()),
          }
        }),
      ).pipe(Effect.provide(Daemon.layer), Effect.provide(NodeFileSystem.layer)),
    ),
  )

  const plugin = path.join(Global.Path.config, "plugins", "runtime.ts")
  await Bun.write(plugin, "export default " + JSON.stringify(marker))
  const pluginMeta = await PluginMeta.touch(pathToFileURL(plugin).href, plugin, "runtime-plugin-" + marker)
  const stateFiles = [...new Bun.Glob("**/*").scanSync({ cwd: Global.Path.state, onlyFiles: true })]
  let metadata
  for (const relative of stateFiles) {
    const file = path.join(Global.Path.state, relative)
    const content = await Bun.file(file).text().catch(() => "")
    if (content.includes("runtime-plugin-" + marker)) {
      metadata = file
      break
    }
  }
  if (!metadata) throw new Error("Plugin metadata path was not observed")

  const mutations = [
    path.join(Global.Path.data, "runtime-data.txt"),
    path.join(Global.Path.config, "runtime-config.txt"),
    path.join(Global.Path.state, "runtime-state.txt"),
    path.join(Global.Path.cache, "runtime-cache.txt"),
    path.join(Global.Path.log, "runtime.log"),
    path.join(Global.Path.tmp, "runtime.tmp"),
  ]
  await Promise.all(mutations.map((file) => Bun.write(file, marker)))
  const result = {
    profile: profile.id,
    global: Global.Path,
    database,
    wal: databaseState.wal,
    walBytes: databaseState.walBytes,
    databaseSummary: databaseState.summary,
    daemon,
    plugin,
    pluginMetadata: metadata,
    pluginMeta,
    mutations,
    declaredMutationFiles: [
      database,
      databaseState.wal,
      database + "-shm",
      daemon.password,
      daemon.registration,
      plugin,
      metadata,
      ...mutations,
    ].toSorted(),
  }
  const finishedAt = Date.now()
  await rendezvous("after-mutation")
  const afterMutation = await rootManifest()
  console.log("RUNTIME_RESULT=" + JSON.stringify({
    ...result,
    environment: Object.keys(process.env).toSorted(),
    manifests: { initialized: initializedManifest, beforeMutation, afterMutation },
    mutation: { startedAt, finishedAt },
  }))
`

const healthScript = String.raw`
  const { Default } = await import("./src/server/server")
  const response = await Default().app.request("/global/health")
  console.log("HEALTH_RESULT=" + JSON.stringify({ status: response.status, body: await response.json() }))
  process.exit(0)
`

const expectedDatabaseTables = [
  { name: "account", rows: 0 },
  { name: "account_state", rows: 0 },
  { name: "control_account", rows: 0 },
  { name: "credential", rows: 0 },
  { name: "data_migration", rows: 0 },
  { name: "event", rows: 0 },
  { name: "event_sequence", rows: 0 },
  { name: "graph_artifact_draft", rows: 0 },
  { name: "graph_edge", rows: 0 },
  { name: "graph_generation_run", rows: 0 },
  { name: "graph_node", rows: 0 },
  { name: "graph_tool_run", rows: 0 },
  { name: "graph_version", rows: 0 },
  { name: "graph_workflow_state", rows: 0 },
  { name: "message", rows: 0 },
  { name: "migration", rows: 46 },
  { name: "part", rows: 0 },
  { name: "permission", rows: 0 },
  { name: "product_migration", rows: 0 },
  { name: "product_migration_entity", rows: 0 },
  { name: "product_migration_item", rows: 0 },
  { name: "project", rows: 0 },
  { name: "project_directory", rows: 0 },
  { name: "runtime_marker", rows: 1 },
  { name: "session", rows: 0 },
  { name: "session_context_epoch", rows: 0 },
  { name: "session_input", rows: 0 },
  { name: "session_message", rows: 0 },
  { name: "session_share", rows: 0 },
  { name: "todo", rows: 0 },
  { name: "workspace", rows: 0 },
]

test("concurrent OpenCode and Graph Vibe health responses report their product profiles", async () => {
  await using tmp = await tmpdir()
  const processes = [
    { id: "opencode", client: "" },
    { id: "graph-vibe", client: "graph-vibe" },
  ].map((product) => ({
    ...product,
    proc: Bun.spawn({
      cmd: [process.execPath, "--eval", healthScript],
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(tmp.path, product.id),
        OPENCODE_TEST_HOME: path.join(tmp.path, product.id),
        XDG_DATA_HOME: path.join(tmp.path, product.id, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, product.id, "config"),
        XDG_STATE_HOME: path.join(tmp.path, product.id, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, product.id, "cache"),
        TMPDIR: path.join(tmp.path, product.id, "tmp"),
        TMP: path.join(tmp.path, product.id, "tmp"),
        TEMP: path.join(tmp.path, product.id, "tmp"),
        OPENCODE_CLIENT: product.client,
        OPENCODE_DISABLE_CHANNEL_DB: "1",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    }),
  }))
  const results = await Promise.all(
    processes.map(async (product) => {
      const [exit, stdout, stderr] = await Promise.all([
        product.proc.exited,
        new Response(product.proc.stdout).text(),
        new Response(product.proc.stderr).text(),
      ])
      expect(exit, stderr).toBe(0)
      const line = stdout.split(/\r?\n/).find((item) => item.startsWith("HEALTH_RESULT="))
      if (!line) throw new Error(`Health result missing for ${product.id}: ${stdout}\n${stderr}`)
      return JSON.parse(line.slice("HEALTH_RESULT=".length))
    }),
  )
  expect(results).toEqual([
    {
      status: 200,
      body: {
        healthy: true,
        version: expect.any(String),
        product: {
          id: "opencode",
          name: "OpenCode",
          capability: "The AI coding agent built for the terminal",
        },
      },
    },
    {
      status: 200,
      body: {
        healthy: true,
        version: expect.any(String),
        product: {
          id: "graph-vibe",
          name: "Graph Vibe",
          capability: "Graph-guided development",
        },
      },
    },
  ])
}, 30_000)

test("real OpenCode and Graph Vibe runtimes never cross-write a shared synthetic home", async () => {
  await using tmp = await tmpdir()
  const roots = {
    home: path.join(tmp.path, "home"),
    data: path.join(tmp.path, "xdg", "data"),
    config: path.join(tmp.path, "xdg", "config"),
    state: path.join(tmp.path, "xdg", "state"),
    cache: path.join(tmp.path, "xdg", "cache"),
    tmp: path.join(tmp.path, "tmp"),
  }
  const barrier = path.join(tmp.path, "barrier")
  await mkdir(barrier, { recursive: true })
  expect(Object.values(roots).every((root) => !overlaps(root, barrier))).toBe(true)
  await Promise.all(
    Object.entries(roots).map(async ([label, root]) => {
      await mkdir(root, { recursive: true })
      await Bun.write(path.join(root, ".pre-created-root"), label)
    }),
  )
  await Promise.all(
    ["opencode", "graph-vibe"].flatMap((product) =>
      productRoots(roots, product).map(async (root) => {
        await mkdir(root, { recursive: true })
        await Bun.write(path.join(root, ".pre-created"), product)
      }),
    ),
  )
  const baseline = await completeManifest(roots)
  const [open, graph] = await runRuntimeChildren(roots, barrier)
  const expectedEnvironment = [
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    "HOME",
    "OPENCODE_CLIENT",
    "OPENCODE_DISABLE_CHANNEL_DB",
    "OPENCODE_TEST_HOME",
    "PATH",
    "RUNTIME_BARRIER",
    "RUNTIME_MARKER",
    "RUNTIME_ROOTS",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]
  expect(open.environment).toEqual(expectedEnvironment)
  expect(graph.environment).toEqual(expectedEnvironment)

  expect(open.manifests.initialized).toEqual(graph.manifests.initialized)
  expect(open.manifests.beforeMutation).toEqual(open.manifests.initialized)
  expect(graph.manifests.beforeMutation).toEqual(graph.manifests.initialized)
  expect(open.manifests.initialized.map((entry) => entry.path)).toEqual(expectedInitializedPaths(baseline))
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("home:.")
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("data:.")
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("config:.")
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("state:.")
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("cache:.")
  expect(open.manifests.initialized.map((entry) => entry.path)).toContain("tmp:.")
  expect(Math.max(open.mutation.startedAt, graph.mutation.startedAt)).toBeLessThanOrEqual(
    Math.min(open.mutation.finishedAt, graph.mutation.finishedAt),
  )
  const finalManifest = await completeManifest(roots)
  expect(open.manifests.afterMutation).toEqual(finalManifest)
  expect(graph.manifests.afterMutation).toEqual(finalManifest)
  expect(finalManifest.map((entry) => entry.path)).toEqual(expectedFinalPaths(baseline))
  expect(open.declaredMutationFiles).toEqual(expectedMutationFiles(roots, "opencode"))
  expect(graph.declaredMutationFiles).toEqual(expectedMutationFiles(roots, "graph-vibe"))
  expect(
    finalManifest.every(
      (entry) =>
        Number.isInteger(entry.mode) &&
        (entry.type === "file" ? /^[a-f0-9]{64}$/.test(entry.sha256 ?? "") : entry.sha256 === null),
    ),
  ).toBe(true)

  expect(open.profile).toBe("opencode")
  expect(graph.profile).toBe("graph-vibe")
  expect(open.global).toMatchObject({
    home: roots.home,
    data: path.join(roots.data, "opencode"),
    config: path.join(roots.config, "opencode"),
    state: path.join(roots.state, "opencode"),
    cache: path.join(roots.cache, "opencode"),
    tmp: path.join(roots.tmp, "opencode"),
    log: path.join(roots.data, "opencode", "log"),
  })
  expect(graph.global).toMatchObject({
    home: roots.home,
    data: path.join(roots.data, "graph-vibe"),
    config: path.join(roots.config, "graph-vibe"),
    state: path.join(roots.state, "graph-vibe"),
    cache: path.join(roots.cache, "graph-vibe"),
    tmp: path.join(roots.tmp, "graph-vibe"),
    log: path.join(roots.data, "graph-vibe", "log"),
  })
  expect(
    (["data", "config", "state", "cache", "tmp", "log"] as const).every(
      (key) => open.global[key] !== graph.global[key],
    ),
  ).toBe(true)
  expect(open.database).toStartWith(open.global.data + path.sep)
  expect(path.basename(open.database)).toStartWith("opencode")
  expect(graph.database).toStartWith(graph.global.data + path.sep)
  expect(path.basename(graph.database)).toStartWith("graph-vibe")
  expect(open.database).not.toBe(graph.database)
  expect(open.wal).toBe(`${open.database}-wal`)
  expect(graph.wal).toBe(`${graph.database}-wal`)
  expect(open.walBytes).toBeGreaterThan(0)
  expect(graph.walBytes).toBeGreaterThan(0)
  expect(open.daemon).toMatchObject({
    password: path.join(open.global.state, "password"),
    registration: path.join(open.global.state, "server.json"),
    registrationValue: { url: "http://127.0.0.1:43123" },
  })
  expect(graph.daemon).toMatchObject({
    password: path.join(graph.global.state, "graph-vibe-password"),
    registration: path.join(graph.global.state, "graph-vibe-server.json"),
    registrationValue: { url: "http://127.0.0.1:43123" },
  })
  expect(open.daemon.registrationValue.pid).toBeGreaterThan(0)
  expect(graph.daemon.registrationValue.pid).toBeGreaterThan(0)
  expect(open.daemon.registrationValue.pid).toBe(open.processPID)
  expect(graph.daemon.registrationValue.pid).toBe(graph.processPID)
  expect(open.daemon.registrationContent).toBe(JSON.stringify(open.daemon.registrationValue))
  expect(graph.daemon.registrationContent).toBe(JSON.stringify(graph.daemon.registrationValue))
  expect(open.plugin).toStartWith(open.global.config + path.sep)
  expect(graph.plugin).toStartWith(graph.global.config + path.sep)
  expect(open.pluginMetadata).toStartWith(open.global.state + path.sep)
  expect(graph.pluginMetadata).toStartWith(graph.global.state + path.sep)
  expect(open.databaseSummary.markers).toEqual(["opencode"])
  expect(graph.databaseSummary.markers).toEqual(["graph-vibe"])
  expect(open.databaseSummary.tables).toEqual(expectedDatabaseTables)
  expect(graph.databaseSummary.tables).toEqual(expectedDatabaseTables)
  expect(open.databaseSummary.integrity).toBe("ok")
  expect(graph.databaseSummary.integrity).toBe("ok")
  expect(open.databaseSummary.foreignKeyViolations).toBe(0)
  expect(graph.databaseSummary.foreignKeyViolations).toBe(0)
  expect(await inspectDatabase(open.database)).toEqual(open.databaseSummary)
  expect(await inspectDatabase(graph.database)).toEqual(graph.databaseSummary)

  expect(await runtimeMarker(open.database)).toEqual(["opencode"])
  expect(await runtimeMarker(graph.database)).toEqual(["graph-vibe"])
  await Promise.all(
    [open, graph].flatMap((runtime) =>
      [runtime.daemon.password, ...runtime.mutations].map(async (file) => {
        expect(await Bun.file(file).text()).toBe(runtime.profile)
      }),
    ),
  )
  await Promise.all([open, graph].map(assertRuntimeContents))
  await Promise.all(
    Object.entries(roots).map(async ([label, root]) => {
      expect(await Bun.file(path.join(root, ".pre-created-root")).text()).toBe(label)
    }),
  )
  await Promise.all(
    ["opencode", "graph-vibe"].flatMap((product) =>
      productRoots(roots, product).map(async (root) => {
        expect(await Bun.file(path.join(root, ".pre-created")).text()).toBe(product)
      }),
    ),
  )
}, 30_000)

test("terminates and reaps the peer when one runtime fails", async () => {
  await using tmp = await tmpdir()
  const roots = {
    home: path.join(tmp.path, "home"),
    data: path.join(tmp.path, "xdg", "data"),
    config: path.join(tmp.path, "xdg", "config"),
    state: path.join(tmp.path, "xdg", "state"),
    cache: path.join(tmp.path, "xdg", "cache"),
    tmp: path.join(tmp.path, "tmp"),
  }
  const barrier = path.join(tmp.path, "barrier")
  await Promise.all([...Object.values(roots), barrier].map((directory) => mkdir(directory, { recursive: true })))
  const started = Date.now()

  const error = await runRuntimeChildren(roots, barrier, "graph-vibe").then(
    () => undefined,
    (cause) => cause,
  )

  expect(error).toBeInstanceOf(Error)
  expect(Date.now() - started).toBeLessThan(10_000)
}, 15_000)

type Roots = {
  readonly home: string
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
  readonly tmp: string
}

type Runtime = {
  readonly processPID: number
  readonly environment: string[]
  readonly profile: string
  readonly global: {
    readonly home: string
    readonly data: string
    readonly config: string
    readonly state: string
    readonly cache: string
    readonly tmp: string
    readonly log: string
  }
  readonly database: string
  readonly wal: string
  readonly walBytes: number
  readonly daemon: {
    readonly password: string
    readonly registration: string
    readonly registrationValue: {
      readonly id: string
      readonly version: string
      readonly pid: number
      readonly url: string
    }
    readonly registrationContent: string
  }
  readonly plugin: string
  readonly pluginMetadata: string
  readonly pluginMeta: {
    readonly state: "first" | "updated" | "same"
    readonly entry: Record<string, unknown>
  }
  readonly databaseSummary: {
    readonly tables: Array<{ readonly name: string; readonly rows: number }>
    readonly markers: string[]
    readonly integrity: string
    readonly foreignKeyViolations: number
  }
  readonly mutations: string[]
  readonly declaredMutationFiles: string[]
  readonly manifests: {
    readonly initialized: ManifestEntry[]
    readonly beforeMutation: ManifestEntry[]
    readonly afterMutation: ManifestEntry[]
  }
  readonly mutation: {
    readonly startedAt: number
    readonly finishedAt: number
  }
}

type ManifestEntry = {
  readonly path: string
  readonly type: "directory" | "file" | "other"
  readonly mode: number
  readonly bytes: number
  readonly sha256: string | null
}

async function runRuntimeChildren(roots: Roots, barrier: string, fail?: "opencode" | "graph-vibe") {
  const children = [
    spawnRuntime(roots, barrier, "opencode", "", fail === "opencode"),
    spawnRuntime(roots, barrier, "graph-vibe", "graph-vibe", fail === "graph-vibe"),
  ]
  try {
    return await Promise.all(children.map(readRuntime))
  } finally {
    children.forEach((child) => {
      if (child.proc.exitCode === null) child.proc.kill()
    })
    await Promise.allSettled(children.map((child) => child.proc.exited))
  }
}

function spawnRuntime(roots: Roots, barrier: string, marker: string, client: string, fail: boolean) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--eval", runtimeScript],
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: roots.home,
      OPENCODE_TEST_HOME: roots.home,
      XDG_DATA_HOME: roots.data,
      XDG_CONFIG_HOME: roots.config,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      TMPDIR: roots.tmp,
      TMP: roots.tmp,
      TEMP: roots.tmp,
      OPENCODE_CLIENT: client,
      OPENCODE_DISABLE_CHANNEL_DB: "1",
      RUNTIME_MARKER: marker,
      RUNTIME_BARRIER: barrier,
      RUNTIME_ROOTS: JSON.stringify(roots),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...(fail ? { RUNTIME_FAIL: marker } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  })
  return { marker, proc }
}

async function readRuntime(child: ReturnType<typeof spawnRuntime>) {
  const proc = child.proc
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(exit, stderr).toBe(0)
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("RUNTIME_RESULT="))
  if (!line) throw new Error(`Runtime result missing: ${stdout}\n${stderr}`)
  return { ...(JSON.parse(line.slice("RUNTIME_RESULT=".length)) as Omit<Runtime, "processPID">), processPID: proc.pid }
}

async function assertRuntimeContents(runtime: Runtime) {
  expect(await Bun.file(runtime.plugin).text()).toBe(`export default ${JSON.stringify(runtime.profile)}`)
  const id = `runtime-plugin-${runtime.profile}`
  expect(await Bun.file(runtime.pluginMetadata).json()).toEqual({ [id]: runtime.pluginMeta.entry })
  expect(runtime.pluginMeta.state).toBe("first")
  expect(runtime.pluginMeta.entry).toMatchObject({
    id,
    source: "file",
    spec: pathToFileURL(runtime.plugin).href,
    target: runtime.plugin,
    modified: Math.trunc((await lstat(runtime.plugin)).mtimeMs),
    load_count: 1,
  })
  expect(Object.keys(runtime.pluginMeta.entry).toSorted()).toEqual(
    [
      "fingerprint",
      "first_time",
      "id",
      "last_time",
      "load_count",
      "modified",
      "source",
      "spec",
      "target",
      "time_changed",
    ].toSorted(),
  )
  expect(runtime.pluginMeta.entry.first_time).toBe(runtime.pluginMeta.entry.last_time)
  expect(runtime.pluginMeta.entry.first_time).toBe(runtime.pluginMeta.entry.time_changed)
}

async function inspectDatabase(database: string): Promise<Runtime["databaseSummary"]> {
  const sqlite = await import("bun:sqlite")
  const db = new sqlite.Database(database, { readonly: true, strict: true })
  try {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((table) => ({
        name: table.name,
        rows:
          db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${table.name.replaceAll('"', '""')}"`).get()
            ?.count ?? 0,
      }))
    return {
      tables,
      markers: db
        .query<{ value: string }, []>("SELECT value FROM runtime_marker ORDER BY value")
        .all()
        .map((row) => row.value),
      integrity:
        db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ?? "missing",
      foreignKeyViolations: db.query("PRAGMA foreign_key_check").all().length,
    }
  } finally {
    db.close(false)
  }
}

function productRoots(roots: Roots, product: string) {
  return [roots.data, roots.config, roots.state, roots.cache, roots.tmp].map((root) => path.join(root, product))
}

async function completeManifest(roots: Roots) {
  const inspect = async (label: string, target: string, relative: string): Promise<ManifestEntry[]> => {
    const info = await lstat(target)
    const entry = {
      path: `${label}:${relative.replaceAll(path.sep, "/")}`,
      mode: info.mode & 0o7777,
      bytes: info.size,
    }
    if (info.isDirectory()) {
      const children = await readdir(target)
      return [
        { ...entry, type: "directory", sha256: null },
        ...(
          await Promise.all(
            children
              .toSorted()
              .map((child) =>
                inspect(label, path.join(target, child), relative === "." ? child : path.join(relative, child)),
              ),
          )
        ).flat(),
      ]
    }
    if (!info.isFile()) return [{ ...entry, type: "other", sha256: null }]
    return [
      {
        ...entry,
        type: "file",
        sha256: createHash("sha256")
          .update(await Bun.file(target).bytes())
          .digest("hex"),
      },
    ]
  }
  return (await Promise.all(Object.entries(roots).map(([label, root]) => inspect(label, root, "."))))
    .flat()
    .toSorted((left, right) => left.path.localeCompare(right.path))
}

function expectedInitializedPaths(baseline: ManifestEntry[]) {
  return [
    ...baseline.map((entry) => entry.path),
    ...["opencode", "graph-vibe"].flatMap((product) => [
      `cache:${product}/bin`,
      `data:${product}/log`,
      `data:${product}/repos`,
    ]),
  ].toSorted()
}

function expectedFinalPaths(baseline: ManifestEntry[]) {
  return [
    ...expectedInitializedPaths(baseline),
    ...["opencode", "graph-vibe"].flatMap((product) => {
      const database = product === "opencode" ? "opencode.db" : "graph-vibe.db"
      const password = product === "opencode" ? "password" : "graph-vibe-password"
      return [
        `cache:${product}/runtime-cache.txt`,
        `config:${product}/plugins`,
        `config:${product}/plugins/runtime.ts`,
        `config:${product}/runtime-config.txt`,
        `data:${product}/${database}`,
        `data:${product}/${database}-shm`,
        `data:${product}/${database}-wal`,
        `data:${product}/log/runtime.log`,
        `data:${product}/runtime-data.txt`,
        `state:${product}/${password}`,
        `state:${product}/locks`,
        `state:${product}/plugin-meta.json`,
        `state:${product}/runtime-state.txt`,
        `tmp:${product}/runtime.tmp`,
      ]
    }),
  ].toSorted()
}

function expectedMutationFiles(roots: Roots, product: "opencode" | "graph-vibe") {
  const database = path.join(roots.data, product, product === "opencode" ? "opencode.db" : "graph-vibe.db")
  return [
    database,
    `${database}-shm`,
    `${database}-wal`,
    path.join(roots.cache, product, "runtime-cache.txt"),
    path.join(roots.config, product, "plugins", "runtime.ts"),
    path.join(roots.config, product, "runtime-config.txt"),
    path.join(roots.data, product, "log", "runtime.log"),
    path.join(roots.data, product, "runtime-data.txt"),
    path.join(roots.state, product, product === "opencode" ? "password" : "graph-vibe-password"),
    path.join(roots.state, product, "plugin-meta.json"),
    path.join(roots.state, product, "runtime-state.txt"),
    path.join(roots.state, product, product === "opencode" ? "server.json" : "graph-vibe-server.json"),
    path.join(roots.tmp, product, "runtime.tmp"),
  ].toSorted()
}

function overlaps(left: string, right: string) {
  const relative = path.relative(left, right)
  const inside =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  const reverse = path.relative(right, left)
  return inside || (reverse !== ".." && !reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse))
}

async function runtimeMarker(database: string) {
  const sqlite = await import("bun:sqlite")
  using db = new sqlite.Database(database, { readonly: true })
  return db
    .query<{ value: string }, []>("SELECT value FROM runtime_marker ORDER BY value")
    .all()
    .map((row) => row.value)
}
