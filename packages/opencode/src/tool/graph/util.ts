import type { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Artifact } from "@opencode-ai/core/graph/workflow/artifact"
import type { GateResult } from "@opencode-ai/core/graph/workflow/gate"
import path from "path"
import { Effect } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Tool } from "../tool"

export interface GraphSession {
  readonly projectID: ProjectV2.ID
  readonly sessionID: SessionID
  readonly directory: string
}

export interface ArtifactPath {
  readonly relative: string
  readonly absolute: string
}

export function resolveGraphSession(
  ctx: Tool.Context,
  sessions: Session.Interface,
): Effect.Effect<GraphSession, Session.NotFound> {
  return Effect.gen(function* () {
    const session = yield* sessions.get(ctx.sessionID)
    return { projectID: session.projectID, sessionID: ctx.sessionID, directory: session.directory }
  })
}

export function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "undefined"
}

export function summarizeGate(result: GateResult) {
  if (result.allowed) return "allowed"
  return `blocked:${result.issues.length}`
}

export function resolveArtifactPaths(artifact: Artifact, instance: InstanceContext): ReadonlyArray<ArtifactPath> {
  return Array.from(new Map(artifactPaths(artifact).map((item) => [item.relative, item])).values())
    .map((item) => normalizeArtifactPath(item, instance))
}

export function normalizeArtifact(artifact: Artifact, instance: InstanceContext): Artifact {
  if (artifact.mode === "full") return { ...artifact, path: normalizeArtifactPath({ relative: artifact.path }, instance).relative }
  if (artifact.mode === "files") {
    return {
      ...artifact,
      files: artifact.files.map((file) => ({
        ...file,
        path: normalizeArtifactPath({ relative: file.path }, instance).relative,
      })),
    }
  }
  return {
    ...artifact,
    operations: artifact.operations.map((operation) => ({
      ...operation,
      path: normalizeArtifactPath({ relative: operation.path }, instance).relative,
    })),
  }
}

function artifactPaths(artifact: Artifact) {
  if (artifact.mode === "full") return [{ relative: artifact.path }]
  if (artifact.mode === "files") return artifact.files.map((file) => ({ relative: file.path }))
  return artifact.operations.map((operation) => ({ relative: operation.path }))
}

function normalizeArtifactPath(input: { readonly relative: string }, instance: InstanceContext): ArtifactPath {
  if (path.isAbsolute(input.relative) || path.win32.isAbsolute(input.relative)) {
    throw new Error(`Artifact path must be relative: ${input.relative}`)
  }

  const relative = path.posix.normalize(input.relative.replaceAll("\\", "/"))
  if (relative === "." || relative === ".." || relative.startsWith("../")) {
    throw new Error(`Artifact path escapes the worktree: ${input.relative}`)
  }

  const base = instance.worktree === "/" ? instance.directory : instance.worktree
  const absolute = path.resolve(base, ...relative.split("/"))
  if (!FSUtil.contains(base, absolute)) {
    throw new Error(`Artifact path escapes the worktree: ${input.relative}`)
  }

  return { relative, absolute }
}
