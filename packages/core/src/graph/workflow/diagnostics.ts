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

export interface Skipped {
  readonly name: DiagnosticName
  readonly paths: ReadonlyArray<string>
  readonly reason: "unsupported_focused_paths"
}

export type Resolution =
  | {
      readonly ok: true
      readonly commands: ReadonlyArray<Command>
      readonly skipped: ReadonlyArray<Skipped>
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
  const configured = (["test", "typecheck", "lint"] as const).filter((name) => typeof scripts[name] === "string")
  const detected = configured.filter((name) => isRunnableScript(scripts[name]))
  const required = input.verification?.diagnostics ?? []
  const missing = required.find((diagnostic) => !detected.includes(diagnostic.name))
  if (missing) return { ok: false, reason: "diagnostic_script_missing", diagnostic: missing.name }

  const root = realpathSync.native(input.directory)
  const targets = new Map<string, Target>()
  const requestedFocused = required.flatMap((diagnostic) => {
    if (!diagnostic.paths || diagnostic.paths.length === 0) return []
    return [{ diagnostic, paths: diagnostic.paths }]
  })
  for (const item of requestedFocused) {
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

  const focused = requestedFocused.flatMap((item) => {
    const script = scripts[item.diagnostic.name]
    if (typeof script !== "string") return []
    const paths = item.paths.filter((relative) => supportsFocusedPath(item.diagnostic.name, scripts, relative))
    return paths.length > 0 ? [{ diagnostic: item.diagnostic, paths }] : []
  })
  const skipped = requestedFocused.flatMap((item) => {
    const script = scripts[item.diagnostic.name]
    if (typeof script !== "string") return []
    const paths = item.paths.filter((relative) => !supportsFocusedPath(item.diagnostic.name, scripts, relative))
    return paths.length > 0
      ? [{ name: item.diagnostic.name, paths, reason: "unsupported_focused_paths" as const }]
      : []
  })

  const focusedCommands = focused.map((item) =>
    command(
      item.diagnostic.name,
      ["run", item.diagnostic.name, "--", ...item.paths.flatMap((item) => targets.get(item)?.canonical ?? [])],
      true,
      item.paths.flatMap((item) => targets.get(item) ?? []),
    ),
  )
  const completeCommands = configured.length === 0 && input.verification === null
    ? [command("test", ["test"], false, [])]
    : detected.map((name) => command(name, ["run", name], false, []))
  const commands = [...focusedCommands, ...completeCommands]
  const selected = input.filter ? commands.filter((item) => item.name.includes(input.filter ?? "")) : commands
  const selectedSkipped = input.filter ? skipped.filter((item) => item.name.includes(input.filter ?? "")) : skipped
  return {
    ok: true,
    commands: selected,
    skipped: selectedSkipped,
    complete: input.filter === undefined && selected.length === commands.length && completeCommands.length > 0,
    projectChecksOnly: input.verification === null,
  }
}

function isRunnableScript(script: string | undefined) {
  if (!script) return false
  const guard = /^\s*(?:echo|printf)\s+("[^"]*"|'[^']*'|[^;&\n]+?)\s*(?:&&|;|\n)\s*exit\s+1\s*;?\s*(?:#.*)?$/is.exec(script)
  if (!guard) return true
  const message = guard[1]
  if (message.startsWith("'") && !message.endsWith("'")) return true
  if (message.startsWith('"') && (!message.endsWith('"') || /[$`\\]/.test(message))) return true
  if (!message.startsWith("'") && !message.startsWith('"') && /[|<>$`()\\]/.test(message)) return true
  return !/(?:do not|don't|must not|cannot|can't)(?:\s+be)?\s+run/i.test(message)
}

function supportsFocusedPath(name: DiagnosticName, scripts: Record<string, string>, relative: string) {
  if (name !== "lint" || !isOxlintScript("lint", scripts, new Set())) return true
  return !/\.mdx?$/i.test(relative)
}

function isOxlintScript(name: string, scripts: Record<string, string>, seen: Set<string>): boolean {
  if (seen.has(name)) return false
  seen.add(name)
  const script = scripts[name]?.trim()
  if (!script) return false
  const executable = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(script)
  if (path.basename(executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? "") === "oxlint") return true
  if (/^(?:bunx|npx)(?:\s+--?(?:[\w-]+(?:=[^\s]+)?)?)*\s+oxlint(?:@[^\s]+)?(?:\s|$)/.test(script)) return true
  if (/^(?:npm|pnpm)\s+exec(?:\s+--?(?:[\w-]+(?:=[^\s]+)?)?)*\s+oxlint(?:@[^\s]+)?(?:\s|$)/.test(script)) return true
  if (/^(?:pnpm|yarn)\s+dlx(?:\s+--?(?:[\w-]+(?:=[^\s]+)?)?)*\s+oxlint(?:@[^\s]+)?(?:\s|$)/.test(script)) return true
  if (/^bun\s+x(?:\s+--?(?:[\w-]+(?:=[^\s]+)?)?)*\s+oxlint(?:@[^\s]+)?(?:\s|$)/.test(script)) return true
  const delegated = /^(?:bun|npm|pnpm|yarn)\s+run\s+([^\s;&]+)/.exec(script)
  if (delegated) return isOxlintScript(delegated[1], scripts, seen)
  const shorthand = /^(?:pnpm|yarn)\s+([^\s;&]+)/.exec(script)
  return shorthand && scripts[shorthand[1]] ? isOxlintScript(shorthand[1], scripts, seen) : false
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
