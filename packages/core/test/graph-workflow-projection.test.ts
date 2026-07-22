import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import type { EdgeID, EdgeRow, GraphView, NodeID, NodeRow } from "@opencode-ai/core/graph/storage"
import { GraphWorkflowProjection } from "@opencode-ai/core/graph/workflow/projection"
import { GraphWorkflowState } from "@opencode-ai/core/graph/workflow/state"
import type { VerificationEvidence } from "@opencode-ai/schema/graph"

const PID = ProjectV2.ID.make("proj_projection")
const SID = SessionSchema.ID.make("ses_projection")

const storageLayer = GraphStorage.layer.pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))) as Layer.Layer<
  Database.Service | GraphStorage.Service
>
const auditLayer = GraphAudit.layer.pipe(Layer.provideMerge(storageLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service
>
const workflowLayer = GraphWorkflowState.layer.pipe(Layer.provideMerge(auditLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service | GraphWorkflowState.Service
>
const projectionLayer = GraphWorkflowProjection.layer.pipe(Layer.provideMerge(workflowLayer)) as Layer.Layer<
  Database.Service | GraphStorage.Service | GraphAudit.Service | GraphWorkflowState.Service | GraphWorkflowProjection.Service
>

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

const taskA = node("task-a", { status: "verified", testStatus: "passed" })
const taskB = node("task-b", { status: "implemented", testStatus: "failed" })
const taskC = node("task-c")
const moduleA = node("module-a", { type: "composite", level: "L1", name: "Module A" })
const moduleB = node("module-b", { type: "composite", level: "L1", name: "Module B" })
const prd = node("prd", { type: "prd", level: "L1", name: "PRD" })

const graph: GraphView = {
  nodes: [taskC, moduleB, taskB, prd, taskA, moduleA],
  edges: [
    edge(taskA.id, taskB.id, "blocks"),
    edge(moduleA.id, taskA.id, "contains"),
    edge(moduleA.id, taskB.id, "contains"),
    edge(moduleB.id, taskC.id, "contains"),
    edge(prd.id, moduleA.id, "contains"),
    edge(prd.id, moduleB.id, "contains"),
  ],
}

const state: GraphWorkflowState.State = {
  sessionID: SID,
  projectID: PID,
  mode: "module",
  currentNodeID: taskB.id,
  checkpointKind: "module",
  checkpointScopeNodeID: moduleA.id,
  checkpointStatus: "approved",
  checkpointReason: null,
  revision: 4,
  activeOperationID: null,
  activeOperationKind: null,
  activeOperationStartedAt: null,
  activeOperationProcessID: null,
  activeOperationRuntimeID: null,
  timeCreated: 1,
  timeUpdated: 2,
}

describe("Graph workflow projection", () => {
  test("orders only atomic tasks deterministically and projects current progress", () => {
    const projection = GraphWorkflowProjection.projectWorkflow(graph, state, [])

    expect(projection.tasks.map((task) => task.id)).toEqual([taskA.id, taskB.id, taskC.id])
    expect(projection.tasks.map((task) => task.order)).toEqual([0, 1, 2])
    expect(projection.currentTask?.id).toBe(taskB.id)
    expect(projection.progress).toEqual({ total: 3, verified: 1, failed: 1, percent: 33 })
    expect(projection.phase).toBe("failed")
  })

  test("derives module and PRD rollups without mutating graph rows", () => {
    const projection = GraphWorkflowProjection.projectWorkflow(graph, state, [])

    expect(projection.modules.map((module) => [module.id, module.status])).toEqual([
      [moduleA.id, "failed"],
      [moduleB.id, "pending"],
    ])
    expect(projection.rollups.find((rollup) => rollup.id === prd.id)?.status).toBe("failed")
    expect(moduleA.status).toBe("pending")
    expect(prd.status).toBe("pending")
  })

  test("selects the latest bounded evidence for each task", () => {
    const older = evidence(taskA.id, "old")
    const latest = evidence(taskA.id, "latest")
    const projection = GraphWorkflowProjection.projectWorkflow(graph, state, [
      { nodeID: taskA.id, evidence: latest, timeCreated: 2 },
      { nodeID: taskA.id, evidence: older, timeCreated: 1 },
    ])

    expect(projection.tasks[0]?.latestEvidence?.commands[0]?.excerpt).toBe("latest")
  })

  test("labels evidence for persisted nodes without verification as project checks only", () => {
    const projection = GraphWorkflowProjection.projectWorkflow(graph, state, [
      { nodeID: taskA.id, evidence: evidence(taskA.id, "legacy"), timeCreated: 1 },
    ])

    expect(projection.tasks[0]?.latestEvidence?.projectChecksOnly).toBe(true)
  })

  test("rejects ambiguous nearest composite membership in module mode", () => {
    const ambiguous: GraphView = {
      nodes: [...graph.nodes, node("module-c", { type: "composite", level: "L1" })],
      edges: [...graph.edges, edge("module-c" as NodeID, taskA.id, "contains")],
    }

    expect(() => GraphWorkflowProjection.projectWorkflow(ambiguous, state, [])).toThrow("ambiguous")
  })

  test("service preserves published tasks, modules, progress, and session evidence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.insert(ProjectTable).values({
          id: PID,
          worktree: AbsolutePath.make("/tmp/projection"),
          vcs: "git",
          sandboxes: [],
          time_created: 0,
          time_updated: 0,
        }).run().pipe(Effect.orDie)
        yield* database.db.insert(SessionTable).values({
          id: SID,
          project_id: PID,
          slug: "projection",
          directory: "/tmp/projection",
          title: "projection",
          version: "0",
          time_created: 0,
          time_updated: 0,
        }).run().pipe(Effect.orDie)
        const storage = yield* GraphStorage.Service
        const audit = yield* GraphAudit.Service
        const workflow = yield* GraphWorkflowState.Service
        const projection = yield* GraphWorkflowProjection.Service
        const moduleID = yield* storage.node.create({
          projectID: PID,
          sessionID: SID,
          type: "composite",
          name: "Published Module",
          level: "L1",
        })
        const taskID = yield* storage.node.create({
          projectID: PID,
          sessionID: SID,
          type: "atomic",
          name: "Published Task",
          level: "L2",
          status: "verified",
          testStatus: "passed",
        })
        yield* storage.edge.create({
          projectID: PID,
          sessionID: SID,
          sourceID: moduleID,
          targetID: taskID,
          relation: "contains",
        })
        yield* workflow.resetPlan({
          projectID: PID,
          sessionID: SID,
          graph: yield* storage.currentPlan({ sessionID: SID }),
        })
        yield* audit.tool.record({
          projectID: PID,
          sessionID: SID,
          nodeID: taskID,
          toolName: "graph.diagnostics.run",
          toolType: "diagnostics",
          status: "succeeded",
          evidence: evidence(taskID, "published evidence"),
        })
        yield* storage.promote({ projectID: PID, sessionID: SID })

        expect((yield* storage.currentPlan({ sessionID: SID })).nodes).toEqual([])
        const result = yield* projection.get({ projectID: PID, sessionID: SID })
        expect(result.tasks.map((task) => task.name)).toEqual(["Published Task"])
        expect(result.modules.map((module) => module.name)).toEqual(["Published Module"])
        expect(result.progress).toEqual({ total: 1, verified: 1, failed: 0, percent: 100 })
        expect(result.tasks[0]?.latestEvidence?.commands[0]?.excerpt).toBe("published evidence")
      }).pipe(Effect.provide(projectionLayer), Effect.scoped),
    )
  })
})

function evidence(nodeID: NodeID, excerpt: string): VerificationEvidence {
  return {
    kind: "diagnostics",
    nodeID,
    criteria: ["works"],
    artifactPaths: ["src/a.ts"],
    complete: true,
    passed: true,
    projectChecksOnly: false,
    commands: [{ name: "test", command: "bun test", exitCode: 0, timedOut: false, passed: true, excerpt }],
  }
}
