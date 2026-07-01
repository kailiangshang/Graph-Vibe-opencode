export * as GraphDerivation from "./derive"

import { resolve, relative } from "path"
import { Context, Effect, Exit, Layer } from "effect"
import * as GraphStorage from "../storage"
import type { NodeID, EdgeID, NodeRow, EdgeRow, GraphView } from "../storage"
import type { ProjectV2 } from "../../project"
import { parseSource, isSourceFile } from "./grammar"
import { extractSymbols } from "./symbols"
import { buildFileGraph, buildExpectedGraph } from "./builder"
import type { ExpectedGraph, ExpectedNode, ExpectedEdge } from "./builder"
import { checkConsistency } from "./checker"
import type { ConsistencyIssue } from "./checker"
import { buildReconciliationPlan } from "./reconcile"

export interface ScanResult {
  readonly expected: ExpectedGraph
  readonly filesScanned: number
}

export interface ReconciliationResult {
  readonly nodesAdded: number
  readonly nodesUpdated: number
  readonly nodesRemoved: number
  readonly edgesAdded: number
  readonly edgesRemoved: number
  readonly intentStaleMarked: number
  readonly issues: ConsistencyIssue[]
}

export interface Interface {
  readonly scan: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<ScanResult>
  readonly checkConsistency: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<ConsistencyIssue[]>
  readonly reconcile: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<ReconciliationResult>
  readonly sync: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<ReconciliationResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphDerivation") {}

const SKIP_DIRS = ["node_modules", ".git", "dist", ".next", "coverage", ".turbo"]

function shouldSkip(path: string): boolean {
  return SKIP_DIRS.some((d) => path.includes(`/${d}/`) || path.startsWith(`${d}/`))
}

function expectedToNodeCreate(projectID: ProjectV2.ID, node: ExpectedNode): GraphStorage.NodeCreate {
  return {
    projectID,
    id: node.id,
    type: node.type,
    name: node.name,
    level: node.level,
    category: node.category,
    status: "implemented",
    content: node.content,
    codeHash: node.codeHash,
    confidence: node.confidence,
  }
}

function expectedToEdgeCreate(projectID: ProjectV2.ID, edge: ExpectedEdge): GraphStorage.EdgeCreate {
  return {
    projectID,
    id: edge.id,
    sourceID: edge.sourceId as NodeID,
    targetID: edge.targetId as NodeID,
    relation: edge.relation,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* GraphStorage.Service

    const scanFn = Effect.fn("GraphDerivation.scan")(function* (input: { projectID: ProjectV2.ID; directory: string }) {
      const files = yield* Effect.promise(async () => {
        const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}")
        const out: string[] = []
        for await (const p of glob.scan({ cwd: input.directory, dot: false })) {
          if (!shouldSkip(p)) out.push(p)
        }
        return out
      }).pipe(Effect.orDie)
      const results = yield* Effect.forEach(
        files,
        (relPath) =>
          Effect.gen(function* () {
            const fullPath = resolve(input.directory, relPath)
            const exit = yield* Effect.exit(
              Effect.gen(function* () {
                const source = yield* Effect.promise(() => Bun.file(fullPath).text())
                const { rootNode } = yield* Effect.promise(() => parseSource(relPath, source))
                return { source, syms: extractSymbols(rootNode, source) }
              }),
            )
            if (Exit.isFailure(exit)) return null
            const { source, syms } = exit.value
            return buildFileGraph({ projectID: input.projectID, relPath, source, fileSymbols: syms })
          }),
        { concurrency: 8 },
      )
      const valid = results.filter((r): r is ReturnType<typeof buildFileGraph> => r !== null)
      const expected = buildExpectedGraph(valid)
      return { expected, filesScanned: valid.length }
    })

    const checkFn = Effect.fn("GraphDerivation.checkConsistency")(function* (input: { projectID: ProjectV2.ID; directory: string }) {
      const { expected } = yield* scanFn(input)
      const stored = yield* storage.main({ projectID: input.projectID })
      return checkConsistency(expected, stored as GraphView)
    })

    const reconcileFn = Effect.fn("GraphDerivation.reconcile")(function* (input: { projectID: ProjectV2.ID; directory: string }) {
      const { expected } = yield* scanFn(input)
      const stored = yield* storage.main({ projectID: input.projectID })
      const issues = checkConsistency(expected, stored as GraphView)
      const plan = buildReconciliationPlan(issues, expected)

      for (const node of plan.nodesToAdd) {
        yield* storage.node.create(expectedToNodeCreate(input.projectID, node))
      }
      for (const node of plan.nodesToUpdate) {
        yield* storage.node.update(node.id as NodeID, { codeHash: node.codeHash, content: node.content }).pipe(Effect.orDie)
      }
      for (const id of plan.nodesToRemove) {
        yield* storage.node.delete(id as NodeID)
      }
      for (const edge of plan.edgesToAdd) {
        yield* storage.edge.create(expectedToEdgeCreate(input.projectID, edge)).pipe(Effect.orDie)
      }
      for (const id of plan.edgesToRemove) {
        yield* storage.edge.delete(id as EdgeID)
      }
      for (const id of plan.intentStaleMarkings) {
        const exit = yield* Effect.exit(storage.node.get(id as NodeID))
        if (Exit.isFailure(exit)) continue
        yield* storage.node.update(id as NodeID, { content: { ...exit.value.content, stale: true } as any }).pipe(Effect.orDie)
      }

      return {
        nodesAdded: plan.nodesToAdd.length,
        nodesUpdated: plan.nodesToUpdate.length,
        nodesRemoved: plan.nodesToRemove.length,
        edgesAdded: plan.edgesToAdd.length,
        edgesRemoved: plan.edgesToRemove.length,
        intentStaleMarked: plan.intentStaleMarkings.length,
        issues,
      }
    })

    const syncFn = reconcileFn

    return Service.of({ scan: scanFn, checkConsistency: checkFn, reconcile: reconcileFn, sync: syncFn } as unknown as Interface)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(GraphStorage.defaultLayer))
