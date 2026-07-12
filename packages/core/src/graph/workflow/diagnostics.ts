export * as GraphDiagnostics from "./diagnostics"

import type { DiagnosticName, VerificationSpec } from "@opencode-ai/schema/graph"
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs"
import path from "node:path"

export interface Command {
  readonly name: DiagnosticName
  readonly executable: "bun"
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly focused: boolean
  readonly targets: ReadonlyArray<Target>
}

export interface Target {
  readonly relative: string
  readonly input: string
  readonly canonical: string
  readonly root: string
  readonly fingerprint: string
}

export type Resolution =
  | {
      readonly ok: true
      readonly commands: ReadonlyArray<Command>
      readonly complete: boolean
      readonly projectChecksOnly: boolean
    }
  | {
      readonly ok: false
      readonly reason: "diagnostic_script_missing" | "verification_path_missing" | "verification_path_escape" | "verification_path_option"
      readonly path?: string
      readonly diagnostic?: DiagnosticName
    }

export async function resolve(input: {
  readonly directory: string
  readonly verification: VerificationSpec | null
  readonly filter?: string
}): Promise<Resolution> {
  const scripts = ((await Bun.file(path.join(input.directory, "package.json")).json().catch(() => ({ scripts: {} }))) as {
    scripts?: Record<string, string>
  }).scripts ?? {}
  const detected = (["test", "typecheck", "lint"] as const).filter((name) => typeof scripts[name] === "string")
  const required = input.verification?.diagnostics ?? []
  const missing = required.find((diagnostic) => !detected.includes(diagnostic.name))
  if (missing) return { ok: false, reason: "diagnostic_script_missing", diagnostic: missing.name }

  const root = realpathSync.native(input.directory)
  const targets = new Map<string, Target>()
  const focused = required.flatMap((diagnostic) => {
    if (!diagnostic.paths || diagnostic.paths.length === 0) return []
    return [{ diagnostic, paths: diagnostic.paths }]
  })
  for (const item of focused) {
    for (const relative of item.paths) {
      const segments = relative.split("/")
      if (segments[0]?.startsWith("-")) return { ok: false, reason: "verification_path_option", path: relative }
      if (
        path.isAbsolute(relative) ||
        path.win32.isAbsolute(relative) ||
        relative.includes("\\") ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) return { ok: false, reason: "verification_path_escape", path: relative }
      const absolute = path.resolve(root, ...relative.split("/"))
      let resolved: string
      try {
        resolved = realpathSync.native(absolute)
      } catch {
        return { ok: false, reason: "verification_path_missing", path: relative }
      }
      if (!contains(root, resolved)) return { ok: false, reason: "verification_path_escape", path: relative }
      targets.set(relative, await yieldTarget(root, relative, absolute, resolved))
    }
  }

  const focusedCommands = focused.map((item) =>
    command(
      item.diagnostic.name,
      ["run", item.diagnostic.name, "--", ...item.paths.flatMap((item) => targets.get(item)?.canonical ?? [])],
      true,
      item.paths.flatMap((item) => targets.get(item) ?? []),
    ),
  )
  const completeCommands = detected.length === 0 && input.verification === null
    ? [command("test", ["test"], false, [])]
    : detected.map((name) => command(name, ["run", name], false, []))
  const commands = [...focusedCommands, ...completeCommands]
  const selected = input.filter ? commands.filter((item) => item.name.includes(input.filter ?? "")) : commands
  return {
    ok: true,
    commands: selected,
    complete: input.filter === undefined && selected.length === commands.length && completeCommands.length > 0,
    projectChecksOnly: input.verification === null,
  }
}

function command(name: DiagnosticName, args: ReadonlyArray<string>, focused: boolean, targets: ReadonlyArray<Target>): Command {
  return { name, executable: "bun", args, command: ["bun", ...args].map(displayArg).join(" "), focused, targets }
}

export async function targetsUnchanged(command: Command) {
  const checks = await Promise.all(command.targets.map(async (target) => {
    try {
      const canonical = realpathSync.native(target.input)
      return canonical === target.canonical && (await fingerprint(target.root, target.relative, target.input, canonical)) === target.fingerprint
    } catch {
      return false
    }
  }))
  return checks.every(Boolean)
}

async function yieldTarget(root: string, relative: string, input: string, canonical: string): Promise<Target> {
  return { relative, input, canonical, root, fingerprint: await fingerprint(root, relative, input, canonical) }
}

async function fingerprint(root: string, relative: string, input: string, canonical: string) {
  const source = lstatSync(input)
  const target = statSync(canonical)
  const parents = path.relative(root, input).split(path.sep).slice(0, -1).map((_, index, segments) => {
    const parent = path.join(root, ...segments.slice(0, index + 1))
    return metadata(lstatSync(parent), realpathSync.native(parent))
  })
  const hash = target.isFile() ? new Bun.CryptoHasher("sha256").update(await Bun.file(canonical).arrayBuffer()).digest("hex") : ""
  return JSON.stringify({ relative, input, canonical, parents, source: metadata(source), target: metadata(target), hash })
}

function metadata(stat: Stats, realpath?: string) {
  return [realpath, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isFile(), stat.isDirectory(), stat.isSymbolicLink()]
}

function displayArg(value: string) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value)
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
