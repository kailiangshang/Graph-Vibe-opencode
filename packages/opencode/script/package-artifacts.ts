import { constants, createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { isOpenCodePlatformPackage } from "./package-manifest"

type PlatformArtifact = {
  name: string
  version: string
  preferUnplugged: boolean
  os: string[]
  cpu: string[]
  libc?: string[]
  binary: FileHandle
  mode: number
  windows: boolean
}

export async function materializeGraphVibeArtifacts(
  dist: string,
  expectedVersion: string,
): Promise<Record<string, string>> {
  const root = path.resolve(dist)
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => isOpenCodePlatformPackage(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const handles: FileHandle[] = []
  const artifacts: PlatformArtifact[] = []

  try {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`${entry.name} must be a real directory`)
      }
      const source = path.resolve(root, entry.name)
      if (path.dirname(source) !== root) throw new Error(`${entry.name} escapes the artifact directory`)
      const manifestPath = path.join(source, "package.json")
      const manifest = await readManifest(manifestPath)
      validateManifest(entry.name, manifest, expectedVersion)

      const windows = entry.name.startsWith("opencode-windows-")
      const sourceBin = path.join(source, "bin")
      const sourceBinary = path.join(sourceBin, windows ? "opencode.exe" : "opencode")
      if (!(await lstat(sourceBin)).isDirectory()) throw new Error(`${sourceBin} must be a real directory`)
      const binaryPathStat = await lstat(sourceBinary)
      if (!binaryPathStat.isFile() || binaryPathStat.isSymbolicLink()) {
        throw new Error(`${sourceBinary} must be a regular file`)
      }
      const binary = await open(sourceBinary, constants.O_RDONLY | constants.O_NOFOLLOW)
      handles.push(binary)
      const binaryStat = await binary.stat()
      if (!binaryStat.isFile()) throw new Error(`${sourceBinary} must be a regular file`)

      const name = entry.name.replace(/^opencode-/, "graph-vibe-")
      const target = path.resolve(root, name)
      if (path.dirname(target) !== root) throw new Error(`${name} escapes the artifact directory`)
      const targetStat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (targetStat?.isSymbolicLink()) throw new Error(`${name} target must not be a symlink`)
      if (targetStat && !targetStat.isDirectory()) throw new Error(`${name} target must be a directory`)

      artifacts.push({
        name,
        version: manifest.version,
        preferUnplugged: manifest.preferUnplugged,
        os: manifest.os,
        cpu: manifest.cpu,
        ...(manifest.libc ? { libc: manifest.libc } : {}),
        binary,
        mode: binaryStat.mode & 0o777,
        windows,
      })
    }

    const staging = await mkdtemp(path.join(root, ".graph-vibe-artifacts-"))
    try {
      for (const artifact of artifacts) {
        const target = path.join(staging, artifact.name)
        const targetBin = path.join(target, "bin")
        const targetBinary = path.join(targetBin, artifact.windows ? "graph-vibe.exe" : "graph-vibe")
        await mkdir(targetBin, { recursive: true })
        await pipeline(
          artifact.binary.createReadStream({ autoClose: false, start: 0 }),
          createWriteStream(targetBinary, { flags: "wx", mode: artifact.mode }),
        )
        await chmod(targetBinary, artifact.mode)
        await Bun.write(
          path.join(target, "package.json"),
          JSON.stringify(
            {
              name: artifact.name,
              version: artifact.version,
              preferUnplugged: artifact.preferUnplugged,
              os: artifact.os,
              cpu: artifact.cpu,
              ...(artifact.libc ? { libc: artifact.libc } : {}),
            },
            null,
            2,
          ),
        )
        await chmod(path.join(target, "package.json"), 0o644)
      }

      for (const artifact of artifacts) {
        const target = path.join(root, artifact.name)
        await rm(target, { recursive: true, force: true })
        await rename(path.join(staging, artifact.name), target)
      }

      return Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.version]))
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

async function readManifest(file: string) {
  const fileStat = await lstat(file)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${file} must be a regular file`)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  const content = await handle.readFile("utf8").finally(() => handle.close())
  const manifest: unknown = JSON.parse(content)
  if (!isRecord(manifest)) throw new Error(`${file} must contain an object`)
  if (typeof manifest.name !== "string") throw new Error(`${file} must contain a name`)
  if (manifest.name !== path.basename(path.dirname(file))) throw new Error(`${file} name does not match its directory`)
  if (typeof manifest.version !== "string") throw new Error(`${file} must contain a version`)
  if (typeof manifest.preferUnplugged !== "boolean") throw new Error(`${file} must contain preferUnplugged`)
  if (!isStringArray(manifest.os) || !isStringArray(manifest.cpu)) {
    throw new Error(`${file} must contain platform metadata`)
  }
  if (manifest.libc !== undefined && !isStringArray(manifest.libc)) {
    throw new Error(`${file} contains invalid libc metadata`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    preferUnplugged: manifest.preferUnplugged,
    os: manifest.os,
    cpu: manifest.cpu,
    ...(manifest.libc ? { libc: manifest.libc } : {}),
  }
}

function validateManifest(name: string, manifest: Awaited<ReturnType<typeof readManifest>>, expectedVersion: string) {
  if (manifest.name !== name) throw new Error(`${name} manifest name ${manifest.name} does not match its directory`)
  if (manifest.version !== expectedVersion) {
    throw new Error(`${name} version ${manifest.version} does not match ${expectedVersion}`)
  }
  const parts = name.split("-")
  const os = parts[1] === "windows" ? "win32" : parts[1]
  const cpu = parts[2]
  if (!sameStrings(manifest.os, [os])) throw new Error(`${name} os must equal ${JSON.stringify([os])}`)
  if (!sameStrings(manifest.cpu, [cpu])) throw new Error(`${name} cpu must equal ${JSON.stringify([cpu])}`)
  if (parts.includes("musl") && !sameStrings(manifest.libc, ["musl"])) {
    throw new Error(`${name} libc must equal ["musl"]`)
  }
  if (!parts.includes("musl") && manifest.libc !== undefined) throw new Error(`${name} libc must be absent`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function sameStrings(actual: string[] | undefined, expected: string[]) {
  return actual?.length === expected.length && actual.every((item, index) => item === expected[index])
}
