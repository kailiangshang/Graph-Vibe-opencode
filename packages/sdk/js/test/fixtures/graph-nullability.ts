import type { GraphNode, GraphWorkflow, GraphWorkflowTask } from "../../src/v2/gen/types.gen.js"
import type { Graph } from "../../src/v2/gen/sdk.gen.js"

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

const workflow = {
  mode: null,
  checkpoint: {
    status: "none",
    kind: null,
    scopeNodeID: null,
    scopeName: null,
    reason: null,
  },
  currentTask: null,
} satisfies Pick<GraphWorkflow, "mode" | "checkpoint" | "currentTask">

declare const graph: Graph
graph.workflow
graph.workflowMode
graph.workflowApprove
graph.workflowPause

void node
void task
void workflow
