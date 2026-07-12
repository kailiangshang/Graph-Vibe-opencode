import { base64Encode } from "@opencode-ai/core/util/encode"

export const TASK_DRAFT = "What do you want to build or change?\n\nGoal:\nSuccess criteria:\nConstraints:"

export const GRAPH_MODES = [
  { value: "atomic", label: "Atomic", description: "Pause after every verified task" },
  { value: "module", label: "Module", description: "Pause at module and decision checkpoints", recommended: true },
  { value: "autopilot", label: "Autopilot", description: "Run all tasks unless blocked or paused" },
] as const

type WorkflowClient = {
  graph: {
    workflow(input: {
      session: string
      directory?: string
    }): Promise<{ data?: { revision: number | string }; error?: unknown }>
    workflowApprove?(input: {
      session: string
      directory?: string
      graphWorkflowApprovePayload: { expectedRevision: number }
    }): Promise<{ data?: unknown; error?: unknown }>
    workflowPause?(input: {
      session: string
      directory?: string
      graphWorkflowPausePayload: { expectedRevision: number; reason?: string }
    }): Promise<{ data?: unknown; error?: unknown }>
  }
}

export async function continueWorkflow(client: WorkflowClient, input: { session: string; directory?: string }) {
  const current = await client.graph.workflow(input)
  if (!current.data || !client.graph.workflowApprove)
    return { ok: false as const, message: "Unable to load current workflow status." }
  const response = await client.graph.workflowApprove({
    ...input,
    graphWorkflowApprovePayload: { expectedRevision: Number(current.data.revision) },
  })
  if (!response.error) return { ok: true as const, workflow: response.data }
  const refreshed = await client.graph.workflow(input)
  return {
    ok: false as const,
    conflict: true as const,
    workflow: refreshed.data,
    message: "The plan changed before approval. Status was refreshed; review it and Continue again.",
  }
}

export async function pauseWorkflow(client: WorkflowClient, input: { session: string; directory?: string }) {
  const current = await client.graph.workflow(input)
  if (!current.data || !client.graph.workflowPause)
    return { ok: false as const, message: "Unable to load current workflow status." }
  const response = await client.graph.workflowPause({
    ...input,
    graphWorkflowPausePayload: { expectedRevision: Number(current.data.revision) },
  })
  if (!response.error) return { ok: true as const, workflow: response.data }
  const refreshed = await client.graph.workflow(input)
  return {
    ok: false as const,
    conflict: true as const,
    workflow: refreshed.data,
    message: "The plan changed before it could be paused. Status was refreshed; review it and Pause again.",
  }
}

export type Workflow = {
  mode: "atomic" | "module" | "autopilot" | null
  revision: number | string
  phase: string
  checkpoint: { status: string; kind?: string | null; reason?: string | null }
  currentTask: { id: string; name: string; moduleName?: string | null; current: boolean } | null
  progress: { total: number | string; verified: number | string; failed: number | string; percent: number | string }
  modules: ReadonlyArray<{
    id: string
    name: string
    tasks: ReadonlyArray<{
      id: string
      name: string
      status: string
      testStatus: string
      current: boolean
      verification?: { criteria: readonly string[] } | null
      latestEvidence?: { passed: boolean; commands: ReadonlyArray<{ name: string; passed: boolean }> } | null
    }>
  }>
}

export function graphToolActivity(tool: string): string | undefined {
  if (tool === "graph_plan_admit") return "Preparing work plan"
  if (tool === "graph_build_gate") return "Checking task readiness"
  if (tool === "graph_artifact_begin" || tool === "graph_artifact_chunk" || tool === "graph_artifact_seal")
    return "Preparing task changes"
  if (tool === "graph_artifact_apply") return "Applying task changes"
  if (tool === "graph_diagnostics_run") return "Verifying task"
  return undefined
}

export function formatWorkflowStatus(workflow: Workflow) {
  const title = (value: string | null) => (value ? value[0].toUpperCase() + value.slice(1) : "Not selected")
  return {
    mode: title(workflow.mode),
    phase: title(workflow.phase),
    progress: `${Number(workflow.progress.verified)}/${Number(workflow.progress.total)} verified (${Number(workflow.progress.percent)}%)`,
    current: workflow.currentTask
      ? [workflow.currentTask.moduleName, workflow.currentTask.name].filter(Boolean).join(" · ")
      : "No active task",
    checkpoint:
      workflow.checkpoint.status === "pending"
        ? `${title(workflow.checkpoint.kind ?? "checkpoint")} checkpoint: ${workflow.checkpoint.reason ?? "Approval required"}`
        : "No pending checkpoint",
    nextAction: nextAction(workflow),
    modules: workflow.modules.map((module) => ({
      name: module.name,
      progress: `${module.tasks.filter((task) => task.status === "verified").length}/${module.tasks.length}`,
      tasks: module.tasks.map((task) => {
        const marker = task.current ? "→" : task.status === "verified" ? "✓" : task.testStatus === "failed" ? "!" : "·"
        const verification = task.testStatus === "none" ? " · verification not run" : ""
        return `${marker} ${task.name} — ${task.status}${verification}`
      }),
    })),
  }
}

function nextAction(workflow: Workflow) {
  if (workflow.phase === "complete") return "Review the completed work."
  if (workflow.checkpoint.status !== "pending") return "Work continues within the authorized scope."
  if (workflow.checkpoint.kind === "module") return "Continue to authorize the next module."
  if (workflow.checkpoint.kind === "atomic") return "Continue to authorize the next task."
  if (workflow.checkpoint.kind === "pause") return "Continue when you are ready to resume."
  return "Review the checkpoint, then Continue."
}

export function startGraphPrompt(
  prompt: { set(value: { input: string; parts: never[] }): void; focus(): void } | undefined,
) {
  if (!prompt) return false
  prompt.set({ input: TASK_DRAFT, parts: [] })
  prompt.focus()
  return true
}

type NodeStatus = "pending" | "implemented" | "verified" | "deprecated"
type TestStatus = "none" | "pending" | "passed" | "failed"
type GraphNode = { status: NodeStatus; testStatus: TestStatus }

export function summarizeCurrentPlan(nodes: readonly GraphNode[]) {
  const counts = <T extends string>(values: readonly T[], get: (node: GraphNode) => T) =>
    values.map(
      (value) => [value[0].toUpperCase() + value.slice(1), nodes.filter((node) => get(node) === value).length] as const,
    )

  return {
    total: nodes.length,
    nodes: counts(["pending", "implemented", "verified", "deprecated"], (node) => node.status),
    diagnostics: counts(["none", "pending", "passed", "failed"], (node) => node.testStatus),
  }
}

export function graphWebUrl(input: {
  webUrl?: string
  serverUrl: string
  directory: string
  sessionID: string
  preferDirectoryRoute?: boolean
}) {
  if (!input.webUrl) return
  const web = new URL(input.webUrl)
  const server = new URL(input.serverUrl)
  const route =
    input.preferDirectoryRoute || web.origin === server.origin
      ? `/${base64Encode(input.directory)}/session/${input.sessionID}/graph`
      : `/server/${base64Encode(input.serverUrl.replace(/\/$/, ""))}/session/${input.sessionID}/graph`
  return web.origin + route
}

export async function graphWebAvailable(
  webUrl: string | undefined,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
  headers?: RequestInit["headers"],
) {
  if (!webUrl) return false
  return request(webUrl, { method: "HEAD", headers })
    .then((response) => response.ok)
    .catch(() => false)
}
