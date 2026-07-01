import { fileURLToPath } from "url"
import { lazy } from "@opencode-ai/core/util/lazy"

function resolveWasm(asset: string): string {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const parserState = lazy(async () => {
  const { Parser, Language } = await import("web-tree-sitter")

  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  await Parser.init({ locateFile: () => resolveWasm(treeWasm) })

  const assetsDir = new URL("../../../assets/", import.meta.url)
  const tsWasmData = await Bun.file(new URL("tree-sitter-typescript.wasm", assetsDir)).bytes()
  const jsWasmData = await Bun.file(new URL("tree-sitter-javascript.wasm", assetsDir)).bytes()

  const tsLanguage = await Language.load(tsWasmData)
  const jsLanguage = await Language.load(jsWasmData)

  const tsParser = new Parser()
  tsParser.setLanguage(tsLanguage)
  const jsParser = new Parser()
  jsParser.setLanguage(jsLanguage)

  return { tsParser, jsParser }
})

const TS_EXTENSIONS = [".ts", ".tsx"]
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"]

export function isSourceFile(filename: string): boolean {
  return [...TS_EXTENSIONS, ...JS_EXTENSIONS].some((ext) => filename.endsWith(ext))
}

export function isTypeScript(filename: string): boolean {
  return TS_EXTENSIONS.some((ext) => filename.endsWith(ext))
}

export async function parseSource(
  filename: string,
  source: string,
): Promise<{ rootNode: import("web-tree-sitter").Node }> {
  const state = await parserState()
  const parser = isTypeScript(filename) ? state.tsParser : state.jsParser
  const tree = parser.parse(source)
  if (!tree) throw new Error(`Failed to parse ${filename}`)
  return { rootNode: tree.rootNode }
}
