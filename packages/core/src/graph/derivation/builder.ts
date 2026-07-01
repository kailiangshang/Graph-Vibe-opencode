import { createHash } from "crypto"
import type { ProjectV2 } from "@opencode-ai/core/project"
import type { NodeContent } from "@opencode-ai/schema/graph"
import type { FileSymbols } from "./symbols"

export interface ExpectedNode {
  readonly id: string
  readonly type: "atomic"
  readonly name: string
  readonly level: "L2"
  readonly category: string
  readonly content: NodeContent
  readonly codeHash: string
  readonly confidence: number
}

export interface ExpectedEdge {
  readonly id: string
  readonly sourceId: string
  readonly targetId: string
  readonly relation: "contains" | "uses"
}

export interface BuildInput {
  readonly projectID: ProjectV2.ID
  readonly relPath: string
  readonly source: string
  readonly fileSymbols: FileSymbols
}

export interface BuildResult {
  readonly nodes: ExpectedNode[]
  readonly edges: ExpectedEdge[]
  readonly codeHash: string
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export function buildFileGraph(input: BuildInput): BuildResult {
  const { projectID, relPath, source, fileSymbols } = input
  const normalizedPath = relPath.replace(/\\/g, "/")
  const fileHash = sha256(source)
  const fileID = `gnd_import:file:${projectID}:${normalizedPath}`

  const fileNode: ExpectedNode = {
    id: fileID,
    type: "atomic",
    name: normalizedPath,
    level: "L2",
    category: "file",
    content: { code_ref: { path: normalizedPath, type: "file" } },
    codeHash: fileHash,
    confidence: 1,
  }

  const nodes: ExpectedNode[] = [fileNode]
  const edges: ExpectedEdge[] = []

  const declNameMap = new Map<string, string>()

  for (const sym of fileSymbols.symbols) {
    const declID = `gnd_import:decl:${projectID}:${normalizedPath}:${sym.kind}:${sym.name}`
    const declText = source.slice(sym.startOffset, sym.endOffset)
    nodes.push({
      id: declID,
      type: "atomic",
      name: sym.name,
      level: "L2",
      category: sym.kind,
      content: {
        code_ref: {
          path: normalizedPath,
          type: "declaration",
          start_offset: sym.startOffset,
          end_offset: sym.endOffset,
        },
      },
      codeHash: sha256(declText),
      confidence: 0.95,
    })
    declNameMap.set(sym.name, declID)

    edges.push({
      id: `ged_import:contains:${fileID}:${declID}`,
      sourceId: fileID,
      targetId: declID,
      relation: "contains",
    })
  }

  for (const imp of fileSymbols.imports) {
    for (const importedName of imp.importedNames) {
      const targetDeclID = declNameMap.get(importedName)
      if (!targetDeclID) continue
      for (const [, sourceDeclID] of declNameMap) {
        if (sourceDeclID === targetDeclID) continue
        edges.push({
          id: `ged_import:uses:${sourceDeclID}:${targetDeclID}`,
          sourceId: sourceDeclID,
          targetId: targetDeclID,
          relation: "uses",
        })
      }
    }
  }

  return { nodes, edges, codeHash: fileHash }
}

export interface ExpectedGraph {
  readonly nodes: ExpectedNode[]
  readonly edges: ExpectedEdge[]
}

export function buildExpectedGraph(files: BuildResult[]): ExpectedGraph {
  return {
    nodes: files.flatMap((f) => f.nodes),
    edges: files.flatMap((f) => f.edges),
  }
}
