import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("published graph-vibe wrapper launches its sibling executable and forwards args and exit status", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../..")
  const wrapper = path.join(tmp.path, "graph-vibe.cjs")
  const target = path.join(tmp.path, "graph-vibe.exe")
  await Bun.write(wrapper, Bun.file(path.join(root, "packages/opencode/bin/graph-vibe.cjs")))
  await Bun.write(
    target,
    '#!/bin/sh\nprintf "%s|%s|%s\\n" "$OPENCODE_CLIENT" "$OPENCODE_ENABLE_GRAPH_MODE" "$*"\nexit 7',
  )
  await chmod(target, 0o755)
  const proc = Bun.spawn({
    cmd: ["node", wrapper, "--version"],
    stdout: "pipe",
    stderr: "pipe",
  })

  expect((await new Response(proc.stdout).text()).trim()).toBe("graph-vibe|1|--version")
  expect(await new Response(proc.stderr).text()).toBe("")
  expect(await proc.exited).toBe(7)
})

test("published graph-vibe wrapper honors GRAPH_VIBE_BIN_PATH and forwards signals", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../..")
  const target = path.join(tmp.path, "override")
  const ready = path.join(tmp.path, "ready")
  const signal = path.join(tmp.path, "signal")
  await Bun.write(
    target,
    [
      "#!/bin/sh",
      "trap 'printf term > \"$SIGNAL_MARKER\"; exit 23' TERM",
      'printf ready > "$READY_MARKER"',
      "while :; do sleep 1; done",
    ].join("\n"),
  )
  await chmod(target, 0o755)
  const proc = Bun.spawn({
    cmd: ["node", path.join(root, "packages/opencode/bin/graph-vibe.cjs")],
    env: {
      ...process.env,
      GRAPH_VIBE_BIN_PATH: target,
      READY_MARKER: ready,
      SIGNAL_MARKER: signal,
      OPENCODE_BIN_PATH: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  for (let attempts = 0; attempts < 200 && !(await Bun.file(ready).exists()); attempts++) await Bun.sleep(10)
  expect(await Bun.file(ready).exists()).toBe(true)
  proc.kill("SIGTERM")

  expect(await proc.exited).toBe(23)
  expect(await Bun.file(signal).text()).toBe("term")
  expect(await new Response(proc.stderr).text()).toBe("")
})

test("published graph-vibe wrapper forwards repeated SIGINT and SIGTERM signals", async () => {
  await using tmp = await tmpdir()
  const root = path.resolve(import.meta.dir, "../../../..")
  const target = path.join(tmp.path, "override")
  const ready = path.join(tmp.path, "ready")
  const signals = path.join(tmp.path, "signals")
  await Bun.write(
    target,
    [
      "#!/bin/sh",
      "terms=0",
      "trap 'printf \"SIGINT\\n\" >> \"$SIGNAL_MARKER\"' INT",
      "trap 'terms=$((terms + 1)); printf \"SIGTERM\\n\" >> \"$SIGNAL_MARKER\"; [ \"$terms\" -lt 2 ] || exit 29' TERM",
      'printf ready > "$READY_MARKER"',
      "while :; do sleep 0.05; done",
    ].join("\n"),
  )
  await chmod(target, 0o755)
  const proc = Bun.spawn({
    cmd: ["node", path.join(root, "packages/opencode/bin/graph-vibe.cjs")],
    env: {
      ...process.env,
      GRAPH_VIBE_BIN_PATH: target,
      READY_MARKER: ready,
      SIGNAL_MARKER: signals,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  let completed = false

  try {
    await waitFor(() => Bun.file(ready).exists())
    proc.kill("SIGINT")
    await waitFor(async () => (await signalLines(signals)).length === 1)
    proc.kill("SIGINT")
    await waitFor(async () => (await signalLines(signals)).length === 2)
    proc.kill("SIGTERM")
    await waitFor(async () => (await signalLines(signals)).length === 3)
    proc.kill("SIGTERM")

    expect(await proc.exited).toBe(29)
    completed = true
    expect(await signalLines(signals)).toEqual(["SIGINT", "SIGINT", "SIGTERM", "SIGTERM"])
    expect(await new Response(proc.stderr).text()).toBe("")
  } finally {
    if (!completed) {
      proc.kill("SIGKILL")
      await proc.exited
    }
  }
})

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempts = 0; attempts < 200; attempts++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for wrapper signal fixture")
}

async function signalLines(file: string) {
  if (!(await Bun.file(file).exists())) return []
  return (await Bun.file(file).text()).trim().split("\n")
}
