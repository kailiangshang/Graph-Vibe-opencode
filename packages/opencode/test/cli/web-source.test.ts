import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin } from "@opencode-ai/server/cors"
import { createServer } from "node:net"
import path from "node:path"
import {
  availableSourceWebPort,
  resolveSourceWebInput,
  runSourceWeb,
  sourceWebPlan,
  sourceWebRoot,
  stopSourceWebProcess,
  waitForUrl,
  type SourceWebProcess,
} from "../../src/cli/cmd/web-source"

const root = path.resolve(import.meta.dir, "../../../..")

describe("sourceWebPlan", () => {
  test("selects source coordination only for Graph Vibe source launches", () => {
    expect(sourceWebRoot("graph-vibe", root)).toBe(root)
    expect(sourceWebRoot("opencode", root)).toBeUndefined()
    expect(sourceWebRoot("graph-vibe", undefined)).toBeUndefined()
  })

  test("starts the backend in the project and Vite in the app", () => {
    const plan = sourceWebPlan({
      sourceRoot: root,
      directory: "/work/project",
      hostname: "0.0.0.0",
      port: 4096,
      uiPort: 4444,
      mdns: true,
      mdnsDomain: "graph-vibe.local",
      cors: ["https://example.com"],
      env: { OPENCODE_CLIENT: "graph-vibe" },
    })

    expect(plan.backend.cwd).toBe("/work/project")
    expect(plan.backend.cmd).toContain("serve")
    expect(plan.backend.cmd).toContain("4096")
    expect(plan.backend.cmd).toContain("http://local-network:4444")
    expect(plan.web.cwd).toBe(path.join(root, "packages/app"))
    expect(plan.web.env.VITE_OPENCODE_SERVER_HOST).toBe("0.0.0.0")
    expect(plan.web.env.VITE_OPENCODE_SERVER_PORT).toBe("4096")
    expect(plan.webUrl).toBe("http://localhost:4444/L3dvcmsvcHJvamVjdA")
  })

  test("uses an available fallback when the default backend port is occupied", async () => {
    const input = await resolveSourceWebInput(
      {
        sourceRoot: root,
        directory: "/work/project",
        hostname: "127.0.0.1",
        port: 0,
        uiPort: 4444,
        mdns: false,
        mdnsDomain: "opencode.local",
        cors: [],
        env: {},
      },
      async () => 5123,
    )

    expect(input.port).toBe(5123)
    expect(sourceWebPlan(input).backendUrl).toBe("http://127.0.0.1:5123")
  })

  test("selects a real ephemeral fallback when the preferred port is occupied", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port")

    const port = await availableSourceWebPort("127.0.0.1", address.port)
    server.close()

    expect(port).not.toBe(address.port)
    expect(port).toBeGreaterThan(0)
  })

  test("formats IPv6 URLs and allows the Vite origin through CORS", () => {
    const plan = sourceWebPlan({
      sourceRoot: root,
      directory: "/work/project",
      hostname: "::1",
      port: 4096,
      uiPort: 4444,
      mdns: false,
      mdnsDomain: "opencode.local",
      cors: [],
      env: {},
    })

    expect(plan.backendUrl).toBe("http://[::1]:4096")
    expect(plan.webOrigin).toBe("http://[::1]:4444")
    expect(plan.backend.cmd).toContain("http://[::1]:4444")
    expect(plan.web.env.VITE_OPENCODE_SERVER_HOST).toBe("[::1]")
  })

  test("allows an explicit mDNS origin with a non-wildcard hostname", () => {
    const plan = sourceWebPlan({
      sourceRoot: root,
      directory: "/work/project",
      hostname: "192.168.1.20",
      port: 4096,
      uiPort: 4444,
      mdns: true,
      mdnsDomain: "graph-vibe.local",
      cors: [],
      env: {},
    })

    expect(plan.backend.cmd).toContain("http://192.168.1.20:4444")
    expect(plan.backend.cmd).toContain("http://graph-vibe.local:4444")
  })

  test("allows the Vite port and resolves the browser host dynamically for wildcard binds", () => {
    const plan = sourceWebPlan({
      sourceRoot: root,
      directory: "/work/project",
      hostname: "0.0.0.0",
      port: 4096,
      uiPort: 4444,
      mdns: true,
      mdnsDomain: "graph-vibe.local",
      cors: [],
      env: {},
    })

    expect(plan.backend.cmd).toContain("http://local-network:4444")
    expect(plan.backend.cmd).toContain("http://graph-vibe.local:4444")
    expect(plan.web.env.VITE_OPENCODE_SERVER_HOST).toBe("0.0.0.0")
    const cors = ["http://local-network:4444", "http://graph-vibe.local:4444"]
    expect(isAllowedCorsOrigin("http://192.168.1.20:4444", { cors })).toBe(true)
    expect(isAllowedCorsOrigin("http://[fd00::1]:4444", { cors })).toBe(true)
    expect(isAllowedCorsOrigin("http://graph-vibe.local:4444", { cors })).toBe(true)
    expect(isAllowedCorsOrigin("http://evil.example:4444", { cors })).toBe(false)
    expect(isAllowedCorsOrigin("http://8.8.8.8:4444", { cors })).toBe(false)
    expect(isAllowedCorsOrigin("http://192.168.1.20:4445", { cors })).toBe(false)
  })
})

test("waitForUrl rejects a foreign response until the readiness token matches", async () => {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(++requests === 1 ? "foreign" : "ready-token"),
  })

  try {
    await waitForUrl(`http://127.0.0.1:${server.port}/ready`, "ready-token", 2, async () => {})
  } finally {
    await server.stop()
  }

  expect(requests).toBe(2)
})

describe("runSourceWeb", () => {
  test("rejects an invalid source root before spawning", async () => {
    expect(
      runSourceWeb(
        {
          sourceRoot: path.join(root, "missing"),
          directory: "/work/project",
          hostname: "127.0.0.1",
          port: 4096,
          uiPort: 4444,
          mdns: false,
          mdnsDomain: "opencode.local",
          cors: [],
          env: {},
        },
        {
          spawn: () => {
            throw new Error("spawn must not be called")
          },
          waitForUrl: async () => {},
          open: async () => {},
          interrupted: Promise.resolve("SIGTERM"),
        },
      ),
    ).rejects.toThrow("Invalid Graph Vibe source root")
  })

  test("stops and awaits both children on termination", async () => {
    const killed: string[] = []
    const backend = process("backend", killed)
    const web = process("web", killed)
    const spawned: string[] = []
    const waited: string[] = []
    const opened: string[] = []
    let interrupt: (signal: NodeJS.Signals) => void
    const interrupted = new Promise<NodeJS.Signals>((resolve) => {
      interrupt = resolve
    })

    await runSourceWeb(
      {
        sourceRoot: root,
        directory: "/work/project",
        hostname: "127.0.0.1",
        port: 4096,
        uiPort: 4444,
        mdns: false,
        mdnsDomain: "opencode.local",
        cors: [],
        env: {},
        readinessToken: "ready-token",
      },
      {
        spawn: (spec) => {
          spawned.push(spec.cwd)
          return spawned.length === 1 ? backend : web
        },
        waitForUrl: async (url) => {
          waited.push(url)
        },
        open: async (url) => {
          opened.push(url)
          interrupt("SIGTERM")
        },
        interrupted,
      },
    )

    expect(spawned).toEqual(["/work/project", path.join(root, "packages/app")])
    expect(waited).toEqual([
      "http://127.0.0.1:4096/__graph-vibe/source-ready?token=ready-token",
      "http://127.0.0.1:4444/",
    ])
    expect(opened).toEqual(["http://127.0.0.1:4444/L3dvcmsvcHJvamVjdA"])
    expect(killed).toEqual(["backend:SIGTERM", "web:SIGTERM"])
  })

  test("fails immediately when the backend exits before readiness", async () => {
    const backend: SourceWebProcess = { exited: Promise.resolve(7), kill: () => {} }

    expect(
      Promise.race([
        runSourceWeb(
          {
            sourceRoot: root,
            directory: "/work/project",
            hostname: "127.0.0.1",
            port: 4096,
            uiPort: 4444,
            mdns: false,
            mdnsDomain: "opencode.local",
            cors: [],
            env: {},
          },
          {
            spawn: () => backend,
            waitForUrl: () => new Promise(() => {}),
            open: async () => {},
            interrupted: new Promise(() => {}),
          },
        ),
        Bun.sleep(100).then(() => {
          throw new Error("coordinator did not observe backend exit")
        }),
      ]),
    ).rejects.toThrow("backend exited before readiness with code 7")
  })

  test("stops startup immediately when interrupted before readiness", async () => {
    const killed: string[] = []
    const spawned: string[] = []

    await runSourceWeb(
      {
        sourceRoot: root,
        directory: "/work/project",
        hostname: "127.0.0.1",
        port: 4096,
        uiPort: 4444,
        mdns: false,
        mdnsDomain: "opencode.local",
        cors: [],
        env: {},
      },
      {
        spawn: (spec) => {
          spawned.push(spec.cwd)
          return process("backend", killed)
        },
        waitForUrl: () => new Promise(() => {}),
        open: async () => {},
        interrupted: Promise.resolve("SIGTERM"),
      },
    )

    expect(spawned).toEqual(["/work/project"])
    expect(killed).toEqual(["backend:SIGTERM"])
  })

  test("reselects a dynamic backend port after a startup collision", async () => {
    const killed: string[] = []
    const backend = process("backend", killed)
    const web = process("web", killed)
    const spawned: string[] = []
    const waited: string[] = []
    const ready: string[] = []
    let interrupt: (signal: NodeJS.Signals) => void
    const interrupted = new Promise<NodeJS.Signals>((resolve) => {
      interrupt = resolve
    })

    await runSourceWeb(
      {
        sourceRoot: root,
        directory: "/work/project",
        hostname: "127.0.0.1",
        port: 0,
        uiPort: 4444,
        mdns: false,
        mdnsDomain: "opencode.local",
        cors: [],
        env: {},
        readinessToken: "ready-token",
      },
      {
        spawn: (spec) => {
          spawned.push(spec.cwd)
          if (spawned.length === 1) return { exited: Promise.resolve(1), kill: () => {} }
          return spawned.length === 2 ? backend : web
        },
        waitForUrl: async (url) => {
          waited.push(url)
          if (url.includes(":4096/")) await new Promise(() => {})
        },
        open: async () => interrupt("SIGTERM"),
        interrupted,
        resolvePort: async (_hostname, preferredPort) => (preferredPort === 4096 ? 4096 : 5123),
      },
      async (plan) => {
        ready.push(plan.backendUrl)
      },
    )

    expect(spawned).toEqual(["/work/project", "/work/project", path.join(root, "packages/app")])
    expect(waited).toEqual([
      "http://127.0.0.1:4096/__graph-vibe/source-ready?token=ready-token",
      "http://127.0.0.1:5123/__graph-vibe/source-ready?token=ready-token",
      "http://127.0.0.1:4444/",
    ])
    expect(ready).toEqual(["http://127.0.0.1:5123"])
    expect(killed).toEqual(["backend:SIGTERM", "web:SIGTERM"])
  })
})

test("stopSourceWebProcess escalates when a child ignores termination", async () => {
  const killed: string[] = []
  let resolve: (code: number) => void
  const child: SourceWebProcess = {
    exited: new Promise((done) => {
      resolve = done
    }),
    kill: (signal) => {
      killed.push(signal ?? "default")
      if (signal === "SIGKILL") resolve(137)
    },
  }

  await stopSourceWebProcess(child, "SIGTERM", () => ({ promise: Promise.resolve(), cancel: () => {} }))

  expect(killed).toEqual(["SIGTERM", "SIGKILL"])
})

test("stopSourceWebProcess cancels its escalation timer after cooperative shutdown", async () => {
  const killed: string[] = []
  let cancelled = false

  await stopSourceWebProcess(process("child", killed), "SIGTERM", () => ({
    promise: new Promise(() => {}),
    cancel: () => {
      cancelled = true
    },
  }))

  expect(killed).toEqual(["child:SIGTERM"])
  expect(cancelled).toBe(true)
})

function process(name: string, killed: string[]): SourceWebProcess {
  let resolve: (code: number) => void
  const exited = new Promise<number>((done) => {
    resolve = done
  })
  return {
    exited,
    kill: (signal) => {
      killed.push(`${name}:${signal ?? "default"}`)
      resolve(0)
    },
  }
}
