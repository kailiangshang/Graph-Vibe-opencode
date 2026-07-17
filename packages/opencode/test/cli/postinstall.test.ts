import { expect, test } from "bun:test"
import { chmod, mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const postinstall = path.resolve(import.meta.dir, "../../script/postinstall.mjs")

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "installs the Graph Vibe executable from a local Graph Vibe platform package",
  async () => {
    await using tmp = await tmpdir()
    const top = path.join(tmp.path, "graph-vibe")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    await mkdir(path.join(top, "bin"), { recursive: true })
    await mkdir(fakeBin)
    await Bun.write(
      path.join(top, "package.json"),
      JSON.stringify({
        name: "graph-vibe",
        bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
        optionalDependencies: {
          "graph-vibe-linux-x64": "1.2.3",
          "graph-vibe-linux-x64-baseline": "1.2.3",
          "graph-vibe-linux-x64-musl": "1.2.3",
          "graph-vibe-linux-x64-baseline-musl": "1.2.3",
        },
      }),
    )
    await Bun.write(path.join(top, "postinstall.mjs"), Bun.file(postinstall))
    for (const name of [
      "graph-vibe-linux-x64",
      "graph-vibe-linux-x64-baseline",
      "graph-vibe-linux-x64-musl",
      "graph-vibe-linux-x64-baseline-musl",
    ]) {
      const packageDir = path.join(top, "node_modules", name)
      await mkdir(path.join(packageDir, "bin"), { recursive: true })
      await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name, version: "1.2.3" }))
      await Bun.write(path.join(packageDir, "bin", "graph-vibe"), "#!/bin/sh\nexit 0\n# graph-vibe fixture\n")
      await chmod(path.join(packageDir, "bin", "graph-vibe"), 0o755)
    }
    await Bun.write(path.join(fakeBin, "npm"), '#!/bin/sh\nprintf "called" > "$NETWORK_MARKER"\nexit 92\n')
    await chmod(path.join(fakeBin, "npm"), 0o755)

    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(top, "postinstall.mjs")],
      cwd: top,
      env: { ...process.env, PATH: fakeBin, NETWORK_MARKER: npmMarker },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe("")
    expect(await new Response(proc.stderr).text()).toBe("")
    expect(await Bun.file(path.join(top, "bin", "graph-vibe.exe")).text()).toContain("graph-vibe fixture")
    expect(await Bun.file(path.join(top, "bin", "opencode.exe")).exists()).toBe(false)
    expect(await Bun.file(npmMarker).exists()).toBe(false)
  },
)

for (const fixture of ["name", "version", "symlink"] as const) {
  test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    `rejects a local platform package with invalid ${fixture} before fallback`,
    async () => {
      await using tmp = await tmpdir()
      const top = path.join(tmp.path, "graph-vibe")
      const fakeBin = path.join(tmp.path, "fake-bin")
      const npmMarker = path.join(tmp.path, "npm-called")
      const name = "graph-vibe-linux-x64"
      const packageDir = path.join(top, "node_modules", name)
      await mkdir(path.join(top, "bin"), { recursive: true })
      await mkdir(path.join(packageDir, "bin"), { recursive: true })
      await mkdir(fakeBin)
      await Bun.write(
        path.join(top, "package.json"),
        JSON.stringify({
          name: "graph-vibe",
          bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
          optionalDependencies: { [name]: "1.2.3" },
        }),
      )
      await Bun.write(path.join(top, "postinstall.mjs"), Bun.file(postinstall))
      await Bun.write(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: fixture === "name" ? "opencode-linux-x64" : name,
          version: fixture === "version" ? "9.9.9" : "1.2.3",
        }),
      )
      const binary = path.join(packageDir, "bin", "graph-vibe")
      if (fixture === "symlink") {
        const outside = path.join(tmp.path, "outside")
        await Bun.write(outside, "#!/bin/sh\nexit 0\n")
        await chmod(outside, 0o755)
        await symlink(outside, binary)
      } else {
        await Bun.write(binary, "#!/bin/sh\nexit 0\n")
        await chmod(binary, 0o755)
      }
      await Bun.write(path.join(fakeBin, "npm"), '#!/bin/sh\nprintf called > "$NPM_MARKER"\nexit 92\n')
      await chmod(path.join(fakeBin, "npm"), 0o755)

      const proc = Bun.spawn({
        cmd: [process.execPath, path.join(top, "postinstall.mjs")],
        cwd: top,
        env: { ...process.env, PATH: fakeBin, NPM_MARKER: npmMarker },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(await proc.exited).not.toBe(0)
      expect(await Bun.file(npmMarker).text()).toBe("called")
      expect(await Bun.file(path.join(top, "bin", "graph-vibe.exe")).exists()).toBe(false)
    },
  )
}

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "fallback-installs the declared package when the local binary fails verification",
  async () => {
    await using tmp = await tmpdir()
    const top = path.join(tmp.path, "graph-vibe")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const argvMarker = path.join(tmp.path, "npm-argv")
    const fallbackBinary = path.join(tmp.path, "fallback-graph-vibe")
    const fallbackManifest = path.join(tmp.path, "fallback-package.json")
    const name = "graph-vibe-linux-x64"
    const packageDir = path.join(top, "node_modules", name)
    await mkdir(path.join(top, "bin"), { recursive: true })
    await mkdir(path.join(packageDir, "bin"), { recursive: true })
    await mkdir(fakeBin)
    await Bun.write(
      path.join(top, "package.json"),
      JSON.stringify({
        name: "graph-vibe",
        bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
        optionalDependencies: { [name]: "1.2.3" },
      }),
    )
    await Bun.write(path.join(top, "postinstall.mjs"), Bun.file(postinstall))
    await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name, version: "1.2.3" }))
    await Bun.write(path.join(packageDir, "bin", "graph-vibe"), "#!/bin/sh\nexit 1\n")
    await chmod(path.join(packageDir, "bin", "graph-vibe"), 0o755)
    await Bun.write(fallbackManifest, JSON.stringify({ name, version: "1.2.3" }))
    await Bun.write(fallbackBinary, "#!/bin/sh\nexit 0\n# fallback fixture\n")
    await chmod(fallbackBinary, 0o755)
    await Bun.write(
      path.join(fakeBin, "npm"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$ARGV_MARKER"',
        "prefix=",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--prefix" ]; then shift; prefix="$1"; fi',
        "  shift",
        "done",
        '/bin/mkdir -p "$prefix/node_modules/$FALLBACK_NAME/bin"',
        '/bin/cp "$FALLBACK_MANIFEST" "$prefix/node_modules/$FALLBACK_NAME/package.json"',
        '/bin/cp "$FALLBACK_BINARY" "$prefix/node_modules/$FALLBACK_NAME/bin/graph-vibe"',
        '/bin/chmod 755 "$prefix/node_modules/$FALLBACK_NAME/bin/graph-vibe"',
      ].join("\n"),
    )
    await chmod(path.join(fakeBin, "npm"), 0o755)

    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(top, "postinstall.mjs")],
      cwd: top,
      env: {
        ...process.env,
        PATH: fakeBin,
        ARGV_MARKER: argvMarker,
        FALLBACK_NAME: name,
        FALLBACK_MANIFEST: fallbackManifest,
        FALLBACK_BINARY: fallbackBinary,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stderr).text()).toBe("")
    const argv = (await Bun.file(argvMarker).text()).trim().split("\n")
    expect(argv.slice(0, 5)).toEqual(["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix"])
    expect(argv[5]).toStartWith(path.join(path.dirname(tmp.path), "graph-vibe-install-"))
    expect(path.basename(argv[5])).toStartWith("graph-vibe-install-")
    expect(argv[6]).toBe(`${name}@1.2.3`)
    expect(await Bun.file(path.join(top, "bin", "graph-vibe.exe")).text()).toContain("fallback fixture")
  },
)

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "refuses an OpenCode-only platform fixture without invoking npm",
  async () => {
    await using tmp = await tmpdir()
    const top = path.join(tmp.path, "graph-vibe")
    const fakeBin = path.join(tmp.path, "fake-bin")
    const npmMarker = path.join(tmp.path, "npm-called")
    const packageDir = path.join(top, "node_modules", "opencode-linux-x64")
    await mkdir(path.join(top, "bin"), { recursive: true })
    await mkdir(path.join(packageDir, "bin"), { recursive: true })
    await mkdir(fakeBin)
    await Bun.write(
      path.join(top, "package.json"),
      JSON.stringify({
        name: "graph-vibe",
        bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
        optionalDependencies: { "opencode-linux-x64": "1.2.3" },
      }),
    )
    await Bun.write(path.join(top, "postinstall.mjs"), Bun.file(postinstall))
    await Bun.write(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "opencode-linux-x64", version: "1.2.3" }),
    )
    await Bun.write(path.join(packageDir, "bin", "opencode"), "#!/bin/sh\nexit 0\n")
    await chmod(path.join(packageDir, "bin", "opencode"), 0o755)
    await Bun.write(path.join(fakeBin, "npm"), '#!/bin/sh\nprintf "called" > "$NETWORK_MARKER"\nexit 92\n')
    await chmod(path.join(fakeBin, "npm"), 0o755)

    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(top, "postinstall.mjs")],
      cwd: top,
      env: { ...process.env, PATH: fakeBin, NETWORK_MARKER: npmMarker },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

    expect(await proc.exited).not.toBe(0)
    expect(output).toContain("graph-vibe")
    expect(output).not.toContain("opencode")
    expect(await Bun.file(path.join(top, "bin", "graph-vibe.exe")).exists()).toBe(false)
    expect(await Bun.file(npmMarker).exists()).toBe(false)
  },
)
