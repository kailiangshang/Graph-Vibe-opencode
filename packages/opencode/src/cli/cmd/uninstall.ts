import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { Product } from "@opencode-ai/core/product"
import { CliError } from "../effect-cmd"
import { errorMessage } from "@/util/error"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export function uninstallPackageCommand(profile: Product.Profile, method: Installation.Method) {
  const packageName = Installation.packageName(profile, method)
  const commands: Partial<Record<Installation.Method, string[]>> = {
    npm: ["npm", "uninstall", "-g", packageName],
    pnpm: ["pnpm", "uninstall", "-g", packageName],
    bun: ["bun", "remove", "-g", packageName],
    yarn: ["yarn", "global", "remove", packageName],
    brew: ["brew", "uninstall", packageName],
    choco: ["choco", "uninstall", packageName],
    scoop: ["scoop", "uninstall", packageName],
  }
  return commands[method]
}

export function uninstallShellIdentity(profile: Product.Profile) {
  return { marker: `# ${profile.id}`, bin: `.${profile.storage}/bin` }
}

export const UninstallCommand = {
  command: "uninstall",
  describe: `uninstall ${Product.commandName()} and remove all related files`,
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    const profile = Product.current()
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro(`Uninstall ${profile.name}`)

    const method = await Installation.method(profile)
    prompts.log.info(`Installation method: ${method}`)
    const errors: string[] = []

    const targets = await collectRemovalTargets(args, method, profile, errors)

    await showRemovalSummary(targets, method, profile, errors)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      throwIfFailed(errors)
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets, profile, errors)
    throwIfFailed(errors)

    UI.empty()
    prompts.log.success(`Thank you for using ${profile.name}!`)
    prompts.outro("Done")
  },
}

async function collectRemovalTargets(
  args: UninstallArgs,
  method: Installation.Method,
  profile: Product.Profile,
  errors: string[],
): Promise<RemovalTargets> {
  const paths = Global.paths(profile)
  const directories: RemovalTargets["directories"] = [
    { path: paths.data, label: "Data", keep: args.keepData },
    { path: paths.cache, label: "Cache", keep: false },
    { path: paths.config, label: "Config", keep: args.keepConfig },
    { path: paths.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile(profile, errors) : null
  const binary = method === "curl" && profile === Product.OpenCode ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(
  targets: RemovalTargets,
  method: Installation.Method,
  profile: Product.Profile,
  errors: string[],
) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await pathExists(dir.path, dir.label, errors)
    if (!exists) continue

    const size = await getDirectorySize(dir.path, dir.label, errors)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    prompts.log.info(`  ✓ Package: ${uninstallPackageCommand(profile, method)?.join(" ") ?? method}`)
  }
}

async function executeUninstall(
  method: Installation.Method,
  targets: RemovalTargets,
  profile: Product.Profile,
  errors: string[],
) {
  const spinner = prompts.spinner()

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await pathExists(dir.path, dir.label, errors)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      addError(errors, `${dir.label}: ${errorMessage(err)}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig, profile).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      addError(errors, `Shell config: ${errorMessage(err)}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmd = uninstallPackageCommand(profile, method)
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await Process.run(method === "choco" ? [...cmd, "-y", "-r"] : cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        addError(errors, `Package: ${cmd.join(" ")} exited with code ${result.code}`)
        const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        if (method === "choco" && text.includes("not running from an elevated command shell")) {
          prompts.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
        } else {
          prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        }
      } else {
        spinner.stop("Package removed")
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(`.${profile.storage}`)) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

}

async function getShellConfigFile(profile: Product.Profile, errors: string[]): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await pathExists(file, `Shell config ${shortenPath(file)}`, errors)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch((error) => {
      addError(errors, `Shell config ${shortenPath(file)}: ${errorMessage(error)}`)
      return ""
    })
    const identity = uninstallShellIdentity(profile)
    if (content.includes(identity.marker) || content.includes(identity.bin)) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string, profile: Product.Profile) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")
  const identity = uninstallShellIdentity(profile)

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === identity.marker) {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(identity.bin) || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(identity.bin)) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(`.${profile.storage}`))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string, label: string, errors: string[]): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (!isMissingPath(error)) addError(errors, `${label}: ${errorMessage(error)}`)
      return []
    })

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch((error) => {
          if (!isMissingPath(error)) addError(errors, `${label}: ${errorMessage(error)}`)
          return null
        })
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

async function pathExists(file: string, label: string, errors: string[]) {
  const error = await fs.access(file).then(
    () => undefined,
    (error) => error,
  )
  if (!error) return true
  if (isMissingPath(error)) return false
  addError(errors, `${label}: ${errorMessage(error)}`)
  return false
}

function isMissingPath(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function addError(errors: string[], error: string) {
  if (!errors.includes(error)) errors.push(error)
}

function throwIfFailed(errors: string[]) {
  if (errors.length === 0) return
  UI.empty()
  prompts.log.warn("Some operations failed:")
  for (const error of errors) {
    prompts.log.error(`  ${error}`)
  }
  prompts.outro("Uninstall incomplete")
  throw new CliError({ message: "Uninstall failed; review the errors above." })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
