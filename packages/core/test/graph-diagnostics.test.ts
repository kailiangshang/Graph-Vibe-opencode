import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { GraphDiagnostics } from "@opencode-ai/core/graph/workflow/diagnostics"
import { tmpdir } from "./fixture/tmpdir"

describe("GraphDiagnostics", () => {
  test("excludes an intentional root test guard", async () => {
    await using dir = await project({
      test: "echo 'do not run tests from root' && exit 1",
      typecheck: "tsgo --noEmit",
      lint: "oxlint",
    })

    const result = await GraphDiagnostics.resolve({ directory: dir.path, verification: null })

    expect(result).toMatchObject({ ok: true, complete: true })
    if (!result.ok) return
    expect(result.commands.map((command) => command.name)).toEqual(["typecheck", "lint"])
  })

  test("reports a required guard-only test as missing", async () => {
    await using dir = await project({ test: "echo 'do not run tests from root' && exit 1" })

    const result = await GraphDiagnostics.resolve({
      directory: dir.path,
      verification: { criteria: ["verified"], diagnostics: [{ name: "test" }] },
    })

    expect(result).toEqual({ ok: false, reason: "diagnostic_script_missing", diagnostic: "test" })
  })

  test("does not fall back to bun test when configured diagnostics are guards", async () => {
    await using dir = await project({ test: "echo 'do not run tests from root' && exit 1" })

    const result = await GraphDiagnostics.resolve({ directory: dir.path, verification: null })

    expect(result).toMatchObject({ ok: true, complete: false, commands: [] })
  })

  test("recognizes print-only guard variants without excluding compound scripts", async () => {
    await using guarded = await project({ test: "printf 'Tests cannot be run from root'\nexit 1; # guard" })
    await using compound = await project({ test: "echo 'do not run generated checks'; cleanup; exit 1" })
    await using substitution = await project({ test: 'echo "$(run-preflight) do not run tests"; exit 1' })
    await using piped = await project({ test: "echo 'do not run tests' | tee warning; exit 1" })

    const guardedResult = await GraphDiagnostics.resolve({ directory: guarded.path, verification: null })
    const compoundResult = await GraphDiagnostics.resolve({ directory: compound.path, verification: null })
    const substitutionResult = await GraphDiagnostics.resolve({ directory: substitution.path, verification: null })
    const pipedResult = await GraphDiagnostics.resolve({ directory: piped.path, verification: null })

    expect(guardedResult).toMatchObject({ ok: true, complete: false, commands: [] })
    expect(compoundResult).toMatchObject({
      ok: true,
      complete: true,
      commands: [{ name: "test", command: "bun run test" }],
    })
    expect(substitutionResult).toMatchObject({ ok: true, complete: true, commands: [{ name: "test" }] })
    expect(pipedResult).toMatchObject({ ok: true, complete: true, commands: [{ name: "test" }] })
  })

  test("skips focused oxlint for Markdown but retains project lint", async () => {
    await using dir = await project({ lint: "oxlint" }, { "README.md": "# Readme\n" })

    const result = await GraphDiagnostics.resolve({
      directory: dir.path,
      verification: { criteria: ["formatted"], diagnostics: [{ name: "lint", paths: ["README.md"] }] },
    })

    expect(result).toMatchObject({
      ok: true,
      complete: true,
      skipped: [{ name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" }],
    })
    if (!result.ok) return
    expect(result.commands.map((command) => command.command)).toEqual(["bun run lint"])
  })

  test("keeps supported paths when focused oxlint targets are mixed", async () => {
    await using dir = await project(
      { lint: "oxlint" },
      { "README.md": "# Readme\n", "src/example.ts": "export {}\n" },
    )

    const result = await GraphDiagnostics.resolve({
      directory: dir.path,
      verification: {
        criteria: ["linted"],
        diagnostics: [{ name: "lint", paths: ["README.md", "src/example.ts"] }],
      },
    })

    expect(result).toMatchObject({
      ok: true,
      skipped: [{ name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" }],
    })
    if (!result.ok) return
    expect(result.commands.map((command) => command.command)).toEqual([
      `bun run lint -- ${dir.path}/src/example.ts`,
      "bun run lint",
    ])
    expect(result.commands[0]?.targets.map((target) => target.relative)).toEqual(["src/example.ts"])
  })

  test("recognizes delegated and quoted oxlint scripts without matching unrelated arguments", async () => {
    await using delegated = await project(
      { lint: "bun run lint:code", "lint:code": "bunx oxlint@latest", unrelated: "true" },
      { "README.md": "# Readme\n" },
    )
    await using quoted = await project({ lint: '"./node_modules/.bin/oxlint"' }, { "README.md": "# Readme\n" })
    await using unrelated = await project(
      { lint: "eslint --ignore-pattern oxlint" },
      { "README.md": "# Readme\n" },
    )
    await using npmExec = await project({ lint: "npm exec oxlint" }, { "README.md": "# Readme\n" })
    await using npxOption = await project({ lint: "npx --yes oxlint" }, { "README.md": "# Readme\n" })
    await using npxShort = await project({ lint: "npx -y oxlint" }, { "README.md": "# Readme\n" })
    await using npmSeparator = await project({ lint: "npm exec -- oxlint" }, { "README.md": "# Readme\n" })
    await using yarnDlx = await project({ lint: "yarn dlx -q oxlint" }, { "README.md": "# Readme\n" })
    await using yarnDelegated = await project(
      { lint: "yarn lint:code", "lint:code": "pnpm exec oxlint" },
      { "README.md": "# Readme\n" },
    )

    const verification = {
      criteria: ["linted"],
      diagnostics: [{ name: "lint", paths: ["README.md"] }],
    } as const
    const delegatedResult = await GraphDiagnostics.resolve({ directory: delegated.path, verification })
    const quotedResult = await GraphDiagnostics.resolve({ directory: quoted.path, verification })
    const unrelatedResult = await GraphDiagnostics.resolve({ directory: unrelated.path, verification })
    const npmExecResult = await GraphDiagnostics.resolve({ directory: npmExec.path, verification })
    const npxOptionResult = await GraphDiagnostics.resolve({ directory: npxOption.path, verification })
    const npxShortResult = await GraphDiagnostics.resolve({ directory: npxShort.path, verification })
    const npmSeparatorResult = await GraphDiagnostics.resolve({ directory: npmSeparator.path, verification })
    const yarnDlxResult = await GraphDiagnostics.resolve({ directory: yarnDlx.path, verification })
    const yarnDelegatedResult = await GraphDiagnostics.resolve({ directory: yarnDelegated.path, verification })

    expect(delegatedResult).toMatchObject({
      ok: true,
      skipped: [{ name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" }],
    })
    expect(quotedResult).toMatchObject({
      ok: true,
      skipped: [{ name: "lint", paths: ["README.md"], reason: "unsupported_focused_paths" }],
    })
    expect(npmExecResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(npxOptionResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(npxShortResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(npmSeparatorResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(yarnDlxResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(yarnDelegatedResult).toMatchObject({ ok: true, skipped: [{ name: "lint" }] })
    expect(unrelatedResult).toMatchObject({ ok: true, skipped: [] })
    if (!unrelatedResult.ok) return
    expect(unrelatedResult.commands[0]?.focused).toBe(true)
  })
})

async function project(scripts: Record<string, string>, files: Record<string, string> = {}) {
  const dir = await tmpdir()
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await fs.mkdir(path.dirname(path.join(dir.path, file)), { recursive: true })
      await Bun.write(path.join(dir.path, file), content)
    }),
  )
  await Bun.write(path.join(dir.path, "package.json"), JSON.stringify({ scripts }))
  return dir
}
