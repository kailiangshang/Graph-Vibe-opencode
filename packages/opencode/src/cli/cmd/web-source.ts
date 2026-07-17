import { base64Encode } from "@opencode-ai/core/util/encode"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import path from "node:path"
import { Product } from "@opencode-ai/core/product"

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
  readinessToken?: string
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
  waitForUrl: (url: string, expectedBody?: string) => Promise<void>
  open: (url: string) => Promise<void>
  interrupted: Promise<NodeJS.Signals>
  resolvePort?: (hostname: string, preferredPort?: number) => Promise<number>
}

export function sourceWebRoot(productID: string, sourceRoot: string | undefined) {
  if (productID !== "graph-vibe") return
  return sourceRoot
}

export async function resolveSourceWebInput(
  input: SourceWebInput,
  resolvePort: (hostname: string, preferredPort?: number) => Promise<number> = availableSourceWebPort,
) {
  if (input.port) return input
  return { ...input, port: await resolvePort(input.hostname, Product.GraphVibe.backendPort) }
}

export function sourceWebPlan(input: SourceWebInput) {
  const browserHost = sourceWebBrowserHost(input.hostname)
  const backendUrl = `http://${browserHost}:${input.port}`
  const webOrigin = `http://${browserHost}:${input.uiPort}`
  const wildcard = input.hostname === "0.0.0.0" || input.hostname === "::"
  const automaticCors = [
    wildcard ? `http://local-network:${input.uiPort}` : webOrigin,
    ...(input.mdns ? [`http://${input.mdnsDomain}:${input.uiPort}`] : []),
  ]
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
        String(input.port),
        input.mdns ? "--mdns" : "--no-mdns",
        "--mdns-domain",
        input.mdnsDomain,
        ...Array.from(new Set([...input.cors, ...automaticCors])).flatMap((origin) => ["--cors", origin]),
      ],
      cwd: input.directory,
      env: {
        ...input.env,
        OPENCODE_GRAPH_VIBE_SOURCE_TOKEN: input.readinessToken,
      },
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
        VITE_OPENCODE_SERVER_HOST: wildcard ? input.hostname : browserHost,
        VITE_OPENCODE_SERVER_PORT: String(input.port),
      },
    },
    backendUrl,
    webOrigin,
    webUrl: `${webOrigin}/${base64Encode(input.directory)}`,
  }
}

export async function runSourceWeb(
  input: SourceWebInput,
  dependencies?: SourceWebDependencies,
  onReady: (plan: ReturnType<typeof sourceWebPlan>) => void | Promise<void> = () => {},
) {
  const valid = await Promise.all([
    Bun.file(path.join(input.sourceRoot, "packages/opencode/src/index.ts")).exists(),
    Bun.file(path.join(input.sourceRoot, "packages/app/package.json")).exists(),
  ])
  if (valid.some((exists) => !exists)) throw new Error(`Invalid Graph Vibe source root: ${input.sourceRoot}`)

  const signal = dependencies ? undefined : interruption()
  const deps: SourceWebDependencies = dependencies ?? {
    spawn: spawnProcess,
    waitForUrl,
    open: openBrowser,
    interrupted: signal!.promise,
  }
  const children: SourceWebProcess[] = []
  const prepared = { ...input, readinessToken: input.readinessToken ?? randomUUID() }

  try {
    const started = await startSourceWebBackend(prepared, deps)
    children.push(started.backend)
    if (started.signal) {
      await Promise.all(children.map((child) => stopSourceWebProcess(child, started.signal)))
      children.length = 0
      return
    }
    const plan = started.plan
    const web = deps.spawn(plan.web)
    children.push(web)
    const ready = await Promise.race([
      waitUntilReady(web, `${plan.webOrigin}/`, deps.waitForUrl, deps.interrupted),
      started.backend.exited.then((code) => ({ source: "backend", code }) as const),
    ])
    if (ready.source === "signal") {
      await Promise.all(children.map((child) => stopSourceWebProcess(child, ready.name)))
      children.length = 0
      return
    }
    if (ready.source === "error") throw ready.error
    if (ready.source === "exit") throw new Error(`web exited before readiness with code ${ready.code}`)
    if (ready.source === "backend") throw new Error(`backend exited before web readiness with code ${ready.code}`)
    await onReady(plan)
    await deps.open(plan.webUrl)
    const stopped = await Promise.race([
      started.backend.exited.then((code) => ({ source: "backend", code }) as const),
      web.exited.then((code) => ({ source: "web", code }) as const),
      deps.interrupted.then((name) => ({ source: "signal", name }) as const),
    ])
    if (stopped.source !== "signal") {
      throw new Error(`${stopped.source} exited unexpectedly with code ${stopped.code}`)
    }
    await Promise.all(children.map((child) => stopSourceWebProcess(child, stopped.name)))
    children.length = 0
  } finally {
    await Promise.all(children.map((child) => stopSourceWebProcess(child, undefined)))
    signal?.dispose()
  }
}

export async function stopSourceWebProcess(
  process: SourceWebProcess,
  signal: NodeJS.Signals | undefined,
  createTimer: (milliseconds: number) => { promise: Promise<unknown>; cancel: () => void } = shutdownTimer,
) {
  process.kill(signal)
  const timer = createTimer(2_000)
  const exited = await Promise.race([process.exited.then(() => true), timer.promise.then(() => false)])
  timer.cancel()
  if (exited) return
  process.kill("SIGKILL")
  await process.exited
}

async function waitUntilReady(
  process: SourceWebProcess,
  url: string,
  wait: (url: string, expectedBody?: string) => Promise<void>,
  interrupted: Promise<NodeJS.Signals>,
  expectedBody?: string,
) {
  return Promise.race([
    wait(url, expectedBody).then(
      () => ({ source: "ready" }) as const,
      (error) => ({ source: "error", error }) as const,
    ),
    process.exited.then((code) => ({ source: "exit", code }) as const),
    interrupted.then((name) => ({ source: "signal", name }) as const),
  ])
}

async function startSourceWebBackend(input: SourceWebInput, deps: SourceWebDependencies, attempt = 0) {
  const fallback = input.port === 0
  const resolved = input.port
    ? input
    : {
        ...input,
        port: await (deps.resolvePort ?? availableSourceWebPort)(
          input.hostname,
          attempt === 0 ? Product.GraphVibe.backendPort : 0,
        ),
      }
  const plan = sourceWebPlan(resolved)
  const backend = deps.spawn(plan.backend)
  const readyUrl = new URL("/__graph-vibe/source-ready", plan.backendUrl)
  readyUrl.searchParams.set("token", resolved.readinessToken!)
  const ready = await waitUntilReady(
    backend,
    readyUrl.toString(),
    deps.waitForUrl,
    deps.interrupted,
    resolved.readinessToken,
  )
  if (ready.source === "ready") return { backend, plan }
  if (ready.source === "signal") return { backend, plan, signal: ready.name }
  if (ready.source === "error") {
    await stopSourceWebProcess(backend, undefined)
    throw ready.error
  }
  if (fallback && attempt < 4) return startSourceWebBackend(input, deps, attempt + 1)
  throw new Error(`backend exited before readiness with code ${ready.code}`)
}

function shutdownTimer(milliseconds: number) {
  let timer: ReturnType<typeof setTimeout>
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

function sourceWebBrowserHost(hostname: string) {
  if (hostname === "0.0.0.0" || hostname === "::") return "localhost"
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`
  return hostname
}

export async function availableSourceWebPort(hostname: string, preferredPort: number = Product.GraphVibe.backendPort) {
  return listenForAvailablePort(hostname, preferredPort).catch(() => listenForAvailablePort(hostname, 0))
}

function listenForAvailablePort(hostname: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ host: hostname, port }, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error(`Could not reserve a source Web port on ${hostname}`))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
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

export async function waitForUrl(
  url: string,
  expectedBody?: string,
  attempts = 120,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok && (!expectedBody || (await response.text()) === expectedBody)) return
    await sleep(250)
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
