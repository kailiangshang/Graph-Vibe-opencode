export * as GraphArtifact from "./artifact"

export interface FullArtifact {
  readonly mode: "full"
  readonly path: string
  readonly code: string
  readonly test: string
}

export interface FilesArtifactFile {
  readonly path: string
  readonly code: string
}

export interface FilesArtifact {
  readonly mode: "files"
  readonly files: ReadonlyArray<FilesArtifactFile>
  readonly test: string
}

export interface PatchOperation {
  readonly path: string
  readonly preimageHash: string
  readonly old: string
  readonly replacement: string
}

export interface PatchArtifact {
  readonly mode: "patch"
  readonly operations: ReadonlyArray<PatchOperation>
}

export type Artifact = FullArtifact | FilesArtifact | PatchArtifact

export interface ArtifactIssue {
  readonly code:
    | "empty_path"
    | "empty_code"
    | "empty_test"
    | "empty_files"
    | "empty_patch"
    | "empty_old"
    | "preimage_hash_mismatch"
    | "old_text_not_found"
  readonly path?: string
  readonly message: string
}

export interface ArtifactApplyResult {
  readonly valid: boolean
  readonly issues: ReadonlyArray<ArtifactIssue>
  readonly files: Record<string, string>
}

export function hashContent(content: string) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return hasher.digest("hex")
}

export function validateArtifact(artifact: Artifact): ArtifactIssue[] {
  if (artifact.mode === "full") return validateFullArtifact(artifact)
  if (artifact.mode === "files") return validateFilesArtifact(artifact)
  return validatePatchArtifact(artifact)
}

export function planArtifactApplication(
  artifact: Artifact,
  files: Readonly<Record<string, string>>,
): ArtifactApplyResult {
  const formatIssues = validateArtifact(artifact)
  if (artifact.mode === "full") {
    if (formatIssues.length > 0) return { valid: false, issues: formatIssues, files: { ...files } }
    return { valid: true, issues: [], files: { ...files, [artifact.path]: artifact.code } }
  }

  if (artifact.mode === "files") {
    if (formatIssues.length > 0) return { valid: false, issues: formatIssues, files: { ...files } }
    return {
      valid: true,
      issues: [],
      files: { ...files, ...Object.fromEntries(artifact.files.map((file) => [file.path, file.code])) },
    }
  }

  const result = { ...files }
  const issues = [...formatIssues]
  for (const operation of artifact.operations) {
    const current = result[operation.path] ?? ""
    if (hashContent(current) !== operation.preimageHash) {
      issues.push({
        code: "preimage_hash_mismatch",
        path: operation.path,
        message: `preimage hash mismatch for ${operation.path}`,
      })
      continue
    }
    if (!current.includes(operation.old)) {
      issues.push({ code: "old_text_not_found", path: operation.path, message: `old text not found in ${operation.path}` })
      continue
    }
    result[operation.path] = current.replace(operation.old, operation.replacement)
  }

  if (issues.length > 0) return { valid: false, issues, files: { ...files } }
  return { valid: true, issues: [], files: result }
}

function validateFullArtifact(artifact: FullArtifact): ArtifactIssue[] {
  const issues: ArtifactIssue[] = []
  if (artifact.path.length === 0) issues.push({ code: "empty_path", message: "full artifact path is required" })
  if (artifact.code.length === 0) {
    issues.push({ code: "empty_code", path: artifact.path || undefined, message: "full artifact code is required" })
  }
  if (artifact.test.length === 0) {
    issues.push({ code: "empty_test", path: artifact.path || undefined, message: "full artifact test is required" })
  }
  return issues
}

function validateFilesArtifact(artifact: FilesArtifact): ArtifactIssue[] {
  return [
    ...(artifact.test.length === 0 ? [{ code: "empty_test" as const, message: "files artifact test is required" }] : []),
    ...(artifact.files.length === 0 ? [{ code: "empty_files" as const, message: "files artifact needs at least one file" }] : []),
    ...artifact.files.flatMap((file) => {
      const issues: ArtifactIssue[] = []
      if (file.path.length === 0) issues.push({ code: "empty_path", message: "files artifact file path is required" })
      if (file.code.length === 0) {
        issues.push({ code: "empty_code", path: file.path || undefined, message: "files artifact file code is required" })
      }
      return issues
    }),
  ]
}

function validatePatchArtifact(artifact: PatchArtifact): ArtifactIssue[] {
  if (artifact.operations.length === 0) return [{ code: "empty_patch", message: "patch artifact needs at least one operation" }]
  return artifact.operations.flatMap((operation) => {
    const issues: ArtifactIssue[] = []
    if (operation.path.length === 0) issues.push({ code: "empty_path", message: "patch operation path is required" })
    if (operation.old.length === 0) {
      issues.push({ code: "empty_old", path: operation.path || undefined, message: "patch operation old text is required" })
    }
    return issues
  })
}
