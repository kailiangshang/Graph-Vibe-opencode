export type GraphActivityPhase = "planning" | "implementing" | "verifying" | "checkpoint" | "paused" | "complete"
export type GraphActivityInfo = { title: string; phase: GraphActivityPhase; summary?: string }

export function graphActivityError(error: string) {
  return error.replace(/\bgraph_[a-z0-9_]+\b/gi, "Graph workflow activity")
}

type PlanTask = { id: string; name: string; verification?: { criteria?: readonly string[] } | null }
export type WorkflowProjection = {
  mode?: string | null
  phase?: string
  currentTask?: { id: string; name: string; moduleName?: string | null } | null
  checkpoint?: { status: string; kind?: string | null }
  modules?: Array<{ id: string; name: string; tasks: PlanTask[] }>
}

export function graphPlanCard(input: Record<string, unknown>, workflow?: WorkflowProjection) {
  if (workflow?.modules) {
    return {
      goal: goal(input),
      mode: title(workflow.mode),
      currentTask: workflow.currentTask?.name ?? "No current task",
      nextStop: nextStop(workflow.mode, workflow.checkpoint),
      moduleCount: workflow.modules.length,
      taskCount: workflow.modules.reduce((count, module) => count + module.tasks.length, 0),
      modules: workflow.modules,
    }
  }
  const nodes = Array.isArray(input.nodes) ? input.nodes.filter(record) : []
  const edges = Array.isArray(input.edges) ? input.edges.filter(record) : []
  const tasks = nodes.filter(
    (node): node is Record<string, unknown> & { id: string; name: string } =>
      node.type === "atomic" && typeof node.id === "string" && typeof node.name === "string",
  )
  const modules = nodes.filter(
    (node): node is Record<string, unknown> & { id: string; name: string } =>
      node.type === "composite" && typeof node.id === "string" && typeof node.name === "string",
  )
  const grouped = modules.map((module) => ({
    id: module.id,
    name: module.name,
    tasks: tasks
      .filter((task) =>
        edges.some((edge) => edge.relation === "contains" && edge.sourceID === module.id && edge.targetID === task.id),
      )
      .map(planTask),
  }))
  const assigned = new Set(grouped.flatMap((module) => module.tasks.map((task) => task.id)))
  const ungrouped = tasks.filter((task) => !assigned.has(task.id)).map(planTask)
  return {
    goal: goal(input),
    mode: "Not selected",
    currentTask: tasks[0]?.name,
    nextStop: "After execution mode is selected",
    moduleCount: grouped.length,
    taskCount: tasks.length,
    modules: [...grouped, ...(ungrouped.length ? [{ id: null, name: "Ungrouped", tasks: ungrouped }] : [])],
  }
}

export function graphActivityInfo(
  tool: string,
  input: Record<string, unknown>,
  status?: string,
): GraphActivityInfo | undefined {
  const summary = taskSummary(input)
  if (status === "error") {
    if (tool === "graph_plan_admit") return { title: "Work plan could not be prepared", phase: "planning" }
    if (tool === "graph_diagnostics_run") return { title: "Task verification failed", phase: "verifying", summary }
    if (tool.startsWith("graph_artifact_"))
      return { title: "Task changes could not be applied", phase: "implementing", summary }
    if (tool === "graph_build_gate") return { title: "Task readiness check failed", phase: "implementing", summary }
    if (tool.startsWith("graph_")) return { title: "Graph workflow activity failed", phase: "implementing", summary }
  }
  if (tool === "graph_plan_admit") return { title: "Preparing work plan", phase: "planning" as const }
  if (tool === "graph_build_gate") {
    if (input.checkpoint === "pending") return { title: "Waiting at checkpoint", phase: "checkpoint" as const, summary }
    return { title: "Checking task readiness", phase: "implementing" as const, summary }
  }
  if (tool === "graph_artifact_begin" || tool === "graph_artifact_chunk" || tool === "graph_artifact_seal")
    return { title: "Preparing task changes", phase: "implementing" as const, summary }
  if (tool === "graph_artifact_apply")
    return { title: "Applying task changes", phase: "implementing" as const, summary }
  if (tool === "graph_diagnostics_run") return { title: "Verifying task", phase: "verifying" as const, summary }
  if (tool === "graph_workflow_pause") return { title: "Workflow paused", phase: "paused" as const, summary }
  if (tool === "graph_promote")
    return { title: "Workflow complete", phase: "complete" as const, summary: progress(input) }
  if (tool.startsWith("graph_")) return { title: "Graph workflow activity", phase: "implementing", summary }
  return undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function planTask(value: Record<string, unknown> & { id: string; name: string }): PlanTask {
  const verification =
    record(value.verification) && Array.isArray(value.verification.criteria)
      ? { criteria: value.verification.criteria.filter((item): item is string => typeof item === "string") }
      : undefined
  return { id: value.id, name: value.name, verification }
}

function goal(input: Record<string, unknown>) {
  const nodes = Array.isArray(input.nodes) ? input.nodes.filter(record) : []
  const prd = nodes.find((node) => node.type === "prd")
  return typeof prd?.desc === "string" ? prd.desc : typeof prd?.name === "string" ? prd.name : "Current work plan"
}

function title(value: string | null | undefined) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Not selected"
}

function nextStop(mode: string | null | undefined, checkpoint?: { status: string; kind?: string | null }) {
  if (checkpoint?.status === "pending") return "Now, at the pending checkpoint"
  if (mode === "atomic") return "After the current task"
  if (mode === "module") return "After the current module"
  if (mode === "autopilot") return "At a decision, failure, or pause"
  return "After execution mode is selected"
}

function taskSummary(input: Record<string, unknown>): string | undefined {
  for (const key of ["nodeName", "taskName", "targetName", "targetNodeID"]) {
    if (typeof input[key] === "string" && input[key]) return input[key]
  }
  return undefined
}

function progress(input: Record<string, unknown>): string | undefined {
  if (typeof input.verified !== "number" || typeof input.total !== "number") return undefined
  return `${input.verified}/${input.total} tasks verified`
}
