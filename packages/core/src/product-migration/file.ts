export * as ProductMigrationFile from "./file"

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const referencedFileMaxBytes = 128 * 1024 * 1024
export const referencedSessionMaxBytes = 512 * 1024 * 1024
export const referencePathMaxBytes = 4_096
export const referenceRawMaxBytes = referencePathMaxBytes * 3 + 64
export const configFileMaxBytes = 8 * 1024 * 1024
export const credentialFileMaxBytes = 1024 * 1024
export const credentialInventoryMaxBytes = 16 * 1024 * 1024
const chunkBytes = 64 * 1024

interface Identity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mode: number
}

export async function readContainedFile(input: {
  readonly file: string
  readonly root: string
  readonly maxBytes: number
}) {
  const opened = await openContained(input.file, input.root, input.maxBytes)
  try {
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(input.maxBytes, 1)))
    let size = 0
    while (true) {
      const result = await opened.handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
      if (size > input.maxBytes) throw new Error("File exceeds byte limit")
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)))
    }
    const final = await opened.handle.stat()
    if (!sameIdentity(opened.identity, final) || final.size !== size) {
      throw new Error("Source file changed while being read")
    }
    return { canonical: opened.canonical, content: Buffer.concat(chunks, size), mode: opened.identity.mode & 0o777 }
  } finally {
    await opened.handle.close()
  }
}

export async function hashContainedFile(input: {
  readonly file: string
  readonly root: string
  readonly maxBytes: number
}) {
  const opened = await openContained(input.file, input.root, input.maxBytes)
  try {
    const digest = createHash("sha256")
    const buffer = Buffer.allocUnsafe(chunkBytes)
    let size = 0
    while (true) {
      const result = await opened.handle.read(buffer, 0, buffer.byteLength, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
      if (size > input.maxBytes) throw new Error("File exceeds byte limit")
      digest.update(buffer.subarray(0, result.bytesRead))
    }
    const final = await opened.handle.stat()
    if (!sameIdentity(opened.identity, final) || final.size !== size) {
      throw new Error("File changed while being hashed")
    }
    return { canonical: opened.canonical, sha256: digest.digest("hex"), size, mode: opened.identity.mode & 0o777 }
  } finally {
    await opened.handle.close()
  }
}

export async function inspectContainedFile(input: {
  readonly file: string
  readonly root: string
  readonly maxBytes: number
}) {
  const opened = await openContained(input.file, input.root, input.maxBytes)
  try {
    const identity = await opened.handle.stat({ bigint: true })
    if (
      opened.identity.dev !== Number(identity.dev) ||
      opened.identity.ino !== Number(identity.ino) ||
      opened.identity.size !== Number(identity.size)
    ) {
      throw new Error("File identity changed while being inspected")
    }
    return {
      canonical: opened.canonical,
      size: opened.identity.size,
      mode: opened.identity.mode & 0o777,
      dev: opened.identity.dev,
      ino: opened.identity.ino,
      mtimeNs: identity.mtimeNs.toString(),
      ctimeNs: identity.ctimeNs.toString(),
    }
  } finally {
    await opened.handle.close()
  }
}

export async function resolveDirectory(directory: string) {
  const canonical = await realpath(directory).catch((cause) => {
    if (hasCode(cause, "ENOENT")) return undefined
    throw cause
  })
  if (!canonical) return undefined
  const info = await lstat(canonical)
  return info.isDirectory() ? canonical : undefined
}

export async function inspectReference(input: {
  readonly reference: string
  readonly roots: ReadonlyArray<string>
  readonly maxBytes: number
}) {
  const decoded = referencePath(input.reference)
  if (decoded.status !== "accepted") return decoded
  const source = decoded.path
  const info = await lstat(source).catch((cause) => {
    if (hasCode(cause, "ENOENT")) return undefined
    throw cause
  })
  if (!info) return { status: "missing" as const, path: source }
  if (info.isSymbolicLink() || !info.isFile()) return { status: "rejected" as const, path: source }
  const canonical = await realpath(source)
  const root = input.roots.find((candidate) => inside(candidate, canonical))
  if (!root) return { status: "rejected" as const, path: source }
  return {
    status: "accepted" as const,
    path: source,
    root,
    ...(await inspectContainedFile({ file: source, root, maxBytes: input.maxBytes })),
  }
}

export async function copyContainedFile(input: {
  readonly source: string
  readonly sourceRoot: string
  readonly target: string
  readonly targetRoot: string
  readonly maxBytes: number
  readonly remainingBytes: number
}) {
  const source = await openContained(input.source, input.sourceRoot, Math.min(input.maxBytes, input.remainingBytes))
  try {
    if (source.identity.size > input.remainingBytes) {
      throw new Error("Session referenced files exceed byte limit")
    }
    const target = await open(
      input.target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      source.identity.mode & 0o777,
    )
    try {
      const canonical = await realpath(input.target)
      const identity = await lstat(canonical)
      const opened = await target.stat()
      if (!inside(input.targetRoot, canonical) || !identity.isFile() || !sameIdentity(identity, opened)) {
        throw new Error("Temporary destination escaped the target root")
      }
      const digest = createHash("sha256")
      const buffer = Buffer.allocUnsafe(chunkBytes)
      let size = 0
      while (true) {
        const result = await source.handle.read(buffer, 0, buffer.byteLength, null)
        if (result.bytesRead === 0) break
        size += result.bytesRead
        if (size > input.maxBytes) throw new Error("Referenced file exceeds byte limit")
        if (size > input.remainingBytes) throw new Error("Session referenced files exceed byte limit")
        digest.update(buffer.subarray(0, result.bytesRead))
        let offset = 0
        while (offset < result.bytesRead) {
          const written = await target.write(buffer, offset, result.bytesRead - offset, null)
          offset += written.bytesWritten
        }
      }
      const final = await source.handle.stat()
      if (!sameIdentity(source.identity, final) || final.size !== size) {
        throw new Error("Referenced file changed while being copied")
      }
      await target.chmod(source.identity.mode & 0o777)
      await target.sync()
      return { canonical: source.canonical, sha256: digest.digest("hex"), size, mode: source.identity.mode & 0o777 }
    } catch (cause) {
      await rm(input.target, { force: true })
      throw cause
    } finally {
      await target.close()
    }
  } finally {
    await source.handle.close()
  }
}

async function openContained(file: string, root: string, maxBytes: number) {
  const before = await lstat(file)
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Path is not a regular file")
  if (before.size > maxBytes) throw new Error("File exceeds byte limit")
  const canonical = await realpath(file)
  if (!inside(root, canonical)) throw new Error("File escapes the allowed source root")
  const canonicalIdentity = await lstat(canonical)
  if (!canonicalIdentity.isFile() || !sameIdentity(before, canonicalIdentity)) {
    throw new Error("File identity changed while resolving its canonical path")
  }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(canonicalIdentity, opened) || opened.size > maxBytes) {
      throw new Error("File identity changed before it was opened")
    }
    const recheckedCanonical = await realpath(file)
    const recheckedIdentity = await lstat(file)
    if (
      recheckedCanonical !== canonical ||
      !inside(root, recheckedCanonical) ||
      recheckedIdentity.isSymbolicLink() ||
      !sameIdentity(opened, recheckedIdentity)
    ) {
      throw new Error("File identity changed before it was read")
    }
    return { handle, canonical, identity: identity(opened) }
  } catch (cause) {
    await handle.close()
    throw cause
  }
}

function identity(value: Identity): Identity {
  return { dev: value.dev, ino: value.ino, size: value.size, mode: value.mode }
}

function sameIdentity(left: Pick<Identity, "dev" | "ino" | "size">, right: Pick<Identity, "dev" | "ino" | "size">) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function referencePath(reference: string) {
  if (path.isAbsolute(reference)) return boundedReferencePath(reference)
  if (!reference.startsWith("file:")) return { status: "ignored" as const }
  try {
    return boundedReferencePath(fileURLToPath(reference))
  } catch {
    return { status: "invalid" as const }
  }
}

function boundedReferencePath(value: string) {
  if (Buffer.byteLength(value) > referencePathMaxBytes) return { status: "rejected" as const, path: value }
  return { status: "accepted" as const, path: value }
}

function hasCode(value: unknown, code: string): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value && value.code === code
}
