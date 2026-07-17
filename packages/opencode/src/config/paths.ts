export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Product } from "@opencode-ai/core/product"

export type Directory = {
  path: string
  name: "opencode" | "graph-vibe"
  writable: boolean
}

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const profile = Product.current()
  const graph = profile === Product.GraphVibe
  const projectOpen = !Flag.OPENCODE_DISABLE_PROJECT_CONFIG
    ? yield* afs.up({ targets: [".opencode"], start: directory, stop: worktree })
    : []
  const projectGraph = graph && !Flag.OPENCODE_DISABLE_PROJECT_CONFIG
    ? yield* afs.up({ targets: [".graph-vibe"], start: directory, stop: worktree })
    : []
  const homeOpen = yield* afs.up({ targets: [".opencode"], start: Global.Path.home, stop: Global.Path.home })
  const homeGraph = graph
    ? yield* afs.up({ targets: [".graph-vibe"], start: Global.Path.home, stop: Global.Path.home })
    : []
  const configDir = graph ? Flag.GRAPH_VIBE_CONFIG_DIR : Flag.OPENCODE_CONFIG_DIR
  const sources: Directory[] = [
    { path: Global.Path.config, name: profile.config, writable: true },
    ...projectOpen.map((item) => ({ path: item, name: "opencode" as const, writable: !graph })),
    ...homeOpen.map((item) => ({ path: item, name: "opencode" as const, writable: !graph })),
    ...projectGraph.map((item) => ({ path: item, name: "graph-vibe" as const, writable: true })),
    ...homeGraph.map((item) => ({ path: item, name: "graph-vibe" as const, writable: true })),
    ...(configDir ? [{ path: configDir, name: profile.config, writable: true }] : []),
  ]
  return unique(sources.map((item) => item.path)).flatMap((item) => {
    const source = sources.find((candidate) => candidate.path === item)
    return source ? [source] : []
  })
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
