import { describe, expect, test } from "bun:test"
import { Product } from "@opencode-ai/core/product"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { uninstallPackageCommand, uninstallShellIdentity } from "../../src/cli/cmd/uninstall"
import { tmpdir } from "../fixture/fixture"

const testUnix = process.platform === "win32" ? test.skip : test

describe("product uninstall identity", () => {
  test("Graph Vibe never targets OpenCode packages or shell paths", () => {
    const command = uninstallPackageCommand(Product.GraphVibe, "npm")
    expect(command).toEqual(["npm", "uninstall", "-g", "graph-vibe"])
    expect(uninstallPackageCommand(Product.GraphVibe, "brew")).toEqual(["brew", "uninstall", "graph-vibe"])
    expect(uninstallShellIdentity(Product.GraphVibe)).toEqual({ marker: "# graph-vibe", bin: ".graph-vibe/bin" })
    expect(command?.join(" ")).not.toContain("opencode")
  })

  test("OpenCode retains existing package identity", () => {
    expect(uninstallPackageCommand(Product.OpenCode, "npm")).toEqual(["npm", "uninstall", "-g", "opencode-ai"])
    expect(uninstallShellIdentity(Product.OpenCode)).toEqual({ marker: "# opencode", bin: ".opencode/bin" })
  })

  test("Graph Vibe dry-run reports only its npm uninstall identity", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    await mkdir(fakeBin)
    await writeFakeNpm(fakeBin, "dry-run")
    const entry = path.resolve(import.meta.dir, "../../src/index.ts")
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "--conditions=browser", entry, "uninstall", "--dry-run", "--force"],
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
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

    expect(await proc.exited).toBe(0)
    expect(output).toContain("Package: npm uninstall -g graph-vibe")
    expect(output).not.toContain("npm uninstall -g opencode")
    expect(await npmCalls(npmMarker)).toBe("list -g --depth=0\n")
  })

  for (const profile of [
    { client: "graph-vibe", name: "Graph Vibe", package: "graph-vibe" },
    { client: "opencode", name: "OpenCode", package: "opencode-ai" },
  ]) {
    test(`${profile.name} package-manager failure is accumulated and exits nonzero`, async () => {
      await using tmp = await tmpdir()
      const fakeBin = path.join(tmp.path, "bin")
      const npmMarker = path.join(tmp.path, "npm-called")
      await mkdir(fakeBin)
      await writeFakeNpm(fakeBin, "failure")
      const entry = path.resolve(import.meta.dir, "../../src/index.ts")
      const proc = Bun.spawn({
        cmd: [process.execPath, "run", "--conditions=browser", entry, "uninstall", "--force"],
        cwd: tmp.path,
        env: {
          ...process.env,
          HOME: tmp.path,
          OPENCODE_TEST_HOME: tmp.path,
          XDG_CONFIG_HOME: path.join(tmp.path, ".config"),
          XDG_DATA_HOME: path.join(tmp.path, ".local/share"),
          XDG_STATE_HOME: path.join(tmp.path, ".local/state"),
          XDG_CACHE_HOME: path.join(tmp.path, ".cache"),
          OPENCODE_CLIENT: profile.client,
          OPENCODE_ENABLE_GRAPH_MODE: "1",
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          PATH: fakeBin,
          NPM_MARKER: npmMarker,
          FAKE_PACKAGE: profile.package,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

      expect(await proc.exited).not.toBe(0)
      expect(output).toContain("Package manager uninstall failed: exit code 73")
      expect(output).toContain("Some operations failed:")
      expect(output).toContain(`Package: npm uninstall -g ${profile.package} exited with code 73`)
      expect(output).toContain(`You may need to run manually: npm uninstall -g ${profile.package}`)
      expect(await npmCalls(npmMarker)).toBe(`list -g --depth=0\nuninstall -g ${profile.package}\n`)
    })
  }

  test("successful Graph Vibe package-manager uninstall exits zero", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    await mkdir(fakeBin)
    await writeFakeNpm(fakeBin, "success")
    const entry = path.resolve(import.meta.dir, "../../src/index.ts")
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "--conditions=browser", entry, "uninstall", "--force"],
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
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    await new Response(proc.stdout).text()
    await new Response(proc.stderr).text()

    expect(await proc.exited).toBe(0)
    expect(await npmCalls(npmMarker)).toBe("list -g --depth=0\nuninstall -g graph-vibe\n")
  })

  testUnix("non-ENOENT directory access failures are reported and exit nonzero", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    await mkdir(fakeBin)
    await writeFakeNpm(fakeBin, "io-error")
    const entry = path.resolve(import.meta.dir, "../../src/index.ts")
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "--conditions=browser", entry, "uninstall", "--force"],
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
        FAKE_PACKAGE: "graph-vibe",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

    expect(await proc.exited).not.toBe(0)
    expect(output).toContain("Some operations failed:")
    expect(output).toContain("Data: ENOTDIR")
  })

  testUnix("dry-run reports inspection failures without mutating or printing success", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    const preserved = path.join(tmp.path, ".config", "graph-vibe", "preserved")
    await mkdir(fakeBin)
    await mkdir(path.dirname(preserved), { recursive: true })
    await Bun.write(preserved, "keep")
    await writeFakeNpm(fakeBin, "io-error")
    const entry = path.resolve(import.meta.dir, "../../src/index.ts")
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "--conditions=browser", entry, "uninstall", "--dry-run", "--force"],
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
        FAKE_PACKAGE: "graph-vibe",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

    expect(await proc.exited).not.toBe(0)
    expect(output).toContain("Dry run - no changes made")
    expect(output).toContain("Some operations failed:")
    expect(output).toContain("Data: ENOTDIR")
    expect(output).not.toContain("Thank you for using")
    expect(output).not.toContain("Done")
    expect(await npmCalls(npmMarker)).toBe("list -g --depth=0\n")
    expect(await Bun.file(preserved).text()).toBe("keep")
  })
})

type FakeNpmMode = "dry-run" | "failure" | "success" | "io-error"

async function writeFakeNpm(dir: string, mode: FakeNpmMode) {
  if (process.platform === "win32") {
    const scripts = {
      "dry-run": '@echo off\r\necho %*>>"%NPM_MARKER%"\r\necho graph-vibe@1.2.3\r\n',
      failure:
        '@echo off\r\necho %*>>"%NPM_MARKER%"\r\nif "%1"=="list" (\r\n  echo %FAKE_PACKAGE%@1.2.3\r\n  exit /b 0\r\n)\r\necho simulated uninstall failure 1>&2\r\nexit /b 73\r\n',
      success:
        '@echo off\r\necho %*>>"%NPM_MARKER%"\r\nif "%1"=="list" echo graph-vibe@1.2.3\r\nexit /b 0\r\n',
      "io-error": "@echo off\r\nexit /b 1\r\n",
    }
    await Bun.write(path.join(dir, "npm.cmd"), scripts[mode])
    return
  }

  const scripts = {
    "dry-run": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_MARKER"\nprintf "graph-vibe@1.2.3\\n"\n',
    failure:
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_MARKER"\nif [ "$1" = "list" ]; then\n  printf "%s@1.2.3\\n" "$FAKE_PACKAGE"\n  exit 0\nfi\nprintf "simulated uninstall failure\\n" >&2\nexit 73\n',
    success:
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_MARKER"\nif [ "$1" = "list" ]; then printf "graph-vibe@1.2.3\\n"; fi\n',
    "io-error":
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_MARKER"\nif [ "$1" = "list" ]; then\n  /bin/rm -rf "$XDG_DATA_HOME"\n  printf "not a directory\\n" > "$XDG_DATA_HOME"\n  printf "graph-vibe@1.2.3\\n"\nfi\n',
  }
  const executable = path.join(dir, "npm")
  await Bun.write(executable, scripts[mode])
  await chmod(executable, 0o755)
}

async function npmCalls(marker: string) {
  return (await Bun.file(marker).text()).replaceAll("\r\n", "\n")
}
