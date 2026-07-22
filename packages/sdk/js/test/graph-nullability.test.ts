import { expect, test } from "bun:test"
import { Graph } from "../src/v2/gen/sdk.gen"
import type {
  GraphNode,
  GraphPlanViewErrors,
  GraphToolRun,
  GraphVersion,
  GraphWorkflow,
  GraphWorkflowActiveOperation,
  GraphWorkflowModeError,
  GraphWorkflowTask,
  SessionPlanView,
} from "../src/v2/gen/types.gen"

test("preserves nullable Graph response fields", () => {
  const node = {
    sessionID: null,
    priority: null,
    category: null,
    desc: null,
    content: null,
    codeHash: null,
  } satisfies Pick<GraphNode, "sessionID" | "priority" | "category" | "desc" | "content" | "codeHash">
  const task = {
    moduleID: null,
    moduleName: null,
    verification: null,
    latestEvidence: null,
  } satisfies Pick<GraphWorkflowTask, "moduleID" | "moduleName" | "verification" | "latestEvidence">
  const version = {
    message: null,
  } satisfies Pick<GraphVersion, "message">
  const planView = {
    versionNumber: null,
    publishedAt: null,
  } satisfies Pick<SessionPlanView, "versionNumber" | "publishedAt">
  const toolRun = {
    inputSummary: null,
    outputSummary: null,
    error: null,
    evidence: null,
  } satisfies Pick<GraphToolRun, "inputSummary" | "outputSummary" | "error" | "evidence">
  const evidence = {
    kind: "diagnostics",
    nodeID: "node_test",
    criteria: [],
    artifactPaths: [],
    projectChecksOnly: false,
    complete: false,
    passed: false,
    commands: [
      {
        name: "test",
        command: "bun test",
        exitCode: null,
        timedOut: true,
        passed: false,
      },
    ],
  } satisfies NonNullable<GraphWorkflowTask["latestEvidence"]>
  const workflow = {
    mode: null,
    activeOperationKind: null,
    checkpoint: {
      status: "none",
      kind: null,
      scopeNodeID: null,
      scopeName: null,
      reason: null,
    },
    currentTask: null,
  } satisfies Pick<GraphWorkflow, "mode" | "activeOperationKind" | "checkpoint" | "currentTask">
  const activeOperation = {
    _tag: "GraphWorkflowActiveOperation",
    operationKind: "artifact_apply",
    message: "Pause or wait",
  } satisfies GraphWorkflowActiveOperation
  const modeError: GraphWorkflowModeError = activeOperation
  const planViewServerError: GraphPlanViewErrors[500] = { _tag: "InternalServerError" }

  expect(Object.values(node)).toEqual([null, null, null, null, null, null])
  expect(Object.values(task)).toEqual([null, null, null, null])
  expect(version.message).toBeNull()
  expect(Object.values(planView)).toEqual([null, null])
  expect(Object.values(toolRun)).toEqual([null, null, null, null])
  expect(evidence.commands[0].exitCode).toBeNull()
  expect(workflow).toEqual({
    mode: null,
    activeOperationKind: null,
    checkpoint: {
      status: "none",
      kind: null,
      scopeNodeID: null,
      scopeName: null,
      reason: null,
    },
    currentTask: null,
  })
  expect(modeError._tag).toBe("GraphWorkflowActiveOperation")
  expect(planViewServerError._tag).toBe("InternalServerError")
})

test("keeps generated Graph workflow methods", () => {
  const graph = new Graph()

  expect(typeof graph.workflow).toBe("function")
  expect(typeof graph.planView).toBe("function")
  expect(typeof graph.workflowMode).toBe("function")
  expect(typeof graph.workflowApprove).toBe("function")
  expect(typeof graph.workflowPause).toBe("function")
})

test("generates the optional Graph promotion revision guard and conflict", async () => {
  const source = await Bun.file(new URL("../src/v2/gen/types.gen.ts", import.meta.url)).text()
  const payload = source.slice(source.indexOf("export type GraphPromotePayload"), source.indexOf("export type GraphPromoteResult"))
  const errors = source.slice(
    source.indexOf("export type GraphPromoteErrors"),
    source.indexOf("export type GraphPromoteResponses"),
  )

  expect(payload).toContain("expectedRevision?:")
  expect(errors).toContain("GraphWorkflowRevisionConflict")
})

test("strictly compiles nullable Graph fields and workflow methods", async () => {
  const check = Bun.spawn([
    "bunx",
    "tsgo",
    "--noEmit",
    "--ignoreConfig",
    "--strict",
    "--skipLibCheck",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
    "test/fixtures/graph-nullability.ts",
  ], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    check.exited,
    new Response(check.stdout).text(),
    new Response(check.stderr).text(),
  ])

  expect(`${stdout}${stderr}`).toBe("")
  expect(exitCode).toBe(0)
})
