import { expect, test } from "bun:test"
import { chmod, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function run(alias: "graph-vibe" | "opencode") {
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "target")
  await Bun.write(target, '#!/bin/sh\nprintf "%s|%s\\n" "$OPENCODE_CLIENT" "$OPENCODE_ENABLE_GRAPH_MODE"')
  await chmod(target, 0o755)

  const root = path.resolve(import.meta.dir, "../../../..")
  const wrapper = path.join(tmp.path, "opencode")
  await Bun.write(wrapper, Bun.file(path.join(root, "packages/opencode/bin/opencode")))
  await chmod(wrapper, 0o755)
  const command = path.join(tmp.path, alias)
  if (alias === "graph-vibe") await symlink(wrapper, command)
  const env = { ...process.env, OPENCODE_BIN_PATH: target }
  delete env.OPENCODE_CLIENT
  delete env.OPENCODE_ENABLE_GRAPH_MODE
  const proc = Bun.spawn({ cmd: [command], env, stdout: "pipe", stderr: "pipe" })
  const output = (await new Response(proc.stdout).text()).trim()
  const error = await new Response(proc.stderr).text()

  expect(error).toBe("")
  expect(await proc.exited).toBe(0)
  return output
}

test("graph-vibe bin alias selects Graph Vibe", async () => {
  expect(await run("graph-vibe")).toBe("graph-vibe|1")
})

test("opencode bin alias retains the default identity", async () => {
  expect(await run("opencode")).toBe("|")
})
