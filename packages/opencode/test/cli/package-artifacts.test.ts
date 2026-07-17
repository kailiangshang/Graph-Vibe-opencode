import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, readFile, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { materializeGraphVibeArtifacts } from "../../script/package-artifacts"
import { tmpdir } from "../fixture/fixture"

test("materializes byte-identical Graph Vibe Linux and Windows packages", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  await mkdir(path.join(dist, "opencode-linux-x64-baseline-musl", "bin"), { recursive: true })
  await mkdir(path.join(dist, "opencode-windows-arm64", "bin"), { recursive: true })
  await Bun.write(
    path.join(dist, "opencode-linux-x64-baseline-musl", "package.json"),
    JSON.stringify({
      name: "opencode-linux-x64-baseline-musl",
      version: "1.2.3",
      preferUnplugged: true,
      os: ["linux"],
      cpu: ["x64"],
      libc: ["musl"],
      ignored: "not published",
    }),
  )
  await Bun.write(
    path.join(dist, "opencode-windows-arm64", "package.json"),
    JSON.stringify({
      name: "opencode-windows-arm64",
      version: "1.2.3",
      preferUnplugged: true,
      os: ["win32"],
      cpu: ["arm64"],
    }),
  )
  const linuxSource = path.join(dist, "opencode-linux-x64-baseline-musl", "bin", "opencode")
  const windowsSource = path.join(dist, "opencode-windows-arm64", "bin", "opencode.exe")
  await Bun.write(linuxSource, new Uint8Array([0, 1, 2, 3, 255]))
  await Bun.write(windowsSource, new Uint8Array([77, 90, 0, 255]))
  await chmod(linuxSource, 0o751)
  await chmod(windowsSource, 0o744)

  expect(await materializeGraphVibeArtifacts(dist, "1.2.3")).toEqual({
    "graph-vibe-linux-x64-baseline-musl": "1.2.3",
    "graph-vibe-windows-arm64": "1.2.3",
  })

  const linuxTarget = path.join(dist, "graph-vibe-linux-x64-baseline-musl", "bin", "graph-vibe")
  const windowsTarget = path.join(dist, "graph-vibe-windows-arm64", "bin", "graph-vibe.exe")
  expect(await readFile(linuxTarget)).toEqual(await readFile(linuxSource))
  expect(await readFile(windowsTarget)).toEqual(await readFile(windowsSource))
  expect((await lstat(linuxTarget)).mode & 0o777).toBe((await lstat(linuxSource)).mode & 0o777)
  expect((await lstat(windowsTarget)).mode & 0o777).toBe((await lstat(windowsSource)).mode & 0o777)
  expect(await Bun.file(path.join(dist, "graph-vibe-linux-x64-baseline-musl", "package.json")).json()).toEqual({
    name: "graph-vibe-linux-x64-baseline-musl",
    version: "1.2.3",
    preferUnplugged: true,
    os: ["linux"],
    cpu: ["x64"],
    libc: ["musl"],
  })
  expect(await Bun.file(path.join(dist, "graph-vibe-windows-arm64", "package.json")).json()).toEqual({
    name: "graph-vibe-windows-arm64",
    version: "1.2.3",
    preferUnplugged: true,
    os: ["win32"],
    cpu: ["arm64"],
  })
  expect((await lstat(path.join(dist, "graph-vibe-linux-x64-baseline-musl", "package.json"))).mode & 0o111).toBe(0)
  expect((await lstat(path.join(dist, "graph-vibe-windows-arm64", "package.json"))).mode & 0o111).toBe(0)
  expect((await readdir(dist)).some((name) => name.startsWith(".graph-vibe-artifacts-"))).toBe(false)
})

test("only materializes canonical OpenCode package directories", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  await mkdir(path.join(dist, "graph-vibe-linux-x64", "bin"), { recursive: true })
  await Bun.write(
    path.join(dist, "graph-vibe-linux-x64", "package.json"),
    JSON.stringify({ name: "opencode-linux-x64", version: "9.9.9" }),
  )
  await Bun.write(path.join(dist, "graph-vibe-linux-x64", "bin", "graph-vibe"), "recursive")

  expect(await materializeGraphVibeArtifacts(dist, "1.2.3")).toEqual({})
  expect(await Bun.file(path.join(dist, "graph-vibe-linux-x64", "bin", "graph-vibe")).text()).toBe("recursive")
})

test("rejects package manifests that can escape their canonical directory", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  await mkdir(path.join(dist, "opencode-linux-x64", "bin"), { recursive: true })
  await Bun.write(
    path.join(dist, "opencode-linux-x64", "package.json"),
    JSON.stringify({ name: "opencode-linux-x64/../../escaped", version: "1.2.3" }),
  )
  await Bun.write(path.join(dist, "opencode-linux-x64", "bin", "opencode"), "binary")

  await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow("does not match its directory")
  expect(await Bun.file(path.join(tmp.path, "escaped")).exists()).toBe(false)
})

test("rejects symlinked platform executables", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  await mkdir(path.join(dist, "opencode-linux-arm64", "bin"), { recursive: true })
  await Bun.write(
    path.join(dist, "opencode-linux-arm64", "package.json"),
    JSON.stringify({
      name: "opencode-linux-arm64",
      version: "1.2.3",
      preferUnplugged: true,
      os: ["linux"],
      cpu: ["arm64"],
    }),
  )
  const outside = path.join(tmp.path, "outside")
  await Bun.write(outside, "binary")
  await symlink(outside, path.join(dist, "opencode-linux-arm64", "bin", "opencode"))

  await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow("must be a regular file")
  expect(await Bun.file(path.join(dist, "graph-vibe-linux-arm64", "bin", "graph-vibe")).exists()).toBe(false)
})

test("validates every source version before materializing any package", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  await writePlatformPackage(dist, "opencode-darwin-arm64", {
    version: "1.2.3",
    os: ["darwin"],
    cpu: ["arm64"],
  })
  await writePlatformPackage(dist, "opencode-linux-x64", {
    version: "9.9.9",
    os: ["linux"],
    cpu: ["x64"],
  })

  await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow(
    "opencode-linux-x64 version 9.9.9 does not match 1.2.3",
  )
  expect(await Bun.file(path.join(dist, "graph-vibe-darwin-arm64", "package.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(dist, "graph-vibe-linux-x64", "package.json")).exists()).toBe(false)
})

test("rejects platform constraints that do not exactly match the package variant", async () => {
  await using tmp = await tmpdir()
  const fixtures = [
    {
      directory: "opencode-linux-arm64",
      manifest: { version: "1.2.3", os: ["darwin"], cpu: ["arm64"] },
      error: 'opencode-linux-arm64 os must equal ["linux"]',
    },
    {
      directory: "opencode-linux-arm64",
      manifest: { version: "1.2.3", os: ["linux"], cpu: ["x64"] },
      error: 'opencode-linux-arm64 cpu must equal ["arm64"]',
    },
    {
      directory: "opencode-linux-x64-musl",
      manifest: { version: "1.2.3", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      error: 'opencode-linux-x64-musl libc must equal ["musl"]',
    },
    {
      directory: "opencode-darwin-x64",
      manifest: { version: "1.2.3", os: ["darwin"], cpu: ["x64"], libc: ["musl"] },
      error: "opencode-darwin-x64 libc must be absent",
    },
  ]

  for (const [index, fixture] of fixtures.entries()) {
    const dist = path.join(tmp.path, String(index))
    await writePlatformPackage(dist, fixture.directory, fixture.manifest)
    await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow(fixture.error)
    expect(await Bun.file(path.join(dist, fixture.directory.replace(/^opencode-/, "graph-vibe-"))).exists()).toBe(false)
  }
})

test("rejects canonical source package directory symlinks", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  const outside = path.join(tmp.path, "outside")
  await writePlatformPackage(tmp.path, "outside", {
    name: "opencode-linux-x64",
    version: "1.2.3",
    os: ["linux"],
    cpu: ["x64"],
  })
  await mkdir(dist)
  await symlink(outside, path.join(dist, "opencode-linux-x64"))

  await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow("must be a real directory")
  expect(await Bun.file(path.join(dist, "graph-vibe-linux-x64", "package.json")).exists()).toBe(false)
})

test("rejects existing target symlinks without touching their destination", async () => {
  await using tmp = await tmpdir()
  const dist = path.join(tmp.path, "dist")
  const outside = path.join(tmp.path, "outside")
  await writePlatformPackage(dist, "opencode-linux-x64", {
    version: "1.2.3",
    os: ["linux"],
    cpu: ["x64"],
  })
  await mkdir(outside)
  await Bun.write(path.join(outside, "marker"), "untouched")
  await symlink(outside, path.join(dist, "graph-vibe-linux-x64"))

  await expect(materializeGraphVibeArtifacts(dist, "1.2.3")).rejects.toThrow("target must not be a symlink")
  expect(await Bun.file(path.join(outside, "marker")).text()).toBe("untouched")
  expect((await lstat(path.join(dist, "graph-vibe-linux-x64"))).isSymbolicLink()).toBe(true)
})

async function writePlatformPackage(
  root: string,
  directory: string,
  manifest: {
    name?: string
    version: string
    os: string[]
    cpu: string[]
    libc?: string[]
  },
) {
  const windows = directory.includes("windows")
  const packageDir = path.join(root, directory)
  await mkdir(path.join(packageDir, "bin"), { recursive: true })
  await Bun.write(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: manifest.name ?? directory,
      version: manifest.version,
      preferUnplugged: true,
      os: manifest.os,
      cpu: manifest.cpu,
      ...(manifest.libc ? { libc: manifest.libc } : {}),
    }),
  )
  await Bun.write(path.join(packageDir, "bin", windows ? "opencode.exe" : "opencode"), "binary")
  await chmod(path.join(packageDir, "bin", windows ? "opencode.exe" : "opencode"), 0o755)
}
