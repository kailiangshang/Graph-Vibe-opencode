import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("unavailable Graph Vibe npm upgrade exits nonzero without invoking npm or a registry", async () => {
  await using tmp = await tmpdir()
  const fakeBin = path.join(tmp.path, "bin")
  const npmMarker = path.join(tmp.path, "npm-called")
  await mkdir(fakeBin)
  await Bun.write(path.join(fakeBin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_MARKER"\nexit 92\n')
  await chmod(path.join(fakeBin, "npm"), 0o755)
  const entry = path.resolve(import.meta.dir, "../../src/index.ts")
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "--conditions=browser", entry, "upgrade", "--method", "npm"],
    cwd: tmp.path,
    env: {
      ...process.env,
      HOME: tmp.path,
      OPENCODE_TEST_HOME: tmp.path,
      XDG_CONFIG_HOME: path.join(tmp.path, ".config"),
      XDG_DATA_HOME: path.join(tmp.path, ".local/share"),
      XDG_STATE_HOME: path.join(tmp.path, ".local/state"),
      XDG_CACHE_HOME: path.join(tmp.path, ".cache"),
      OPENCODE_CLIENT: "graph-vibe",
      OPENCODE_ENABLE_GRAPH_MODE: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      PATH: fakeBin,
      NPM_MARKER: npmMarker,
      npm_config_registry: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

  expect(await proc.exited).not.toBe(0)
  expect(output).toContain("Graph Vibe upgrades are unavailable until its release channel is configured")
  expect(await Bun.file(npmMarker).exists()).toBe(false)
})
