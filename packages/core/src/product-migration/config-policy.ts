export * as ProductMigrationConfigPolicy from "./config-policy"

export const directories = new Set(["agents", "commands", "skills", "themes", "references", "plugins", "plugin"])
export const copiedRootFiles = new Set(["tui.json", "tui.jsonc"])
export const manifestRootFiles = new Set([
  "config.json",
  "opencode.json",
  "opencode.jsonc",
  "tui.json",
  "tui.jsonc",
  "package.json",
])

const disposable = new Set([
  "node_modules",
  ".cache",
  "cache",
  ".logs",
  "logs",
  "target",
  "dist",
  "build",
  "coverage",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
])

export function isDisposable(name: string) {
  return disposable.has(name)
}
