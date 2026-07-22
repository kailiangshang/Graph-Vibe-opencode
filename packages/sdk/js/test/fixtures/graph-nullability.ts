import type {
  GraphNode,
  GraphPlanViewErrors,
  GraphToolRun,
  GraphVersion,
  GraphWorkflow,
  GraphWorkflowApproveErrors,
  GraphWorkflowActiveOperation,
  GraphWorkflowErrors,
  GraphWorkflowModeError,
  GraphWorkflowModeErrors,
  GraphWorkflowPauseErrors,
  GraphWorkflowTask,
  SessionPlanView,
} from "../../src/v2/gen/types.gen.js"
import type { Graph, OpencodeClient } from "../../src/v2/gen/sdk.gen.js"

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
const internalServerError = { _tag: "InternalServerError" } as const
const workflowServerError: GraphWorkflowErrors[500] = internalServerError
const modeServerError: GraphWorkflowModeErrors[500] = internalServerError
const approveServerError: GraphWorkflowApproveErrors[500] = internalServerError
const pauseServerError: GraphWorkflowPauseErrors[500] = internalServerError
const planViewServerError: GraphPlanViewErrors[500] = internalServerError

declare const graph: Graph
declare const sdk: () => { client: OpencodeClient; directory: string }
graph.workflow
graph.planView
graph.workflowMode
graph.workflowApprove
graph.workflowPause
sdk().client.graph.planView({ session: "ses_test", directory: sdk().directory })

void node
void task
void version
void planView
void toolRun
void evidence
void workflow
void modeError
void workflowServerError
void modeServerError
void approveServerError
void pauseServerError
void planViewServerError
