import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { GraphCanvas } from "./graph-canvas"
import type { GraphView } from "./graph-helpers"

export const COCKPIT_REGIONS = ["Task rail", "Workflow graph", "Task details"] as const
export const MOBILE_TABS = ["tasks", "graph", "details"] as const

export function cockpitActions(
  workflow: { mode?: string | null; phase: string; checkpoint: { status: string; kind?: string | null } },
  pending?: "mode" | "continue" | "pause",
) {
  const checkpoint = workflow.checkpoint.status === "pending"
  return {
    continue: !!workflow.mode && checkpoint,
    pause: !!workflow.mode && !checkpoint && workflow.phase !== "complete" && workflow.phase !== "failed",
    mode: workflow.phase === "planning" || checkpoint,
    continuePending: pending === "continue",
    pausePending: pending === "pause",
  }
}

type MinimalWorkflow = {
  mode?: string | null
  phase: string
  tasks: readonly unknown[]
  checkpoint: { status: string; kind?: string | null }
}

export function cockpitViewState(input: {
  loading?: boolean
  disconnected?: boolean
  error?: boolean
  conflict?: boolean
  workflow?: MinimalWorkflow
}) {
  if (input.loading) return "loading"
  if (input.disconnected) return "disconnected"
  if (input.conflict) return "conflict"
  if (input.error) return "error"
  if (!input.workflow || input.workflow.tasks.length === 0) return "empty"
  if (!input.workflow.mode) return "mode-required"
  if (input.workflow.phase === "complete") return "complete"
  if (input.workflow.phase === "failed") return "failed"
  if (input.workflow.checkpoint.status === "pending" && input.workflow.checkpoint.kind === "pause") return "paused"
  if (input.workflow.checkpoint.status === "pending") return "checkpoint"
  return "ready"
}

export function workflowAnnouncement(workflow: {
  mode: string | null
  phase: string
  currentTask: { name: string; moduleName?: string | null } | null
  progress: { verified: number; total: number; percent: number }
}) {
  const title = (value: string) => value[0].toUpperCase() + value.slice(1)
  const mode = workflow.mode ? `${title(workflow.mode)} mode.` : "Execution mode not selected."
  const current = workflow.currentTask
    ? ` ${title(workflow.phase)} ${workflow.currentTask.name}${workflow.currentTask.moduleName ? ` in ${workflow.currentTask.moduleName}` : ""}.`
    : ` ${title(workflow.phase)}.`
  return `${mode}${current} ${workflow.progress.verified} of ${workflow.progress.total} tasks verified, ${workflow.progress.percent} percent.`
}

export function rollupWorkflowStatus(tasks: ReadonlyArray<{ status: string; testStatus: string }>) {
  if (tasks.some((task) => task.testStatus === "failed")) return "failed"
  if (tasks.length > 0 && tasks.every((task) => task.status === "verified")) return "verified"
  if (tasks.some((task) => task.status !== "pending" || task.testStatus !== "none")) return "implemented"
  return "pending"
}

type Task = {
  id: string
  name: string
  moduleID?: string | null
  moduleName?: string | null
  status: string
  testStatus: string
  current: boolean
  buildable?: boolean
  verification?: {
    criteria: readonly string[]
    diagnostics: ReadonlyArray<{ name: string; paths?: readonly string[] }>
  } | null
  latestEvidence?: {
    artifactPaths: readonly string[]
    commands: ReadonlyArray<{ name: string; passed: boolean; excerpt?: string }>
    passed: boolean
  } | null
}

type CockpitWorkflow = {
  mode: "atomic" | "module" | "autopilot" | null
  revision: number
  phase: string
  checkpoint: {
    status: string
    kind?: string | null
    reason?: string | null
    scopeNodeID?: string | null
  }
  currentTask: { id: string; name: string; moduleName?: string | null } | null
  progress: { verified: number; total: number; failed: number; percent: number }
  tasks: Task[]
  modules: Array<{
    id: string | null
    name: string
    status?: string
    progress: { verified: number; total: number }
    tasks: Task[]
  }>
}

export function GraphCockpit(props: {
  workflow: CockpitWorkflow
  graph: GraphView
  selectedNodeID: string | null
  onSelectNode: (id: string | null) => void
  onContinue?: () => void
  onPause?: () => void
  onModeChange?: (mode: "atomic" | "module" | "autopilot") => void
  pendingAction?: "mode" | "continue" | "pause"
}) {
  const [local, setLocal] = createStore({
    mobileTab: "tasks" as "tasks" | "graph" | "details",
    centerNodeID: null as string | null,
  })
  const selectedTask = () =>
    props.workflow.tasks.find((task) => task.id === props.selectedNodeID) ??
    props.workflow.tasks.find((task) => task.id === props.workflow.currentTask?.id)
  const selectedID = () => props.selectedNodeID ?? props.workflow.currentTask?.id ?? props.graph.nodes[0]?.id ?? null
  const node = () => props.graph.nodes.find((item) => item.id === selectedID())
  const dependencies = () =>
    props.graph.edges
      .filter((edge) => edge.targetID === selectedID() && edge.relation === "blocks")
      .map((edge) => props.graph.nodes.find((item) => item.id === edge.sourceID)?.name)
      .filter((name): name is string => !!name)
  const evidence = () => selectedTask()?.latestEvidence
  const actions = () => cockpitActions(props.workflow, props.pendingAction)
  const state = () => cockpitViewState({ workflow: props.workflow })
  const canvas = () => ({
    ...props.graph,
    nodes: props.graph.nodes.map((item) => {
      const task = props.workflow.tasks.find((candidate) => candidate.id === item.id)
      const module = props.workflow.modules.find((candidate) => candidate.id === item.id)
      const blockers = props.graph.edges.filter(
        (edge) =>
          edge.targetID === item.id &&
          edge.relation === "blocks" &&
          props.graph.nodes.find((node) => node.id === edge.sourceID)?.status !== "verified",
      )
      const status =
        task?.status ??
        module?.status ??
        (module
          ? rollupWorkflowStatus(module.tasks)
          : item.type === "prd"
            ? rollupWorkflowStatus(props.workflow.tasks)
            : item.status)
      const scopedTasks = module?.tasks ?? (item.type === "prd" ? props.workflow.tasks : [])
      return {
        ...item,
        status,
        testStatus:
          task?.testStatus ?? (status === "failed" ? "failed" : status === "verified" ? "passed" : item.testStatus),
        buildable:
          task?.buildable ??
          (scopedTasks.length ? scopedTasks.some((candidate) => candidate.buildable) : blockers.length === 0),
        blockerCount: blockers.length,
        checkpoint: props.workflow.checkpoint.scopeNodeID === item.id && props.workflow.checkpoint.status === "pending",
      }
    }),
  })
  const activateTab = (tab: (typeof MOBILE_TABS)[number]) => {
    setLocal("mobileTab", tab)
    document.getElementById(`graph-tab-${tab}`)?.focus()
  }

  return (
    <section class="graph-cockpit flex h-full min-h-0 flex-col text-text-strong" aria-label="Graph workflow cockpit">
      <header class="graph-glass flex min-h-16 flex-wrap items-center gap-3 border-b px-4 py-2">
        <div class="mr-auto min-w-48">
          <div class="text-xs font-medium uppercase tracking-[0.16em] text-text-weak">Workflow control</div>
          <div class="font-semibold">{props.workflow.currentTask?.name ?? "No current task"}</div>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-text-weak">Mode</span>
          <select
            class="graph-field min-h-10 rounded-md px-2"
            aria-label="Execution mode"
            value={props.workflow.mode ?? ""}
            disabled={!actions().mode || props.pendingAction === "mode"}
            onChange={(event) => {
              const mode = event.currentTarget.value
              if (mode === "atomic" || mode === "module" || mode === "autopilot") props.onModeChange?.(mode)
            }}
          >
            <option value="" disabled>
              Select mode
            </option>
            <option value="atomic">Atomic</option>
            <option value="module">Module (recommended)</option>
            <option value="autopilot">Autopilot</option>
          </select>
        </label>
        <div class="min-w-36" aria-label={`${props.workflow.progress.percent}% complete`}>
          <div class="mb-1 flex justify-between text-xs text-text-weak">
            <span>
              {props.workflow.progress.verified}/{props.workflow.progress.total} verified
            </span>
            <span>{props.workflow.progress.percent}%</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-raised-base">
            <div class="h-full bg-[var(--graph-current)]" style={{ width: `${props.workflow.progress.percent}%` }} />
          </div>
        </div>
        <Show when={actions().pause}>
          <button class="graph-action secondary" disabled={actions().pausePending} onClick={props.onPause}>
            Pause
          </button>
        </Show>
        <Show when={actions().continue}>
          <button class="graph-action primary" disabled={actions().continuePending} onClick={props.onContinue}>
            Continue
          </button>
        </Show>
      </header>

      <Show when={state() !== "ready"}>
        <div class="graph-state-strip graph-glass border-b px-4 py-2 text-sm" role="status">
          {stateLabel(state(), props.workflow.checkpoint.reason)}
        </div>
      </Show>

      <div class="graph-mobile-tabs graph-glass border-b p-1" role="tablist" aria-label="Workflow views">
        <For each={MOBILE_TABS}>
          {(tab) => (
            <button
              role="tab"
              id={`graph-tab-${tab}`}
              aria-controls={`graph-panel-${tab}`}
              aria-selected={local.mobileTab === tab}
              tabIndex={local.mobileTab === tab ? 0 : -1}
              class="min-h-11 flex-1 rounded-md px-3 capitalize"
              onClick={() => setLocal("mobileTab", tab)}
              onKeyDown={(event) => {
                if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
                event.preventDefault()
                const index = MOBILE_TABS.indexOf(tab)
                if (event.key === "ArrowRight") activateTab(MOBILE_TABS[(index + 1) % MOBILE_TABS.length])
                if (event.key === "ArrowLeft")
                  activateTab(MOBILE_TABS[(index + MOBILE_TABS.length - 1) % MOBILE_TABS.length])
                if (event.key === "Home") activateTab(MOBILE_TABS[0])
                if (event.key === "End") activateTab(MOBILE_TABS[MOBILE_TABS.length - 1])
              }}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          )}
        </For>
      </div>

      <div class="graph-grid min-h-0 flex-1">
        <aside
          id="graph-panel-tasks"
          role="tabpanel"
          aria-labelledby="graph-tab-tasks"
          class="graph-rail graph-glass min-h-0 overflow-y-auto border-r"
          classList={{ "graph-mobile-hidden": local.mobileTab !== "tasks" }}
          aria-label={COCKPIT_REGIONS[0]}
        >
          <div class="sticky top-0 z-10 border-b border-border-weak-base bg-[var(--graph-glass-solid)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-text-weak">
            Tasks by module
          </div>
          <For each={props.workflow.modules}>
            {(module) => (
              <section class="border-b border-border-weak-base px-2 py-3">
                <div class="mb-2 flex items-center justify-between px-2">
                  <h2 class="text-sm font-semibold">{module.name}</h2>
                  <span class="text-xs text-text-weak">
                    {module.progress.verified}/{module.progress.total}
                  </span>
                </div>
                <For each={module.tasks}>
                  {(task) => (
                    <div class="flex items-stretch">
                      <button
                        class="graph-task mb-1 flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left"
                        classList={{ current: task.current, selected: task.id === selectedID() }}
                        aria-current={task.current ? "step" : undefined}
                        onClick={() => props.onSelectNode(task.id)}
                      >
                        <span aria-hidden="true" class="mt-0.5 w-5 text-center">
                          {task.current
                            ? "→"
                            : task.status === "verified"
                              ? "✓"
                              : task.testStatus === "failed"
                                ? "!"
                                : "○"}
                        </span>
                        <span class="min-w-0">
                          <span class="block truncate text-sm font-medium">{task.name}</span>
                          <span class="text-xs text-text-weak">
                            {task.current ? "Current · " : ""}
                            {task.status}
                          </span>
                        </span>
                      </button>
                      <button
                        class="graph-locate min-h-11 px-2 text-xs text-text-weak"
                        aria-label={`Locate ${task.name} in graph`}
                        onClick={() => {
                          setLocal("centerNodeID", task.id)
                          setLocal("mobileTab", "graph")
                          props.onSelectNode(task.id)
                        }}
                      >
                        Locate
                      </button>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </aside>

        <main
          id="graph-panel-graph"
          role="tabpanel"
          aria-labelledby="graph-tab-graph"
          class="graph-stage min-h-0"
          classList={{ "graph-mobile-hidden": local.mobileTab !== "graph" }}
          aria-label={COCKPIT_REGIONS[1]}
        >
          <GraphCanvas
            graphID={`workflow-${props.workflow.revision}`}
            data={canvas()}
            selectedNodeID={selectedID()}
            currentNodeID={props.workflow.currentTask?.id ?? null}
            onSelectNode={(id) => props.onSelectNode(id ?? props.workflow.currentTask?.id ?? null)}
            centerNodeID={local.centerNodeID}
          />
        </main>

        <aside
          id="graph-panel-details"
          role="tabpanel"
          aria-labelledby="graph-tab-details"
          class="graph-inspector graph-glass min-h-0 overflow-y-auto border-l"
          classList={{ "graph-mobile-hidden": local.mobileTab !== "details" }}
          aria-label={COCKPIT_REGIONS[2]}
        >
          <Show
            when={node()}
            fallback={<div class="p-6 text-sm text-text-weak">Select a graph node to inspect its details.</div>}
          >
            {(selectedNode) => (
              <div class="flex min-h-full flex-col">
                <div class="flex-1 space-y-5 p-5">
                  <div>
                    <div class="text-xs uppercase tracking-[0.14em] text-text-weak">
                      {selectedTask()?.moduleName ?? selectedNode().type}
                    </div>
                    <h2 class="mt-1 text-lg font-semibold">{selectedNode().name}</h2>
                    <div class="mt-2 inline-flex rounded-full border border-border-weak-base px-2 py-0.5 text-xs">
                      {selectedTask()?.current ? "Current · " : ""}
                      {selectedNode().status}
                    </div>
                  </div>
                  <InspectorSection title="Objective">
                    <p>{node()?.desc ?? contentText(node()?.content) ?? "No objective recorded."}</p>
                  </InspectorSection>
                  <InspectorSection title="Dependencies">
                    <Show when={dependencies().length} fallback={<p>None</p>}>
                      <ul class="space-y-1">
                        <For each={dependencies()}>{(item) => <li>↳ {item}</li>}</For>
                      </ul>
                    </Show>
                  </InspectorSection>
                  <InspectorSection title="Verification criteria">
                    <Show when={selectedTask()?.verification?.criteria.length} fallback={<p>Project checks only</p>}>
                      <ul class="space-y-1">
                        <For each={selectedTask()?.verification?.criteria}>{(criterion) => <li>□ {criterion}</li>}</For>
                      </ul>
                    </Show>
                  </InspectorSection>
                  <InspectorSection title="Latest evidence">
                    <Show when={evidence()} fallback={<p>No verification evidence yet.</p>}>
                      {(item) => (
                        <div>
                          <p>{item().passed ? "Passed" : "Failed"}</p>
                          <For each={item().commands?.slice(0, 4)}>
                            {(command) => (
                              <p>
                                {command.passed ? "✓" : "!"} {command.name}
                                {command.excerpt ? ` · ${command.excerpt}` : ""}
                              </p>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                  </InspectorSection>
                  <InspectorSection title="Changed artifacts">
                    <Show when={evidence()?.artifactPaths?.length} fallback={<p>No changed artifacts recorded.</p>}>
                      <ul>
                        <For each={evidence()?.artifactPaths}>
                          {(path) => <li class="break-all font-mono text-xs">{path}</li>}
                        </For>
                      </ul>
                    </Show>
                  </InspectorSection>
                  <Show when={selectedTask()?.testStatus === "failed"}>
                    <InspectorSection title="Failure reason">
                      <p>
                        Task verification failed. Review the bounded evidence or return to the session for full output.
                      </p>
                    </InspectorSection>
                  </Show>
                  <InspectorSection title="Next action">
                    <p>
                      {actions().continue
                        ? "Review the checkpoint and Continue to authorize the next scope."
                        : selectedTask()?.current
                          ? "Complete the current task and run its verification criteria."
                          : "Return to the current task or inspect this dependency."}
                    </p>
                  </InspectorSection>
                </div>
                <footer class="graph-glass sticky bottom-0 flex gap-2 border-t p-3">
                  <Show when={selectedID() !== props.workflow.currentTask?.id}>
                    <button
                      class="graph-action secondary flex-1"
                      onClick={() => props.onSelectNode(props.workflow.currentTask?.id ?? null)}
                    >
                      Return to current
                    </button>
                  </Show>
                  <Show when={actions().continue}>
                    <button
                      class="graph-action primary flex-1"
                      disabled={actions().continuePending}
                      onClick={props.onContinue}
                    >
                      Continue
                    </button>
                  </Show>
                </footer>
              </div>
            )}
          </Show>
        </aside>
      </div>
      <div class="sr-only" aria-live="polite">
        {workflowAnnouncement(props.workflow)}
      </div>
    </section>
  )
}

function InspectorSection(props: { title: string; children: JSX.Element }) {
  return (
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-text-weak">{props.title}</h3>
      <div class="text-sm leading-6 text-text-base">{props.children}</div>
    </section>
  )
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined
  if ("description" in value && typeof value.description === "string") return value.description
  if ("goal" in value && typeof value.goal === "string") return value.goal
  return undefined
}

function stateLabel(state: ReturnType<typeof cockpitViewState>, reason?: string | null) {
  if (state === "mode-required")
    return "Execution mode required. Select Atomic, Module, or Autopilot before changes begin."
  if (state === "checkpoint")
    return `Checkpoint waiting${reason ? `: ${reason}` : ". Review the scope before continuing."}`
  if (state === "paused") return `Workflow paused${reason ? `: ${reason}` : ". Continue when ready."}`
  if (state === "failed") return `Workflow failed${reason ? `: ${reason}` : ". Review evidence and the next action."}`
  if (state === "complete") return "Workflow complete. All durable tasks are verified."
  return "Workflow status updated."
}
