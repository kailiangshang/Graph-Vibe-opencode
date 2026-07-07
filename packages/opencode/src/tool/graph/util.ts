import type { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Artifact, FilesArtifactFile, PatchOperation } from "@opencode-ai/core/graph/workflow/artifact"
import { GraphArtifactDraft } from "@opencode-ai/core/graph/workflow/artifact-draft"
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

export interface ArtifactPathError {
  readonly _tag: "ArtifactPathError"
  readonly reason: "absolute_path" | "path_escape"
  readonly path: string
  readonly message: string
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

export function isArtifactPathError(value: unknown): value is ArtifactPathError {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "ArtifactPathError"
}

export function blockedArtifactPath(error: ArtifactPathError) {
  const repairHints = [
    "Use a relative path inside the current worktree.",
    "Remove absolute prefixes, drive letters, and ../ segments before retrying.",
  ]
  const metadata: Record<string, unknown> = {
    stage: "blocked",
    applied: false,
    files: [] as string[],
    buildable: [] as string[],
    reason: error.reason,
    path: error.path,
    message: error.message,
    repairHints,
  }
  return {
    title: "Artifact blocked",
    metadata,
    output: formatJson({
      applied: false,
      reason: error.reason,
      path: error.path,
      message: error.message,
      repairHints,
    }),
  }
}

export function blockedArtifactDraft(input: {
  readonly reason: string
  readonly draftID?: GraphArtifactDraft.DraftID
  readonly error?: GraphArtifactDraft.NotFoundError | GraphArtifactDraft.ValidationError
  readonly repairHints?: ReadonlyArray<string>
}) {
  const repairHints = input.repairHints ?? [
    "Use a draft from the current graph session and target node.",
    "If the draft failed validation, fix the declared files or chunks and retry.",
  ]
  const error = input.error === undefined ? undefined : draftError(input.error)
  const metadata: Record<string, unknown> = {
    stage: "blocked",
    applied: false,
    files: [] as string[],
    buildable: [] as string[],
    reason: input.reason,
    repairHints,
    ...(input.draftID === undefined ? {} : { draftID: input.draftID }),
    ...(error === undefined ? {} : { error }),
  }
  return {
    title: "Artifact blocked",
    metadata,
    output: formatJson({
      applied: false,
      reason: input.reason,
      repairHints,
      ...(input.draftID === undefined ? {} : { draftID: input.draftID }),
      ...(error === undefined ? {} : { error }),
    }),
  }
}

export function resolveArtifactPathsSafe(
  artifact: Artifact,
  instance: InstanceContext,
): ReadonlyArray<ArtifactPath> | ArtifactPathError {
  const normalized = artifactPaths(artifact).map((item) => normalizeArtifactPathSafe(item, instance))
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return Array.from(
    new Map(
      normalized.filter((item): item is ArtifactPath => !isArtifactPathError(item)).map((item) => [item.relative, item]),
    ).values(),
  )
}

export function normalizeArtifactSafe(artifact: Artifact, instance: InstanceContext): Artifact | ArtifactPathError {
  if (artifact.mode === "full") {
    const path = normalizeArtifactPathSafe({ relative: artifact.path }, instance)
    if (isArtifactPathError(path)) return path
    return { ...artifact, path: path.relative }
  }
  if (artifact.mode === "files") {
    const files = normalizeArtifactFiles(artifact.files, instance)
    if (isArtifactPathError(files)) return files
    return { ...artifact, files }
  }
  const operations = normalizeArtifactOperations(artifact.operations, instance)
  if (isArtifactPathError(operations)) return operations
  return { ...artifact, operations }
}

function artifactPaths(artifact: Artifact) {
  if (artifact.mode === "full") return [{ relative: artifact.path }]
  if (artifact.mode === "files") return artifact.files.map((file) => ({ relative: file.path }))
  return artifact.operations.map((operation) => ({ relative: operation.path }))
}

function normalizeArtifactFiles(files: ReadonlyArray<FilesArtifactFile>, instance: InstanceContext) {
  const normalized = files.map((file) => {
    const path = normalizeArtifactPathSafe({ relative: file.path }, instance)
    return isArtifactPathError(path) ? path : { ...file, path: path.relative }
  })
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return normalized.filter((file): file is FilesArtifactFile => !isArtifactPathError(file))
}

function normalizeArtifactOperations(operations: ReadonlyArray<PatchOperation>, instance: InstanceContext) {
  const normalized = operations.map((operation) => {
    const path = normalizeArtifactPathSafe({ relative: operation.path }, instance)
    return isArtifactPathError(path) ? path : { ...operation, path: path.relative }
  })
  const error = normalized.find(isArtifactPathError)
  if (error) return error
  return normalized.filter((operation): operation is PatchOperation => !isArtifactPathError(operation))
}

function normalizeArtifactPathSafe(
  input: { readonly relative: string },
  instance: InstanceContext,
): ArtifactPath | ArtifactPathError {
  if (path.isAbsolute(input.relative) || path.win32.isAbsolute(input.relative)) {
    return artifactPathError("absolute_path", input.relative, `Artifact path must be relative: ${input.relative}`)
  }

  const relative = path.posix.normalize(input.relative.replaceAll("\\", "/"))
  if (relative === "." || relative === ".." || relative.startsWith("../")) {
    return artifactPathError("path_escape", input.relative, `Artifact path escapes the worktree: ${input.relative}`)
  }

  const base = instance.worktree === "/" ? instance.directory : instance.worktree
  const absolute = path.resolve(base, ...relative.split("/"))
  if (!FSUtil.contains(base, absolute)) {
    return artifactPathError("path_escape", input.relative, `Artifact path escapes the worktree: ${input.relative}`)
  }

  return { relative, absolute }
}

function artifactPathError(reason: ArtifactPathError["reason"], inputPath: string, message: string): ArtifactPathError {
  return { _tag: "ArtifactPathError", reason, path: inputPath, message }
}

function draftError(error: GraphArtifactDraft.NotFoundError | GraphArtifactDraft.ValidationError) {
  if (error._tag === "GraphArtifactDraft.ValidationError") {
    return {
      rule: error.rule,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.index === undefined ? {} : { index: error.index }),
    }
  }
  return { id: error.id }
}
