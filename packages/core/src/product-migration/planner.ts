export * as ProductMigrationPlanner from "./planner"

import type { Discovery } from "./source"
import { posix, win32 } from "node:path"

export function plan(discovery: Discovery, input: { readonly currentProject?: string }) {
  return {
    sourceFingerprint: discovery.sourceFingerprint,
    categories: discovery.categories.map((category) => ({
      category: category.category,
      selected: category.available,
      estimatedBytes: category.estimatedBytes,
    })),
    sessionsEnabled: false,
    projects: discovery.projects.map((project) => {
      const current = isCurrentProject(project.path, input.currentProject)
      return {
        ...project,
        current,
        sessions: project.sessions.map((session, index) => ({ ...session, selected: current && index < 50 })),
      }
    }),
  }
}

function isCurrentProject(project: string, current: string | undefined) {
  if (!current) return false
  const paths = /^[A-Za-z]:[\\/]/.test(project) ? win32 : posix
  const relative = paths.relative(paths.resolve(project), paths.resolve(current))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
}
