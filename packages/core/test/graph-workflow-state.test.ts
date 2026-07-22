import { describe, expect, test } from "bun:test"
import { Graph } from "@opencode-ai/schema"
import { Effect, Exit, Layer, Ref, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import type { EdgeID, EdgeRow, GraphView, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import { GraphEdgeTable, GraphNodeTable } from "@opencode-ai/core/graph/sql"
import { GraphWorkflowState } from "@opencode-ai/core/graph/workflow/state"
import { GraphWorkflowStateTable } from "@opencode-ai/core/graph/workflow/state.sql"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

describe("Graph collaboration schemas", () => {
  test("accepts execution modes and checkpoint values", () => {
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("atomic")).toBe("atomic")
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("module")).toBe("module")
    expect(Schema.decodeUnknownSync(Graph.ExecutionMode)("autopilot")).toBe("autopilot")
    expect(Schema.decodeUnknownSync(Graph.CheckpointKind)("decision")).toBe("decision")
    expect(Schema.decodeUnknownSync(Graph.CheckpointStatus)("approved")).toBe("approved")
  })

  test("requires non-empty verification criteria and diagnostics", () => {
    expect(() =>
      Schema.decodeUnknownSync(Graph.VerificationSpec)({
        criteria: [],
        diagnostics: [{ name: "test" }],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Graph.VerificationSpec)({
        criteria: ["observable result"],
        diagnostics: [],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Graph.VerificationSpec)({
        criteria: ["observable result"],
        diagnostics: [{ name: "build" }],
      }),
    ).toThrow()
  })

  test("accepts only safe relative diagnostic paths", () => {
    expect(
      Schema.decodeUnknownSync(Graph.VerificationSpec)({
        criteria: ["theme can be changed"],
        diagnostics: [{ name: "test", paths: ["src/theme.test.ts"] }],
      }),
    ).toEqual({
      criteria: ["theme can be changed"],
      diagnostics: [{ name: "test", paths: ["src/theme.test.ts"] }],
    })
    for (const invalid of ["", "/tmp/outside.test.ts", "C:\\outside.test.ts", "../outside.test.ts", "src//test.ts", "--watch"]) {
      expect(() =>
        Schema.decodeUnknownSync(Graph.VerificationSpec)({
          criteria: ["theme can be changed"],
          diagnostics: [{ name: "test", paths: [invalid] }],
        }),
      ).toThrow()
    }
  })

  test("bounds diagnostics evidence", () => {
    const evidence = {
      kind: "diagnostics" as const,
      nodeID: "node",
      criteria: ["works"],
      artifactPaths: ["src/a.ts"],
      projectChecksOnly: false,
      complete: true,
      passed: true,
      commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true, excerpt: "ok" }],
    }
    expect(Schema.decodeUnknownSync(Graph.VerificationEvidence)(evidence)).toEqual(evidence)
    expect(() =>
      Schema.decodeUnknownSync(Graph.VerificationEvidence)({
        ...evidence,
        commands: [{ ...evidence.commands[0], excerpt: "x".repeat(8_193) }],
      }),
    ).toThrow()
  })
})

const PID = ProjectV2.ID.make("proj_workflow")
const SID = "ses_workflow"

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:")))
const workflowLayer = GraphWorkflowState.layer.pipe(
  Layer.provideMerge(GraphAudit.layer.pipe(Layer.provideMerge(storageLayer))),
)

const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: PID, worktree: AbsolutePath.make("/tmp/workflow"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({ id: SID, project_id: PID, slug: "workflow", directory: "/tmp/workflow", title: "workflow", version: "test" } as typeof SessionTable.$inferInsert)
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(GraphNodeTable)
    .values([
      { id: "atomic-a" as NodeID, project_id: PID, session_id: SID, type: "atomic", name: "atomic-a", level: "L2" },
      { id: "atomic-b" as NodeID, project_id: PID, session_id: SID, type: "atomic", name: "atomic-b", level: "L2" },
      { id: "module-a" as NodeID, project_id: PID, session_id: SID, type: "composite", name: "module-a", level: "L1" },
      { id: "module-b" as NodeID, project_id: PID, session_id: SID, type: "composite", name: "module-b", level: "L1" },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(GraphEdgeTable)
    .values([
      { id: "edge-blocks" as EdgeID, project_id: PID, session_id: SID, source_id: "atomic-a" as NodeID, target_id: "atomic-b" as NodeID, relation: "blocks" },
      { id: "edge-module-a" as EdgeID, project_id: PID, session_id: SID, source_id: "module-a" as NodeID, target_id: "atomic-a" as NodeID, relation: "contains" },
      { id: "edge-module-b" as EdgeID, project_id: PID, session_id: SID, source_id: "module-b" as NodeID, target_id: "atomic-b" as NodeID, relation: "contains" },
    ])
    .run()
    .pipe(Effect.orDie)
})

const run = <A, E>(effect: Effect.Effect<
  A,
  E,
  Database.Service | GraphStorage.Service | GraphAudit.Service | GraphWorkflowState.Service
>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      return yield* effect
    }).pipe(Effect.provide(workflowLayer), Effect.scoped),
  )

function node(id: string, patch: Partial<NodeRow> = {}): NodeRow {
  return {
    id: id as NodeID,
    projectID: PID,
    sessionID: SID,
    type: "atomic",
    name: id,
    level: "L2",
    priority: null,
    category: null,
    status: "pending",
    desc: null,
    content: null,
    verification: null,
    codeHash: null,
    testStatus: "none",
    confidence: 1,
    timeCreated: 0,
    timeUpdated: 0,
    ...patch,
  }
}

function edge(sourceID: NodeID, targetID: NodeID, relation: EdgeRow["relation"]): EdgeRow {
  return {
    id: `edge:${sourceID}:${targetID}:${relation}` as EdgeID,
    projectID: PID,
    sessionID: SID,
    sourceID,
    targetID,
    relation,
    confidence: 1,
    timeCreated: 0,
  }
}

const atomicA = node("atomic-a")
const atomicB = node("atomic-b")
const moduleA = node("module-a", { type: "composite", level: "L1" })
const moduleB = node("module-b", { type: "composite", level: "L1" })
const workflowGraph: GraphView = {
  nodes: [atomicB, moduleB, atomicA, moduleA],
  edges: [
    edge(atomicA.id, atomicB.id, "blocks"),
    edge(moduleA.id, atomicA.id, "contains"),
    edge(moduleB.id, atomicB.id, "contains"),
  ],
}

describe("GraphWorkflowState", () => {
  test("persists mode, enforces exact revisions, and reconstructs state", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const selected = yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        expect(selected.mode).toBe("module")
        expect(selected.revision).toBe(1)

        const conflict = yield* workflow
          .setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("GraphWorkflowState.RevisionConflict")
        expect((yield* workflow.get(SID))?.mode).toBe("module")
      }),
    )
  })

  test("rejects module mode for a completed promoted graph with ambiguous membership without writing state", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* GraphStorage.Service
        const workflow = yield* GraphWorkflowState.Service
        yield* storage.node.update(atomicA.id, { status: "verified", testStatus: "passed" })
        yield* storage.node.update(atomicB.id, { status: "verified", testStatus: "passed" })
        yield* storage.edge.create({
          projectID: PID,
          sessionID: SID,
          sourceID: moduleB.id,
          targetID: atomicA.id,
          relation: "contains",
        })
        yield* storage.promote({ projectID: PID, sessionID: SID })
        const selected = yield* workflow.setMode({
          sessionID: SID,
          projectID: PID,
          mode: "atomic",
          expectedRevision: 0,
        })

        const outcome = yield* workflow
          .setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: selected.revision })
          .pipe(
            Effect.as("committed" as const),
            Effect.catchTag("GraphWorkflowState.ModuleScopeError", () => Effect.succeed("module-error" as const)),
          )
        const persisted = yield* workflow.get(SID)

        expect(outcome).toBe("module-error")
        expect(persisted).toMatchObject({ mode: "atomic", revision: selected.revision })
      }),
    )
  })

  test("resets a plan while preserving the selected mode", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })

        expect(planned.mode).toBe("module")
        expect(planned.currentNodeID).toBe(atomicA.id)
        expect(planned.checkpointKind).toBe("module")
        expect(planned.checkpointScopeNodeID).toBe(moduleA.id)
        expect(planned.checkpointStatus).toBe("approved")
        expect(planned.revision).toBe(2)
      }),
    )
  })

  test("authorizes the current scope when mode is selected after plan admission", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        expect(planned.mode).toBeNull()

        const selected = yield* workflow.setMode({
          sessionID: SID,
          projectID: PID,
          mode: "module",
          expectedRevision: planned.revision,
        })
        expect(selected.checkpointKind).toBe("module")
        expect(selected.checkpointScopeNodeID).toBe(moduleA.id)
        expect(selected.checkpointStatus).toBe("approved")
      }),
    )
  })

  test("changes mode with an idle current task and rejects an active artifact owner", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const idle = yield* workflow.setMode({
          sessionID: SID,
          projectID: PID,
          mode: "autopilot",
          expectedRevision: planned.revision,
        })
        expect(idle).toMatchObject({ mode: "autopilot", currentNodeID: atomicA.id, activeOperationID: null })

        const active = yield* workflow.beginArtifactApply({
          sessionID: SID,
          expectedRevision: idle.revision,
          operationID: "active-mode-change",
        })
        const error = yield* workflow
          .setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: active.revision })
          .pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "GraphWorkflowState.ActiveWorkflowError",
          sessionID: SID,
          activeOperationKind: "artifact_apply",
        })
      }),
    )
  })

  test("approves idempotently and pauses with an exact revision", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const paused = yield* workflow.pause({ sessionID: SID, expectedRevision: planned.revision, reason: "review" })
        expect(paused.checkpointKind).toBe("pause")
        expect(paused.checkpointStatus).toBe("pending")
        expect(paused.revision).toBe(planned.revision + 1)

        const approved = yield* workflow.approve({ sessionID: SID, expectedRevision: paused.revision })
        const repeated = yield* workflow.approve({ sessionID: SID, expectedRevision: paused.revision })
        expect(approved.checkpointStatus).toBe("approved")
        expect(approved.revision).toBe(paused.revision + 1)
        expect(repeated).toEqual(approved)
        const stalePause = yield* workflow.pause({
          sessionID: SID,
          expectedRevision: paused.revision,
        }).pipe(Effect.flip)
        expect(stalePause._tag).toBe("GraphWorkflowState.RevisionConflict")
        const staleMode = yield* workflow.setMode({
          sessionID: SID,
          projectID: PID,
          mode: "autopilot",
          expectedRevision: paused.revision,
        }).pipe(Effect.flip)
        expect(staleMode._tag).toBe("GraphWorkflowState.RevisionConflict")
      }),
    )
  })

  test("preserves module scope across pause and approval", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const paused = yield* workflow.pause({ sessionID: SID, expectedRevision: planned.revision })
        expect(paused.checkpointKind).toBe("pause")
        expect(paused.checkpointScopeNodeID).toBe(moduleA.id)

        const approved = yield* workflow.approve({ sessionID: SID, expectedRevision: paused.revision })
        expect(approved.checkpointScopeNodeID).toBe(moduleA.id)
        expect(approved.checkpointStatus).toBe("approved")
      }),
    )
  })

  test("rejects approval when no checkpoint is pending", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        expect(planned.checkpointStatus).toBe("none")

        const error = yield* workflow.approve({ sessionID: SID, expectedRevision: planned.revision }).pipe(Effect.flip)
        expect(error._tag).toBe("GraphWorkflowState.CheckpointNotPending")
        expect((yield* workflow.get(SID))?.checkpointStatus).toBe("none")
      }),
    )
  })

  test("advances atomic mode to a pending task checkpoint", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const graph = { ...workflowGraph, nodes: workflowGraph.nodes.map((item) => item.id === atomicA.id ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item) }
        const advanced = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          graph,
          expectedRevision: planned.revision,
        })

        expect(advanced.currentNodeID).toBe(atomicB.id)
        expect(advanced.checkpointKind).toBe("atomic")
        expect(advanced.checkpointScopeNodeID).toBe(atomicB.id)
        expect(advanced.checkpointStatus).toBe("pending")
      }),
    )
  })

  test("advances module mode within a module and checkpoints at its boundary", async () => {
    const atomicA2 = node("atomic-a2")
    const graph: GraphView = {
      nodes: [atomicB, atomicA2, moduleB, atomicA, moduleA],
      edges: [
        edge(atomicA.id, atomicA2.id, "blocks"),
        edge(atomicA2.id, atomicB.id, "blocks"),
        edge(moduleA.id, atomicA.id, "contains"),
        edge(moduleA.id, atomicA2.id, "contains"),
        edge(moduleB.id, atomicB.id, "contains"),
      ],
    }
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(GraphNodeTable).values({
          id: atomicA2.id,
          project_id: PID,
          session_id: SID,
          type: "atomic",
          name: atomicA2.name,
          level: "L2",
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(GraphEdgeTable).values({
          id: "edge-module-a2" as EdgeID,
          project_id: PID,
          session_id: SID,
          source_id: moduleA.id,
          target_id: atomicA2.id,
          relation: "contains",
        }).run().pipe(Effect.orDie)
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph })
        const afterA = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          graph: { ...graph, nodes: graph.nodes.map((item) => item.id === atomicA.id ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item) },
        })
        expect(afterA.currentNodeID).toBe(atomicA2.id)
        expect(afterA.checkpointStatus).toBe("approved")
        expect(afterA.checkpointScopeNodeID).toBe(moduleA.id)

        const afterModule = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA2.id,
          expectedRevision: afterA.revision,
          graph: { ...graph, nodes: graph.nodes.map((item) => [atomicA.id, atomicA2.id].includes(item.id) ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item) },
        })
        expect(afterModule.currentNodeID).toBe(atomicB.id)
        expect(afterModule.checkpointStatus).toBe("pending")
        expect(afterModule.checkpointScopeNodeID).toBe(moduleB.id)
      }),
    )
  })

  test("finishes an authorized module before an interleaved independent module", async () => {
    const taskZ = node("task-z")
    const taskB = node("task-b")
    const graph: GraphView = {
      nodes: [taskZ, taskB, atomicA, moduleA, moduleB],
      edges: [
        edge(moduleA.id, atomicA.id, "contains"),
        edge(moduleA.id, taskZ.id, "contains"),
        edge(moduleB.id, taskB.id, "contains"),
      ],
    }
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(GraphNodeTable).values([
          { id: taskZ.id, project_id: PID, session_id: SID, type: "atomic", name: taskZ.name, level: "L2" },
          { id: taskB.id, project_id: PID, session_id: SID, type: "atomic", name: taskB.name, level: "L2" },
        ]).run().pipe(Effect.orDie)
        yield* database.db.insert(GraphEdgeTable).values([
          { id: "edge-module-task-z" as EdgeID, project_id: PID, session_id: SID, source_id: moduleA.id, target_id: taskZ.id, relation: "contains" },
          { id: "edge-module-task-b" as EdgeID, project_id: PID, session_id: SID, source_id: moduleB.id, target_id: taskB.id, relation: "contains" },
        ]).run().pipe(Effect.orDie)
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph })

        const advanced = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          graph: {
            ...graph,
            nodes: graph.nodes.map((item) => item.id === atomicA.id
              ? { ...item, status: "verified" as const, testStatus: "passed" as const }
              : item),
          },
        })
        expect(advanced.currentNodeID).toBe(taskZ.id)
        expect(advanced.checkpointScopeNodeID).toBe(moduleA.id)
        expect(advanced.checkpointStatus).toBe("approved")
      }),
    )
  })

  test("selects a ready prerequisite before a blocked task in the current module", async () => {
    const prerequisite = node("task-b")
    const blocked = node("task-c")
    const graph: GraphView = {
      nodes: [blocked, prerequisite, atomicA, moduleA, moduleB],
      edges: [
        edge(moduleA.id, atomicA.id, "contains"),
        edge(moduleA.id, blocked.id, "contains"),
        edge(moduleB.id, prerequisite.id, "contains"),
        edge(prerequisite.id, blocked.id, "blocks"),
      ],
    }
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(GraphNodeTable).values([
          { id: prerequisite.id, project_id: PID, session_id: SID, type: "atomic", name: prerequisite.name, level: "L2" },
          { id: blocked.id, project_id: PID, session_id: SID, type: "atomic", name: blocked.name, level: "L2" },
        ]).run().pipe(Effect.orDie)
        yield* database.db.insert(GraphEdgeTable).values([
          { id: "edge-module-prerequisite" as EdgeID, project_id: PID, session_id: SID, source_id: moduleB.id, target_id: prerequisite.id, relation: "contains" },
          { id: "edge-module-blocked" as EdgeID, project_id: PID, session_id: SID, source_id: moduleA.id, target_id: blocked.id, relation: "contains" },
        ]).run().pipe(Effect.orDie)
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph })

        const advanced = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          graph: {
            ...graph,
            nodes: graph.nodes.map((item) => item.id === atomicA.id
              ? { ...item, status: "verified" as const, testStatus: "passed" as const }
              : item),
          },
        })
        expect(advanced.currentNodeID).toBe(prerequisite.id)
        expect(advanced.checkpointScopeNodeID).toBe(moduleB.id)
        expect(advanced.checkpointStatus).toBe("pending")
        const audit = yield* GraphAudit.Service
        expect((yield* audit.tool.list({ projectID: PID, sessionID: SID })).map((record) => record.toolName)).not.toContain(
          "graph.workflow.module.completed",
        )
      }),
    )
  })

  test("advances autopilot without routine checkpoints and clears completion", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const afterA = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          graph: { ...workflowGraph, nodes: workflowGraph.nodes.map((item) => item.id === atomicA.id ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item) },
        })
        expect(afterA.currentNodeID).toBe(atomicB.id)
        expect(afterA.checkpointStatus).toBe("none")

        const complete = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicB.id,
          expectedRevision: afterA.revision,
          graph: { ...workflowGraph, nodes: workflowGraph.nodes.map((item) => item.type === "atomic" ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item) },
        })
        expect(complete.currentNodeID).toBeNull()
        expect(complete.checkpointStatus).toBe("none")
      }),
    )
  })

  test("rejects ambiguous module membership with a typed error", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const moduleC = node("module-c", { type: "composite", level: "L1" })
        yield* database.db.insert(GraphNodeTable).values({
          id: moduleC.id,
          project_id: PID,
          session_id: SID,
          type: "composite",
          name: moduleC.name,
          level: "L1",
        }).run().pipe(Effect.orDie)
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const error = yield* workflow.resetPlan({
          sessionID: SID,
          projectID: PID,
          graph: {
            ...workflowGraph,
            nodes: [...workflowGraph.nodes, moduleC],
            edges: [...workflowGraph.edges, edge(moduleC.id, atomicA.id, "contains")],
          },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("GraphWorkflowState.ModuleScopeError")
        expect(error.nodeID).toBe(atomicA.id)
      }),
    )
  })

  test("rejects module ambiguity on a task after the first task", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const moduleC = node("module-c", { type: "composite", level: "L1" })
        yield* database.db.insert(GraphNodeTable).values({
          id: moduleC.id,
          project_id: PID,
          session_id: SID,
          type: "composite",
          name: moduleC.name,
          level: "L1",
        }).run().pipe(Effect.orDie)
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const error = yield* workflow.resetPlan({
          sessionID: SID,
          projectID: PID,
          graph: {
            ...workflowGraph,
            nodes: [...workflowGraph.nodes, moduleC],
            edges: [...workflowGraph.edges, edge(moduleC.id, atomicB.id, "contains")],
          },
        }).pipe(Effect.flip)

        expect(error._tag).toBe("GraphWorkflowState.ModuleScopeError")
        if (error._tag !== "GraphWorkflowState.ModuleScopeError") return
        expect(error.nodeID).toBe(atomicB.id)
      }),
    )
  })

  test("rejects selecting module mode for a mode-less ambiguous plan", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const moduleC = node("module-c", { type: "composite", level: "L1" })
        yield* database.db.insert(GraphNodeTable).values({
          id: moduleC.id,
          project_id: PID,
          session_id: SID,
          type: "composite",
          name: moduleC.name,
          level: "L1",
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(GraphEdgeTable).values({
          id: "edge-module-c" as EdgeID,
          project_id: PID,
          session_id: SID,
          source_id: moduleC.id,
          target_id: atomicB.id,
          relation: "contains",
        }).run().pipe(Effect.orDie)
        const storage = yield* GraphStorage.Service
        const workflow = yield* GraphWorkflowState.Service
        const planned = yield* workflow.resetPlan({
          sessionID: SID,
          projectID: PID,
          graph: yield* storage.currentPlan({ sessionID: SID }),
        })
        const error = yield* workflow.setMode({
          sessionID: SID,
          projectID: PID,
          mode: "module",
          expectedRevision: planned.revision,
        }).pipe(Effect.flip)

        expect(error._tag).toBe("GraphWorkflowState.ModuleScopeError")
        if (error._tag !== "GraphWorkflowState.ModuleScopeError") return
        expect(error.nodeID).toBe(atomicB.id)
      }),
    )
  })

  test("records bounded workflow transition history", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "module", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const advanced = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          graph: {
            ...workflowGraph,
            nodes: workflowGraph.nodes.map((item) => item.id === atomicA.id
              ? { ...item, status: "verified" as const, testStatus: "passed" as const }
              : item),
          },
        })
        const paused = yield* workflow.pause({ sessionID: SID, expectedRevision: advanced.revision, reason: "review" })
        yield* workflow.approve({ sessionID: SID, expectedRevision: paused.revision })

        const audit = yield* GraphAudit.Service
        const records = yield* audit.tool.list({ projectID: PID, sessionID: SID })
        expect(records.map((record) => record.toolName)).toEqual(expect.arrayContaining([
          "graph.workflow.mode.changed",
          "graph.workflow.current_task.changed",
          "graph.workflow.task.verified",
          "graph.workflow.module.completed",
          "graph.workflow.checkpoint.requested",
          "graph.workflow.paused",
          "graph.workflow.checkpoint.approved",
        ]))
        expect(records.every((record) => (record.inputSummary?.length ?? 0) <= 1_024)).toBe(true)
        expect(records.every((record) => (record.outputSummary?.length ?? 0) <= 1_024)).toBe(true)
        expect(planned.currentNodeID).toBe(atomicA.id)
      }),
    )
  })

  test("creates a durable failure checkpoint and audit transition", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        expect(workflow).toHaveProperty("fail")
        if (!("fail" in workflow)) return
        const fail = workflow.fail as (input: {
          readonly sessionID: string
          readonly nodeID: NodeID
          readonly reason: string
        }) => Effect.Effect<GraphWorkflowState.State>
        const failed = yield* fail({ sessionID: SID, nodeID: atomicA.id, reason: "repair budget exhausted" })

        expect(failed.checkpointKind).toBe("failure")
        expect(failed.checkpointStatus).toBe("pending")
        expect(failed.checkpointScopeNodeID).toBe(atomicA.id)
        expect(failed.checkpointReason).toBe("repair budget exhausted")
        const audit = yield* GraphAudit.Service
        const records = yield* audit.tool.list({ projectID: PID, sessionID: SID })
        expect(records.map((record) => record.toolName)).toContain("graph.workflow.failed")
        expect(records.find((record) => record.toolName === "graph.workflow.failed")?.status).toBe("failed")
      }),
    )
  })

  test("re-admission resumes the first unfinished buildable task", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const graph: GraphView = {
          ...workflowGraph,
          nodes: workflowGraph.nodes.map((item) => item.id === atomicA.id
            ? { ...item, status: "verified" as const, testStatus: "passed" as const }
            : item),
        }
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph })
        expect(planned.currentNodeID).toBe(atomicB.id)
      }),
    )
  })

  test("a concurrent pause wins over stale diagnostics advancement", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const paused = yield* workflow.pause({ sessionID: SID, expectedRevision: planned.revision, reason: "user review" })
        const graph = {
          ...workflowGraph,
          nodes: workflowGraph.nodes.map((item) => item.id === atomicA.id
            ? { ...item, status: "verified" as const, testStatus: "passed" as const }
            : item),
        }

        const conflict = yield* workflow.advanceVerified({
          sessionID: SID,
          nodeID: atomicA.id,
          graph,
          expectedRevision: planned.revision,
        }).pipe(Effect.flip)
        expect(conflict._tag).toBe("GraphWorkflowState.RevisionConflict")
        expect(yield* workflow.get(SID)).toEqual(paused)
      }),
    )
  })

  test("atomically verifies, records evidence, advances, and reconciles an exact retry", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        expect(workflow).toHaveProperty("completeVerification")
        if (!("completeVerification" in workflow)) return
        const completeVerification = workflow.completeVerification as (input: {
          readonly projectID: ProjectV2.ID
          readonly sessionID: string
          readonly nodeID: NodeID
          readonly expectedRevision: number
          readonly evidence: typeof Graph.VerificationEvidence.Type
          readonly inputSummary: string
          readonly outputSummary: string
        }) => Effect.Effect<GraphWorkflowState.State, GraphWorkflowState.RevisionConflict>
        const input = {
          projectID: PID,
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          evidence: {
            kind: "diagnostics" as const,
            nodeID: atomicA.id,
            criteria: ["works"],
            artifactPaths: ["src/a.ts"],
            projectChecksOnly: false,
            complete: true,
            passed: true,
            commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true, excerpt: "ok" }],
          },
          inputSummary: "test",
          outputSummary: "test:0",
        }
        const completed = yield* completeVerification(input)
        const retried = yield* completeVerification(input)

        expect(completed.currentNodeID).toBe(atomicB.id)
        expect(retried).toEqual(completed)
        const storage = yield* GraphStorage.Service
        expect(yield* storage.node.get(atomicA.id)).toMatchObject({ status: "verified", testStatus: "passed" })
        const audit = yield* GraphAudit.Service
        const diagnostics = (yield* audit.tool.list({ projectID: PID, sessionID: SID, nodeID: atomicA.id }))
          .filter((record) => record.toolName === "graph.diagnostics.run")
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.evidence).toEqual(input.evidence)
      }),
    )
  })

  test("reconciles an exact verification retry after service restart", async () => {
    await using dir = await tmpdir()
    const databasePath = path.join(dir.path, "workflow.db")
    const input = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const input = {
          projectID: PID,
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          evidence: {
            kind: "diagnostics" as const,
            nodeID: atomicA.id,
            criteria: ["works"],
            artifactPaths: [],
            projectChecksOnly: false,
            complete: true,
            passed: true,
            commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true, excerpt: "ok" }],
          },
        }
        yield* workflow.completeVerification(input)
        return input
      }).pipe(
        Effect.provide(GraphWorkflowState.layerFromDatabase(Database.layerFromPath(databasePath))),
        Effect.scoped,
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const retried = yield* workflow.completeVerification(input)
        expect(retried.currentNodeID).toBe(atomicB.id)
        const audit = yield* GraphAudit.Service
        expect((yield* audit.tool.list({ projectID: PID, sessionID: SID, nodeID: atomicA.id }))
          .filter((record) => record.toolName === "graph.diagnostics.run")).toHaveLength(1)
      }).pipe(
        Effect.provide(GraphWorkflowState.layerFromDatabase(Database.layerFromPath(databasePath))),
        Effect.scoped,
      ),
    )
  })

  test("does not verify when a pause changes the expected diagnostics revision", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        const paused = yield* workflow.pause({ sessionID: SID, expectedRevision: planned.revision })
        expect(workflow).toHaveProperty("completeVerification")
        if (!("completeVerification" in workflow)) return
        const completeVerification = workflow.completeVerification as (input: {
          readonly projectID: ProjectV2.ID
          readonly sessionID: string
          readonly nodeID: NodeID
          readonly expectedRevision: number
          readonly evidence: typeof Graph.VerificationEvidence.Type
        }) => Effect.Effect<GraphWorkflowState.State, GraphWorkflowState.RevisionConflict>
        const conflict = yield* completeVerification({
          projectID: PID,
          sessionID: SID,
          nodeID: atomicA.id,
          expectedRevision: planned.revision,
          evidence: {
            kind: "diagnostics",
            nodeID: atomicA.id,
            criteria: [],
            artifactPaths: [],
            projectChecksOnly: false,
            complete: true,
            passed: true,
            commands: [],
          },
        }).pipe(Effect.flip)

        expect(conflict._tag).toBe("GraphWorkflowState.RevisionConflict")
        expect(yield* workflow.get(SID)).toEqual(paused)
        const storage = yield* GraphStorage.Service
        expect(yield* storage.node.get(atomicA.id)).toMatchObject({ status: "pending", testStatus: "none" })
      }),
    )
  })

  test("an artifact reservation invalidates in-flight verification before writes complete", async () => {
    await run(Effect.gen(function* () {
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const first = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "apply-first" })
      const applied = yield* workflow.completeArtifactApply({
        projectID: PID, sessionID: SID, nodeID: atomicA.id,
        reservedRevision: first.revision,
        operationID: "apply-first",
        evidence: { kind: "artifact", nodeID: atomicA.id, artifactPaths: ["src/a.ts"] },
      })
      expect(applied.revision).toBe(planned.revision + 2)
      expect(applied.activeOperationID).toBeNull()
      const staleRevision = applied.revision
      yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: staleRevision, operationID: "apply-second" })
      const exit = yield* workflow.completeVerification({
        projectID: PID, sessionID: SID, nodeID: atomicA.id, expectedRevision: staleRevision,
        evidence: { kind: "diagnostics", nodeID: atomicA.id, criteria: [], artifactPaths: ["src/a.ts"], projectChecksOnly: true, complete: true, passed: true, commands: [] },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const storage = yield* GraphStorage.Service
      expect(yield* storage.node.get(atomicA.id)).toMatchObject({ status: "implemented", testStatus: "pending" })
    }))
  })

  test("artifact reservations reject concurrent old revisions before completion", async () => {
    await run(Effect.gen(function* () {
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const reserved = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "apply-1" })
      expect((yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "apply-1" })).revision).toBe(reserved.revision)
      const conflict = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: reserved.revision, operationID: "apply-2" }).pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      const wrongOwner = yield* workflow.completeArtifactApply({ projectID: PID, sessionID: SID, nodeID: atomicA.id,
        reservedRevision: reserved.revision, operationID: "apply-2",
        evidence: { kind: "artifact", nodeID: atomicA.id, artifactPaths: ["src/a.ts"] } }).pipe(Effect.exit)
      expect(Exit.isFailure(wrongOwner)).toBe(true)
      expect(yield* workflow.get(SID)).toMatchObject({ activeOperationID: "apply-1", revision: reserved.revision })
      yield* workflow.failArtifactApply({ projectID: PID, sessionID: SID, nodeID: atomicA.id, reservedRevision: reserved.revision,
        operationID: "apply-1", evidence: { kind: "artifact", nodeID: atomicA.id, artifactPaths: ["src/a.ts"] }, error: "interrupted before write" })
      const storage = yield* GraphStorage.Service
      expect(yield* storage.node.get(atomicA.id)).toMatchObject({ status: "pending", testStatus: "none" })
      expect(yield* workflow.get(SID)).toMatchObject({ activeOperationID: null, checkpointStatus: "pending", checkpointKind: "failure" })
      const audit = yield* GraphAudit.Service
      expect((yield* audit.tool.list({ projectID: PID, nodeID: atomicA.id })).find((item) => item.toolName === "graph.artifact.apply")).toMatchObject({ status: "failed", error: "interrupted before write" })
    }))
  })

  test("does not recover a live artifact owner after the reporting threshold", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const reserved = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "stale-apply" })
      expect(reserved).toMatchObject({ activeOperationProcessID: process.pid, activeOperationRuntimeID: GraphWorkflowState.ARTIFACT_APPLY_RUNTIME_ID })
      yield* TestClock.adjust(GraphWorkflowState.ARTIFACT_APPLY_STALE_AFTER_MS - 1)
      expect(yield* workflow.recoverAbandonedArtifactApply(SID)).toMatchObject({ activeOperationID: "stale-apply", revision: reserved.revision })
      yield* TestClock.adjust(1)
      expect(yield* workflow.recoverAbandonedArtifactApply(SID)).toMatchObject({ activeOperationID: "stale-apply", revision: reserved.revision })
    }).pipe(Effect.provide(TestClock.layer())))
  })

  test("conservatively retains an owner when a live PID has an ambiguous runtime", async () => {
    await run(Effect.gen(function* () {
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const reserved = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "ambiguous-apply" })
      const database = yield* Database.Service
      yield* database.db.update(GraphWorkflowStateTable).set({ active_operation_runtime_id: "other-runtime" })
        .where(eq(GraphWorkflowStateTable.session_id, SID)).run().pipe(Effect.orDie)
      expect(yield* workflow.recoverAbandonedArtifactApply(SID)).toMatchObject({ activeOperationID: "ambiguous-apply", revision: reserved.revision })
    }))
  })

  test("recovers a dead-process owner and fences its old writer", async () => {
    await run(Effect.gen(function* () {
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const reserved = yield* workflow.beginArtifactApply({ sessionID: SID, expectedRevision: planned.revision, operationID: "dead-apply" })
      const database = yield* Database.Service
      yield* database.db.update(GraphWorkflowStateTable).set({ active_operation_process_id: 2_147_483_647, active_operation_runtime_id: "dead-runtime" })
        .where(eq(GraphWorkflowStateTable.session_id, SID)).run().pipe(Effect.orDie)
      expect(yield* workflow.recoverAbandonedArtifactApply(SID)).toMatchObject({ activeOperationID: null, checkpointKind: "failure", checkpointStatus: "pending" })
      const writes = yield* Ref.make(0)
      const fenced = yield* workflow.assertArtifactApplyOwner({ sessionID: SID, reservedRevision: reserved.revision, operationID: "dead-apply" })
        .pipe(Effect.andThen(Ref.update(writes, (value) => value + 1)), Effect.exit)
      expect(Exit.isFailure(fenced)).toBe(true)
      expect(yield* Ref.get(writes)).toBe(0)
    }))
  })

  test("failed diagnostics persist status and matching evidence atomically", async () => {
    await run(Effect.gen(function* () {
      const workflow = yield* GraphWorkflowState.Service
      yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
      const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
      const evidence = { kind: "diagnostics" as const, nodeID: atomicA.id, criteria: [], artifactPaths: [], projectChecksOnly: true, complete: true, passed: false, commands: [] }
      yield* workflow.failVerification({ projectID: PID, sessionID: SID, nodeID: atomicA.id, expectedRevision: planned.revision, evidence })
      const storage = yield* GraphStorage.Service
      const audit = yield* GraphAudit.Service
      expect((yield* storage.node.get(atomicA.id)).testStatus).toBe("failed")
      expect((yield* audit.tool.list({ projectID: PID, nodeID: atomicA.id })).at(-1)?.evidence).toEqual(evidence)
    }))
  })

  test("rejects promotion while workflow work or checkpoints remain", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "atomic", expectedRevision: 0 })
        const planned = yield* workflow.resetPlan({ sessionID: SID, projectID: PID, graph: workflowGraph })
        yield* workflow.pause({ sessionID: SID, expectedRevision: planned.revision, reason: "review" })
        expect(workflow).toHaveProperty("promote")
        if (!("promote" in workflow)) return
        const promote = workflow.promote as (input: {
          readonly projectID: ProjectV2.ID
          readonly sessionID: string
        }) => Effect.Effect<GraphStorage.PromoteResult, GraphWorkflowState.PromotionBlocked>
        const error = yield* promote({ projectID: PID, sessionID: SID }).pipe(Effect.flip)

        expect(error._tag).toBe("GraphWorkflowState.PromotionBlocked")
        expect(error.reason).toBe("checkpoint_pending")
        const storage = yield* GraphStorage.Service
        expect((yield* storage.main({ projectID: PID })).nodes).toHaveLength(0)
      }),
    )
  })

  test("rejects stale promotion revisions without creating a version or moving the Current Plan", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const storage = yield* GraphStorage.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        yield* storage.node.update(atomicA.id, { status: "verified", testStatus: "passed" })
        yield* storage.node.update(atomicB.id, { status: "verified", testStatus: "passed" })
        const completed = yield* workflow.resetPlan({
          sessionID: SID,
          projectID: PID,
          graph: {
            ...workflowGraph,
            nodes: workflowGraph.nodes.map((item) =>
              item.type === "atomic" ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item,
            ),
          },
        })
        const conflict = yield* workflow
          .promote({
            projectID: PID,
            sessionID: SID,
            expectedRevision: completed.revision - 1,
          })
          .pipe(Effect.flip)

        expect(conflict).toMatchObject({
          _tag: "GraphWorkflowState.RevisionConflict",
          expectedRevision: completed.revision - 1,
          actualRevision: completed.revision,
        })
        expect((yield* storage.currentPlan({ sessionID: SID })).nodes).toHaveLength(4)
        expect(yield* storage.version.list({ projectID: PID })).toHaveLength(0)
        expect((yield* storage.main({ projectID: PID })).nodes).toHaveLength(0)
      }),
    )
  })

  test("rejects promotion when the Plan topology changes without a workflow revision", async () => {
    await run(
      Effect.gen(function* () {
        const workflow = yield* GraphWorkflowState.Service
        const storage = yield* GraphStorage.Service
        yield* workflow.setMode({ sessionID: SID, projectID: PID, mode: "autopilot", expectedRevision: 0 })
        yield* storage.node.update(atomicA.id, { status: "verified", testStatus: "passed" })
        yield* storage.node.update(atomicB.id, { status: "verified", testStatus: "passed" })
        const completed = yield* workflow.resetPlan({
          sessionID: SID,
          projectID: PID,
          graph: {
            ...workflowGraph,
            nodes: workflowGraph.nodes.map((item) =>
              item.type === "atomic" ? { ...item, status: "verified" as const, testStatus: "passed" as const } : item,
            ),
          },
        })
        const expectedPlanHash = (yield* storage.planView({ projectID: PID, sessionID: SID })).planHash
        yield* storage.edge.delete("edge-module-a" as EdgeID)
        const actualPlanHash = (yield* storage.planView({ projectID: PID, sessionID: SID })).planHash

        const conflict = yield* workflow
          .promote({ projectID: PID, sessionID: SID, expectedRevision: completed.revision, expectedPlanHash })
          .pipe(Effect.flip)

        expect(conflict).toMatchObject({
          _tag: "GraphWorkflowState.PlanConflict",
          expectedPlanHash,
          actualPlanHash,
        })
        expect((yield* workflow.get(SID))?.revision).toBe(completed.revision)
        expect(yield* storage.version.list({ projectID: PID })).toHaveLength(0)
        expect((yield* storage.main({ projectID: PID })).nodes).toHaveLength(0)
      }),
    )
  })
})
