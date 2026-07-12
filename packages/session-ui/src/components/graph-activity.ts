export type GraphActivityPhase = "planning" | "implementing" | "verifying" | "checkpoint" | "paused" | "complete"
export type GraphActivityInfo = { title: string; phase: GraphActivityPhase; summary?: string }

export function graphActivityInfo(tool: string, input: Record<string, unknown>): GraphActivityInfo | undefined {
  const summary = taskSummary(input)
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
  return undefined
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
