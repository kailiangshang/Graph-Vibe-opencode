import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("published graph-vibe wrapper selects identity and forwards exit status", async () => {
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "opencode.exe")
  await Bun.write(
    target,
    '#!/bin/sh\nprintf "%s|%s|%s\\n" "$OPENCODE_CLIENT" "$OPENCODE_ENABLE_GRAPH_MODE" "$*"\nexit 7',
  )
  await chmod(target, 0o755)
  const root = path.resolve(import.meta.dir, "../../../..")
  const proc = Bun.spawn({
    cmd: ["node", path.join(root, "packages/opencode/bin/graph-vibe.cjs"), "--version"],
    env: { ...process.env, OPENCODE_BIN_PATH: target },
    stdout: "pipe",
    stderr: "pipe",
  })

  expect((await new Response(proc.stdout).text()).trim()).toBe("graph-vibe|1|--version")
  expect(await new Response(proc.stderr).text()).toBe("")
  expect(await proc.exited).toBe(7)
})
