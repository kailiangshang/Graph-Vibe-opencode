import { base64Encode } from "@opencode-ai/core/util/encode"

export const TASK_DRAFT = "What do you want to build or change?\n\nGoal:\nSuccess criteria:\nConstraints:"

export const GRAPH_MODES = [
  { value: "atomic", label: "Atomic", description: "Pause after every verified task" },
  { value: "module", label: "Module", description: "Pause at module and decision checkpoints", recommended: true },
  { value: "autopilot", label: "Autopilot", description: "Run all tasks unless blocked or paused" },
] as const

export function formatPlanAdmission(input: Record<string, unknown>, workflow?: Workflow) {
  const nodes = Array.isArray(input.nodes) ? input.nodes.filter(isRecord) : []
  const edges = Array.isArray(input.edges) ? input.edges.filter(isRecord) : []
  const prd = nodes.find((node) => node.type === "prd")
  const goal = typeof prd?.desc === "string" ? prd.desc : typeof prd?.name === "string" ? prd.name : "Current work plan"
  if (workflow) {
    const mode = workflow.mode ? workflow.mode[0].toUpperCase() + workflow.mode.slice(1) : "Not selected"
    const nextStop =
      workflow.checkpoint.status === "pending"
        ? "Now, at the pending checkpoint"
        : workflow.mode === "atomic"
          ? "After the current task"
          : workflow.mode === "module"
            ? "After the current module"
            : workflow.mode === "autopilot"
              ? "At a decision, failure, or pause"
              : "After execution mode is selected"
    return {
      goal,
      mode,
      currentTask: workflow.currentTask?.name ?? "",
      nextStop,
      moduleCount: workflow.modules.length,
      taskCount: workflow.modules.reduce((count, module) => count + module.tasks.length, 0),
      modules: workflow.modules.map((module) => ({
        name: module.name,
        tasks: module.tasks.map((task) =>
          [task.name, task.verification?.criteria.join("; ")].filter(Boolean).join(" · "),
        ),
      })),
    }
  }
  const tasks = nodes
    .filter(
      (node): node is Record<string, unknown> & { id: string; name: string } =>
        node.type === "atomic" && typeof node.id === "string" && typeof node.name === "string",
    )
    .filter((task, index, all) => all.findIndex((candidate) => candidate.id === task.id) === index)
  const modules = nodes
    .filter(
      (node): node is Record<string, unknown> & { id: string; name: string } =>
        node.type === "composite" && typeof node.id === "string" && typeof node.name === "string",
    )
    .map((module) => ({
      id: module.id,
      name: module.name,
      tasks: tasks.filter((task) =>
        edges.some((edge) => edge.relation === "contains" && edge.sourceID === module.id && edge.targetID === task.id),
      ),
    }))
  const assigned = new Set(modules.flatMap((module) => module.tasks.map((task) => task.id)))
  const grouped = [
    ...modules,
    ...(tasks.some((task) => !assigned.has(task.id))
      ? [{ id: null, name: "Ungrouped", tasks: tasks.filter((task) => !assigned.has(task.id)) }]
      : []),
  ]
  return {
    goal,
    mode: "Not selected",
    currentTask: typeof tasks[0]?.name === "string" ? tasks[0].name : "",
    nextStop: "After execution mode is selected",
    moduleCount: modules.length,
    taskCount: tasks.length,
    modules: grouped.map((module) => ({
      name: module.name,
      tasks: module.tasks.map((task) => {
        const criteria =
          isRecord(task.verification) && Array.isArray(task.verification.criteria)
            ? task.verification.criteria.filter((item): item is string => typeof item === "string")
            : []
        return [task.name, criteria.join("; ")].filter(Boolean).join(" · ")
      }),
    })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function workflowActions(_workflow: {
  mode?: string | null
  phase: string
  checkpoint: { status: string; kind?: string | null }
}) {
  const complete = _workflow.phase === "complete"
  const pending = _workflow.checkpoint.status === "pending"
  return {
    continue: !!_workflow.mode && pending,
    pause: !!_workflow.mode && !complete && !pending && _workflow.phase !== "failed",
  }
}

export function workflowActionFailure(action: "mode" | "continue" | "pause", error: unknown) {
  if (isRevisionConflict(error))
    return {
      kind: "revision-conflict" as const,
      message: "The workflow changed in another client. Status was refreshed; review it and explicitly retry.",
    }
  if (error instanceof Error)
    return {
      kind: "network" as const,
      message: "The workflow service could not be reached. Check the connection and retry this action.",
    }
  if (isRecord(error) && error._tag === "BadRequest" && action === "mode")
    return {
      kind: "active-workflow" as const,
      message: "Execution mode cannot change while work is active. Pause the workflow first.",
    }
  if (isRecord(error) && error._tag === "BadRequest" && action === "continue")
    return {
      kind: "invalid-action" as const,
      message: "Continue is unavailable for the current workflow state. Review the checkpoint and available actions.",
    }
  if (isRecord(error) && error._tag === "BadRequest")
    return {
      kind: "apply-rejected" as const,
      message:
        "Pause was not accepted at the current mutation boundary. Wait for the active change to finish, then retry.",
    }
  return {
    kind: "rejected" as const,
    message: "The workflow action was rejected. Review the current state before retrying.",
  }
}

type StartModeClient = {
  graph: {
    workflow(input: {
      session: string
      directory?: string
    }): Promise<{ data?: { revision: number | string }; error?: unknown }>
    workflowMode?(input: {
      session: string
      directory?: string
      graphWorkflowModePayload: { mode: "atomic" | "module" | "autopilot"; expectedRevision: number }
    }): Promise<{ data?: unknown; error?: unknown }>
  }
}

export async function persistGraphStartMode(
  client: StartModeClient,
  input: { session: string; directory?: string; mode: "atomic" | "module" | "autopilot" },
  start: () => void,
) {
  const current = await client.graph
    .workflow({ session: input.session, directory: input.directory })
    .catch((error) => ({ error }))
  if (current.error instanceof Error) return { ok: false as const, ...workflowActionFailure("mode", current.error) }
  if (!("data" in current) || !current.data || !client.graph.workflowMode)
    return {
      ok: false as const,
      message: "No durable workflow exists for this session. Create or select a session, then retry /graph-start.",
    }
  const changed = await client.graph
    .workflowMode({
      session: input.session,
      directory: input.directory,
      graphWorkflowModePayload: { mode: input.mode, expectedRevision: Number(current.data.revision) },
    })
    .catch((error) => ({ error }))
  if (changed.error || !("data" in changed) || !changed.data) {
    const failure = workflowActionFailure("mode", changed.error)
    if (failure.kind === "revision-conflict")
      await client.graph.workflow({ session: input.session, directory: input.directory })
    return { ok: false as const, kind: failure.kind, message: failure.message }
  }
  start()
  return { ok: true as const }
}

type WorkflowClient<T extends { revision: number | string }> = {
  graph: {
    workflow(input: { session: string; directory?: string }): Promise<{ data?: T; error?: unknown }>
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

export async function continueWorkflow<T extends { revision: number | string }>(
  client: WorkflowClient<T>,
  input: { session: string; directory?: string },
) {
  const current = await client.graph.workflow(input).catch((error) => ({ error }))
  if (current.error instanceof Error) return { ok: false as const, ...workflowActionFailure("continue", current.error) }
  if (!("data" in current) || !current.data || !client.graph.workflowApprove)
    return { ok: false as const, message: "Unable to load current workflow status." }
  const response = await client.graph
    .workflowApprove({
      ...input,
      graphWorkflowApprovePayload: { expectedRevision: Number(current.data.revision) },
    })
    .catch((error) => ({ error }))
  if (!response.error && "data" in response && response.data) return { ok: true as const, workflow: response.data }
  const failure = workflowActionFailure("continue", response.error)
  if (failure.kind !== "revision-conflict") return { ok: false as const, ...failure }
  const refreshed = await client.graph.workflow(input)
  return {
    ok: false as const,
    conflict: true as const,
    workflow: refreshed.data,
    message: "The plan changed before approval. Status was refreshed; review it and Continue again.",
  }
}

export async function pauseWorkflow<T extends { revision: number | string }>(
  client: WorkflowClient<T>,
  input: { session: string; directory?: string },
) {
  const current = await client.graph.workflow(input).catch((error) => ({ error }))
  if (current.error instanceof Error) return { ok: false as const, ...workflowActionFailure("pause", current.error) }
  if (!("data" in current) || !current.data || !client.graph.workflowPause)
    return { ok: false as const, message: "Unable to load current workflow status." }
  const response = await client.graph
    .workflowPause({
      ...input,
      graphWorkflowPausePayload: { expectedRevision: Number(current.data.revision) },
    })
    .catch((error) => ({ error }))
  if (!response.error && "data" in response && response.data) return { ok: true as const, workflow: response.data }
  const failure = workflowActionFailure("pause", response.error)
  if (failure.kind !== "revision-conflict") return { ok: false as const, ...failure }
  const refreshed = await client.graph.workflow(input)
  return {
    ok: false as const,
    conflict: true as const,
    workflow: refreshed.data,
    message: "The plan changed before it could be paused. Status was refreshed; review it and Pause again.",
  }
}

function isRevisionConflict(error: unknown) {
  return isRecord(error) && error._tag === "GraphWorkflowRevisionConflict"
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

export function graphToolActivity(tool: string, status?: string): string | undefined {
  if (status === "error") {
    if (tool === "graph_plan_admit") return "Work plan could not be prepared"
    if (tool === "graph_diagnostics_run") return "Task verification failed"
    if (tool.startsWith("graph_artifact_")) return "Task changes could not be applied"
    if (tool === "graph_build_gate") return "Task readiness check failed"
    if (tool.startsWith("graph_")) return "Graph workflow activity failed"
  }
  if (tool === "graph_plan_admit") return "Preparing work plan"
  if (tool === "graph_build_gate") return "Checking task readiness"
  if (tool === "graph_artifact_begin" || tool === "graph_artifact_chunk" || tool === "graph_artifact_seal")
    return "Preparing task changes"
  if (tool === "graph_artifact_apply") return "Applying task changes"
  if (tool === "graph_diagnostics_run") return "Verifying task"
  if (tool === "graph_workflow_pause") return "Workflow paused"
  if (tool === "graph_promote") return "Workflow complete"
  if (tool.startsWith("graph_")) return "Graph workflow activity"
  return undefined
}

export function graphToolError(error: string) {
  return error.replace(/\bgraph_[a-z0-9_]+\b/gi, "Graph workflow activity")
}

export function graphToolSuccessDetails(tool: string, input: Record<string, unknown>, _output: string) {
  const task = [input.nodeName, input.taskName, input.targetName].find(
    (value): value is string => typeof value === "string" && !!value,
  )
  const detail =
    tool === "graph_plan_admit"
      ? "Work plan prepared"
      : tool === "graph_build_gate"
        ? "Task readiness checked"
        : tool === "graph_artifact_apply"
          ? "Task changes applied"
          : tool === "graph_diagnostics_run"
            ? "Task verification completed"
            : tool === "graph_workflow_pause"
              ? "Workflow pause recorded"
              : tool === "graph_promote"
                ? "Workflow completion recorded"
                : tool.startsWith("graph_artifact_")
                  ? "Task changes prepared"
                  : "Graph workflow activity completed"
  return [detail, task].filter(Boolean).join(" · ")
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
