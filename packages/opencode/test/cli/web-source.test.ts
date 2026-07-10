import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runSourceWeb, sourceWebPlan, sourceWebRoot, type SourceWebProcess } from "../../src/cli/cmd/web-source"

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
      port: 0,
      uiPort: 4444,
      mdns: true,
      mdnsDomain: "graph-vibe.local",
      cors: ["https://example.com"],
      env: { OPENCODE_CLIENT: "graph-vibe" },
    })

    expect(plan.backend.cwd).toBe("/work/project")
    expect(plan.backend.cmd).toContain("serve")
    expect(plan.backend.cmd).toContain("4096")
    expect(plan.web.cwd).toBe(path.join(root, "packages/app"))
    expect(plan.web.env.VITE_OPENCODE_SERVER_HOST).toBe("localhost")
    expect(plan.web.env.VITE_OPENCODE_SERVER_PORT).toBe("4096")
    expect(plan.webUrl).toBe("http://localhost:4444/L3dvcmsvcHJvamVjdA")
  })
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
          return spawned.length === 1 ? backend : web
        },
        waitForUrl: async (url) => {
          waited.push(url)
        },
        open: async (url) => {
          opened.push(url)
        },
        interrupted: Promise.resolve("SIGTERM"),
      },
    )

    expect(spawned).toEqual(["/work/project", path.join(root, "packages/app")])
    expect(waited).toEqual(["http://127.0.0.1:4096/global/health", "http://127.0.0.1:4444/"])
    expect(opened).toEqual(["http://127.0.0.1:4444/L3dvcmsvcHJvamVjdA"])
    expect(killed).toEqual(["backend", "web"])
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
})

function process(name: string, killed: string[]): SourceWebProcess {
  let resolve: (code: number) => void
  const exited = new Promise<number>((done) => {
    resolve = done
  })
  return {
    exited,
    kill: () => {
      killed.push(name)
      resolve(0)
    },
  }
}
