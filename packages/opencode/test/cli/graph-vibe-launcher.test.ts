import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("graph-vibe launcher selects product identity and preserves the caller directory", async () => {
  await using tmp = await tmpdir()
  const bin = path.join(tmp.path, "bin")
  const bun = path.join(bin, "bun")
  await mkdir(bin)
  await Bun.write(
    bun,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$OPENCODE_CLIENT"',
      'printf "%s\\n" "$OPENCODE_ENABLE_GRAPH_MODE"',
      'printf "%s\\n" "$OPENCODE_GRAPH_VIBE_SOURCE_ROOT"',
      'printf "%s\\n" "$OPENCODE_INITIAL_DIRECTORY"',
      'printf "%s\\n" "$OPENCODE_GRAPH_VIBE_WEB_URL"',
      'printf "%s\\n" "$PWD"',
      'printf "%s\\n" "$*"',
    ].join("\n"),
  )
  await chmod(bun, 0o755)

  const root = path.resolve(import.meta.dir, "../../../..")
  const proc = Bun.spawn({
    cmd: [path.join(root, "scripts/graph-vibe"), "--version"],
    cwd: tmp.path,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = (await new Response(proc.stdout).text()).trim().split("\n")
  const error = await new Response(proc.stderr).text()

  expect(await proc.exited).toBe(0)
  expect(error).toBe("")
  expect(output).toEqual([
    "graph-vibe",
    "1",
    root,
    tmp.path,
    "http://localhost:4444",
    path.join(root, "packages/opencode"),
    `run --conditions=browser ./src/index.ts ${tmp.path} --version`,
  ])
})
