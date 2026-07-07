import { describe, expect, test } from "bun:test"
import { hashContent, planArtifactApplication, validateArtifact } from "@opencode-ai/core/graph/workflow/artifact"

describe("Graph Artifact", () => {
  test("full artifact requires path, code, and test", () => {
    expect(validateArtifact({ mode: "full", path: "", code: "", test: "" }).map((issue) => issue.code)).toEqual([
      "empty_path",
      "empty_code",
      "empty_test",
    ])
  })

  test("valid full artifact plans a complete file replacement", () => {
    const result = planArtifactApplication(
      { mode: "full", path: "src/a.ts", code: "export const n = 1\n", test: "test('n', () => {})\n" },
      {},
    )

    expect(result.valid).toBe(true)
    expect(result.files["src/a.ts"]).toBe("export const n = 1\n")
  })

  test("files artifact requires at least one file and test", () => {
    expect(validateArtifact({ mode: "files", files: [], test: "" }).map((issue) => issue.code)).toEqual([
      "empty_test",
      "empty_files",
    ])
  })

  test("files artifact validates each file path and code", () => {
    expect(
      validateArtifact({
        mode: "files",
        test: "bun test\n",
        files: [
          { path: "", code: "" },
          { path: "src/ok.ts", code: "export const ok = true\n" },
        ],
      }).map((issue) => issue.code),
    ).toEqual(["empty_path", "empty_code"])
  })

  test("valid files artifact plans multiple complete file replacements", () => {
    const result = planArtifactApplication(
      {
        mode: "files",
        test: "bun test\n",
        files: [
          { path: "src/a.ts", code: "export const a = 1\n" },
          { path: "src/b.ts", code: "export const b = 2\n" },
        ],
      },
      { "src/a.ts": "old a\n" },
    )

    expect(result.valid).toBe(true)
    expect(result.files).toMatchObject({
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 2\n",
    })
  })

  test("patch artifact validates preimage hash before replacing old text", () => {
    const current = "export const n = 1\n"
    const result = planArtifactApplication(
      {
        mode: "patch",
        operations: [{ path: "src/a.ts", preimageHash: hashContent(current), old: "n = 1", replacement: "n = 2" }],
      },
      { "src/a.ts": current },
    )

    expect(result.valid).toBe(true)
    expect(result.files["src/a.ts"]).toBe("export const n = 2\n")
  })

  test("patch artifact reports hash mismatch and does not apply", () => {
    const result = planArtifactApplication(
      {
        mode: "patch",
        operations: [{ path: "src/a.ts", preimageHash: "bad", old: "n = 1", replacement: "n = 2" }],
      },
      { "src/a.ts": "export const n = 1\n" },
    )

    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("preimage_hash_mismatch")
    expect(result.files["src/a.ts"]).toBe("export const n = 1\n")
  })

  test("patch artifact reports missing old text and preserves file", () => {
    const current = "export const n = 1\n"
    const result = planArtifactApplication(
      {
        mode: "patch",
        operations: [{ path: "src/a.ts", preimageHash: hashContent(current), old: "missing", replacement: "n = 2" }],
      },
      { "src/a.ts": current },
    )

    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain("old_text_not_found")
    expect(result.files["src/a.ts"]).toBe(current)
  })
})
