import { describe, expect, test } from "bun:test"
import { parseSource } from "@opencode-ai/core/graph/derivation/grammar"
import { extractSymbols } from "@opencode-ai/core/graph/derivation/symbols"
import { buildFileGraph } from "@opencode-ai/core/graph/derivation/builder"

const PID = "proj_test" as any

async function build(code: string, relPath = "src/test.ts") {
  const { rootNode } = await parseSource(relPath, code)
  const syms = extractSymbols(rootNode, code)
  return buildFileGraph({ projectID: PID, relPath, source: code, fileSymbols: syms })
}

describe("builder.buildFileGraph", () => {
  test("creates file node with deterministic ID and code_hash", async () => {
    const result = await build("const x = 1")
    const fileNode = result.nodes.find((n) => n.category === "file")!
    expect(fileNode.id).toBe(`gnd_import:file:${PID}:src/test.ts`)
    expect(fileNode.codeHash).toHaveLength(64)
    expect(fileNode.confidence).toBe(1)
  })

  test("creates declaration nodes with deterministic IDs", async () => {
    const result = await build("function foo() {}\nconst bar = 1")
    const fooNode = result.nodes.find((n) => n.name === "foo")!
    expect(fooNode.id).toBe(`gnd_import:decl:${PID}:src/test.ts:func:foo`)
    expect(fooNode.category).toBe("func")
    expect(fooNode.confidence).toBe(0.95)

    const barNode = result.nodes.find((n) => n.name === "bar")!
    expect(barNode.id).toBe(`gnd_import:decl:${PID}:src/test.ts:const:bar`)
    expect(barNode.category).toBe("const")
  })

  test("creates contains edges from file to each declaration", async () => {
    const result = await build("function foo() {}\nfunction bar() {}")
    const containsEdges = result.edges.filter((e) => e.relation === "contains")
    expect(containsEdges.length).toBe(2)
  })

  test("code_hash differs for different source", async () => {
    const a = await build("function foo() { return 1 }")
    const b = await build("function foo() { return 2 }")
    expect(a.nodes.find((n) => n.name === "foo")!.codeHash).not.toBe(
      b.nodes.find((n) => n.name === "foo")!.codeHash,
    )
  })

  test("deterministic IDs are stable across runs", async () => {
    const a = await build("function foo() {}")
    const b = await build("function foo() {}")
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id))
  })

  test("content has code_ref with path and offsets", async () => {
    const result = await build("function foo() {}")
    const fooNode = result.nodes.find((n) => n.name === "foo")!
    const ref = fooNode.content.code_ref as Record<string, unknown>
    expect(ref.path).toBe("src/test.ts")
    expect(ref.type).toBe("declaration")
    expect(typeof ref.start_offset).toBe("number")
    expect(typeof ref.end_offset).toBe("number")
  })
})
