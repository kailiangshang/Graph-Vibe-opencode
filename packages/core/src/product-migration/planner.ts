export * as ProductMigrationPlanner from "./planner"

import type { Discovery } from "./source"

export function plan(discovery: Discovery, input: { readonly currentProject?: string }) {
  return {
    sourceFingerprint: discovery.sourceFingerprint,
    categories: discovery.categories.map((category) => ({
      category: category.category,
      selected: category.available,
      estimatedBytes: category.estimatedBytes,
    })),
    sessionsEnabled: false,
    projects: discovery.projects.map((project) => ({
      ...project,
      current: project.path === input.currentProject,
      sessions: project.sessions.map((session) => ({ ...session, selected: false })),
    })),
  }
}
