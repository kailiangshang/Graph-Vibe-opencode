import type { Node as TSNode } from "web-tree-sitter"

export interface Symbol {
  readonly name: string
  readonly kind: "func" | "method" | "type" | "const" | "var"
  readonly startOffset: number
  readonly endOffset: number
  readonly startRow: number
  readonly startCol: number
}

export interface Import {
  readonly source: string
  readonly importedNames: string[]
}

export interface FileSymbols {
  readonly symbols: Symbol[]
  readonly imports: Import[]
}

const DECL_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "variable_declarator",
])

function nameOf(node: TSNode): string | null {
  const nameNode = node.childForFieldName("name")
  if (!nameNode) return null
  const text = nameNode.text
  if (!text || text === "") return null
  return text
}

function varKind(node: TSNode): "const" | "var" {
  const parent = node.parent
  if (!parent) return "var"
  const kw = parent.firstChild
  if (kw && kw.type === "const") return "const"
  return "var"
}

function extractImport(node: TSNode, source: string): Import | null {
  const sourceNode = node.childForFieldName("source")
  if (!sourceNode) return null
  const raw = sourceNode.text
  const modulePath = raw.replace(/^["'`]|["'`]$/g, "")

  const names: string[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!
    if (child === sourceNode) continue
    collectImportNames(child, names)
  }

  return { source: modulePath, importedNames: names }
}

function collectImportNames(node: TSNode, names: string[]): void {
  switch (node.type) {
    case "identifier":
    case "import_specifier": {
      const id = node.type === "import_specifier" ? node.childForFieldName("name") : node
      if (id && id.text) names.push(id.text)
      break
    }
    case "namespace_import": {
      const alias = node.childForFieldName("alias")
      if (alias && alias.text) names.push(alias.text)
      break
    }
    default:
      for (let i = 0; i < node.namedChildCount; i++) {
        collectImportNames(node.namedChild(i)!, names)
      }
  }
}

export function extractSymbols(rootNode: TSNode, source: string): FileSymbols {
  const symbols: Symbol[] = []
  const imports: Import[] = []
  const visited = new Set<TSNode>()

  function walk(node: TSNode) {
    if (DECL_TYPES.has(node.type) && !visited.has(node)) {
      visited.add(node)
      const name = nameOf(node)
      if (name) {
        let kind: Symbol["kind"]
        switch (node.type) {
          case "function_declaration":
          case "generator_function_declaration":
            kind = "func"
            break
          case "method_definition":
            kind = "method"
            break
          case "class_declaration":
          case "interface_declaration":
          case "type_alias_declaration":
          case "enum_declaration":
            kind = "type"
            break
          default:
            kind = varKind(node)
        }
        symbols.push({
          name,
          kind,
          startOffset: node.startIndex,
          endOffset: node.endIndex,
          startRow: node.startPosition.row,
          startCol: node.startPosition.column,
        })
      }
    }

    if (node.type === "import_statement") {
      const imp = extractImport(node, source)
      if (imp) imports.push(imp)
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i)!)
    }
  }

  walk(rootNode)
  return { symbols, imports }
}
