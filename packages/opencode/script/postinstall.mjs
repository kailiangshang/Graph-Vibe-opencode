#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))
const bin = Object.entries(packageJson.bin ?? {})[0]
if (!bin || typeof bin[1] !== "string") throw new Error(`${packageJson.name} must declare a package executable`)
const packageName = packageJson.name
const executable = bin[0]

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()
const base = `${executable}-${platform}-${arch}`
const sourceBinary = platform === "windows" ? `${executable}.exe` : executable
const launcher = path.resolve(__dirname, bin[1])
if (path.relative(__dirname, launcher).startsWith("..")) throw new Error(`${packageName} executable escapes its package`)
const targetBinary = path.join(path.dirname(launcher), `${executable}.exe`)

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()
  const dependencies = packageJson.optionalDependencies ?? {}

  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64")
        return (baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        ).filter((name) => Object.hasOwn(dependencies, name))
      return [`${base}-musl`, base].filter((name) => Object.hasOwn(dependencies, name))
    }

    if (arch === "x64")
      return (baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      ).filter((name) => Object.hasOwn(dependencies, name))
    return [base, `${base}-musl`].filter((name) => Object.hasOwn(dependencies, name))
  }

  if (arch === "x64")
    return (baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]).filter((name) =>
      Object.hasOwn(dependencies, name),
    )
  return [base].filter((name) => Object.hasOwn(dependencies, name))
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  return platformBinary(path.dirname(packageJsonPath), name, packageJson.optionalDependencies[name])
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${executable}-install-`))
  try {
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      { stdio: "inherit", windowsHide: true },
    )
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", name)
    copyBinary(platformBinary(packageDir, name, version), targetBinary)
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function platformBinary(packageDir, name, version) {
  const manifestPath = path.join(packageDir, "package.json")
  const manifestStat = fs.lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Package manifest must be a regular file at ${manifestPath}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest.name !== name) throw new Error(`Package at ${packageDir} must be named ${name}`)
  if (manifest.version !== version) throw new Error(`${name} must have version ${version}`)
  const binaryPath = path.join(packageDir, "bin", sourceBinary)
  const binaryStat = fs.lstatSync(binaryPath)
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) {
    throw new Error(`Binary must be a regular file at ${binaryPath}`)
  }
  return binaryPath
}

function copyBinary(source, target) {
  const sourceStat = fs.lstatSync(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Binary must be a regular file at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
}

function main() {
  const candidates = packageNames()
  for (const name of candidates) {
    try {
      copyBinary(resolveBinary(name), targetBinary)
      if (verifyBinary()) return
    } catch {}
    try {
      if (installPackage(name) && verifyBinary()) return
    } catch {}
  }

  if (candidates.length === 0) {
    throw new Error(
      `${packageName} does not declare a compatible ${executable} platform package. Reinstall ${packageName} for this platform.`,
    )
  }
  throw new Error(
    `It seems your package manager failed to install the right ${packageName} CLI package. Try manually installing ${candidates
      .map((name) => JSON.stringify(name))
      .join(" or ")}.`,
  )
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
