import { describe, expect, test } from "bun:test"
import { parseSource } from "@opencode-ai/core/graph/derivation/grammar"
import { extractSymbols } from "@opencode-ai/core/graph/derivation/symbols"

describe("symbols.extractSymbols", () => {
  test("extracts function declaration", async () => {
    const { rootNode } = await parseSource("test.ts", "function hello(): string { return 'world' }")
    const result = extractSymbols(rootNode, "function hello(): string { return 'world' }")
    expect(result.symbols.length).toBe(1)
    expect(result.symbols[0].name).toBe("hello")
    expect(result.symbols[0].kind).toBe("func")
  })

  test("extracts const and var", async () => {
    const code = "const x = 1\nlet y = 2\nvar z = 3"
    const { rootNode } = await parseSource("test.ts", code)
    const result = extractSymbols(rootNode, code)
    const kinds = result.symbols.map((s) => s.kind)
    expect(kinds).toContain("const")
    expect(kinds).toContain("var")
  })

  test("extracts class, interface, type, enum", async () => {
    const code = `
class Foo {}
interface Bar {}
type Baz = string
enum Qux { A, B }
`
    const { rootNode } = await parseSource("test.ts", code)
    const result = extractSymbols(rootNode, code)
    expect(result.symbols.map((s) => s.name)).toEqual(["Foo", "Bar", "Baz", "Qux"])
    expect(result.symbols.every((s) => s.kind === "type")).toBe(true)
  })

  test("extracts method inside class", async () => {
    const code = "class Foo { render() { return 1 } handleClick(): void {} }"
    const { rootNode } = await parseSource("test.ts", code)
    const result = extractSymbols(rootNode, code)
    const methods = result.symbols.filter((s) => s.kind === "method")
    expect(methods.map((m) => m.name)).toEqual(["render", "handleClick"])
  })

  test("extracts imports", async () => {
    const code = `import { foo, bar } from "./utils"\nimport baz from "lib"`
    const { rootNode } = await parseSource("test.ts", code)
    const result = extractSymbols(rootNode, code)
    expect(result.imports.length).toBe(2)
    expect(result.imports[0].source).toBe("./utils")
    expect(result.imports[0].importedNames).toEqual(["foo", "bar"])
    expect(result.imports[1].source).toBe("lib")
    expect(result.imports[1].importedNames).toEqual(["baz"])
  })

  test("symbol offsets are correct", async () => {
    const code = "function hello() {}"
    const { rootNode } = await parseSource("test.ts", code)
    const result = extractSymbols(rootNode, code)
    const sym = result.symbols[0]
    expect(code.slice(sym.startOffset, sym.endOffset)).toBe("function hello() {}")
  })
})
