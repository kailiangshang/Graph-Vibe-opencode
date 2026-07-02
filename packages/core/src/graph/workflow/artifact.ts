export * as GraphArtifact from "./artifact"

export interface FullArtifact {
  readonly mode: "full"
  readonly path: string
  readonly code: string
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

export type Artifact = FullArtifact | PatchArtifact

export interface ArtifactIssue {
  readonly code:
    | "empty_path"
    | "empty_code"
    | "empty_test"
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
  return [
    artifact.path.length === 0 ? { code: "empty_path" as const, message: "full artifact path is required" } : undefined,
    artifact.code.length === 0
      ? { code: "empty_code" as const, path: artifact.path || undefined, message: "full artifact code is required" }
      : undefined,
    artifact.test.length === 0
      ? { code: "empty_test" as const, path: artifact.path || undefined, message: "full artifact test is required" }
      : undefined,
  ].filter((issue): issue is ArtifactIssue => issue !== undefined)
}

function validatePatchArtifact(artifact: PatchArtifact): ArtifactIssue[] {
  if (artifact.operations.length === 0) return [{ code: "empty_patch", message: "patch artifact needs at least one operation" }]
  return artifact.operations.flatMap((operation) => [
    operation.path.length === 0 ? { code: "empty_path" as const, message: "patch operation path is required" } : undefined,
    operation.old.length === 0
      ? { code: "empty_old" as const, path: operation.path || undefined, message: "patch operation old text is required" }
      : undefined,
  ]).filter((issue): issue is ArtifactIssue => issue !== undefined)
}
