import { base64Encode } from "@opencode-ai/core/util/encode"
import path from "node:path"

export type SourceWebInput = {
  sourceRoot: string
  directory: string
  hostname: string
  port: number
  uiPort: number
  mdns: boolean
  mdnsDomain: string
  cors: string[]
  env: Record<string, string | undefined>
}

export type SourceWebProcess = {
  exited: Promise<number>
  kill: (signal?: NodeJS.Signals) => void
}

type SourceWebProcessSpec = {
  cmd: string[]
  cwd: string
  env: Record<string, string | undefined>
}

type SourceWebDependencies = {
  spawn: (spec: SourceWebProcessSpec) => SourceWebProcess
  waitForUrl: (url: string) => Promise<void>
  open: (url: string) => Promise<void>
  interrupted: Promise<NodeJS.Signals>
}

export function sourceWebRoot(productID: string, sourceRoot: string | undefined) {
  if (productID !== "graph-vibe") return
  return sourceRoot
}

export function sourceWebPlan(input: SourceWebInput) {
  const port = input.port || 4096
  const browserHost = input.hostname === "0.0.0.0" ? "localhost" : input.hostname
  const backendUrl = `http://${browserHost}:${port}`
  return {
    backend: {
      cmd: [
        process.execPath,
        "run",
        "--conditions=browser",
        path.join(input.sourceRoot, "packages/opencode/src/index.ts"),
        "serve",
        "--hostname",
        input.hostname,
        "--port",
        String(port),
        input.mdns ? "--mdns" : "--no-mdns",
        "--mdns-domain",
        input.mdnsDomain,
        ...input.cors.flatMap((origin) => ["--cors", origin]),
      ],
      cwd: input.directory,
      env: input.env,
    },
    web: {
      cmd: [
        process.execPath,
        "run",
        "dev",
        "--",
        "--host",
        input.hostname,
        "--port",
        String(input.uiPort),
        "--strictPort",
      ],
      cwd: path.join(input.sourceRoot, "packages/app"),
      env: {
        ...input.env,
        VITE_OPENCODE_SERVER_HOST: browserHost,
        VITE_OPENCODE_SERVER_PORT: String(port),
      },
    },
    backendUrl,
    webOrigin: `http://${browserHost}:${input.uiPort}`,
    webUrl: `http://${browserHost}:${input.uiPort}/${base64Encode(input.directory)}`,
  }
}

export async function runSourceWeb(input: SourceWebInput, dependencies?: SourceWebDependencies) {
  const valid = await Promise.all([
    Bun.file(path.join(input.sourceRoot, "packages/opencode/src/index.ts")).exists(),
    Bun.file(path.join(input.sourceRoot, "packages/app/package.json")).exists(),
  ])
  if (valid.some((exists) => !exists)) throw new Error(`Invalid Graph Vibe source root: ${input.sourceRoot}`)

  const plan = sourceWebPlan(input)
  const signal = dependencies ? undefined : interruption()
  const deps = dependencies ?? {
    spawn: spawnProcess,
    waitForUrl,
    open: openBrowser,
    interrupted: signal!.promise,
  }
  const backend = deps.spawn(plan.backend)
  let web: SourceWebProcess | undefined
  let terminationSignal: NodeJS.Signals | undefined

  try {
    await waitUntilReady("backend", backend, `${plan.backendUrl}/global/health`, deps.waitForUrl)
    web = deps.spawn(plan.web)
    await waitUntilReady("web", web, `${plan.webOrigin}/`, deps.waitForUrl)
    await deps.open(plan.webUrl)
    const stopped = await Promise.race([
      backend.exited.then((code) => ({ source: "backend", code }) as const),
      web.exited.then((code) => ({ source: "web", code }) as const),
      deps.interrupted.then((name) => ({ source: "signal", name }) as const),
    ])
    if (stopped.source !== "signal") {
      throw new Error(`${stopped.source} exited unexpectedly with code ${stopped.code}`)
    }
    terminationSignal = stopped.name
  } finally {
    backend.kill(terminationSignal)
    web?.kill(terminationSignal)
    await Promise.allSettled([backend.exited, ...(web ? [web.exited] : [])])
    signal?.dispose()
  }
}

async function waitUntilReady(
  name: string,
  process: SourceWebProcess,
  url: string,
  wait: (url: string) => Promise<void>,
) {
  await Promise.race([
    wait(url),
    process.exited.then((code) => {
      throw new Error(`${name} exited before readiness with code ${code}`)
    }),
  ])
}

function spawnProcess(spec: SourceWebProcessSpec): SourceWebProcess {
  const child = Bun.spawn({
    cmd: spec.cmd,
    cwd: spec.cwd,
    env: spec.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return {
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  }
}

async function waitForUrl(url: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function openBrowser(url: string) {
  if (process.env.OPENCODE_GRAPH_VIBE_NO_OPEN === "1") return
  const module = await import("open")
  await module.default(url).catch(() => undefined)
}

function interruption() {
  const listeners = new Map<string, () => void>()
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const listener = () => resolve(name)
      listeners.set(name, listener)
      process.once(name, listener)
    }
  })
  return {
    promise,
    dispose: () => {
      for (const [name, listener] of listeners) process.off(name, listener)
    },
  }
}
