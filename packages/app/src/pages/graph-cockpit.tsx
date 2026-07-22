import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { GraphCanvas } from "./graph-canvas"
import { canPublishToMain, type GraphView } from "./graph-helpers"

export const COCKPIT_REGIONS = ["Task rail", "Workflow graph", "Task details"] as const
export const MOBILE_TABS = ["tasks", "graph", "details"] as const

export function cockpitActions(
  workflow: {
    mode?: string | null
    phase: string
    activeOperationKind?: string | null
    checkpoint: { status: string; kind?: string | null }
  },
  pending?: "mode" | "continue" | "pause",
) {
  const checkpoint = workflow.checkpoint.status === "pending"
  const terminal = workflow.phase === "complete" || workflow.phase === "failed"
  return {
    continue: !!workflow.mode && checkpoint && !terminal,
    pause: !!workflow.mode && !checkpoint && !terminal,
    mode: !terminal && !workflow.activeOperationKind,
    continuePending: pending === "continue",
    pausePending: pending === "pause",
  }
}

type MinimalWorkflow = {
  mode?: string | null
  phase: string
  activeOperationKind?: string | null
  tasks: readonly unknown[]
  checkpoint: { status: string; kind?: string | null }
}

export function cockpitViewState(input: {
  loading?: boolean
  disconnected?: boolean
  error?: boolean
  conflict?: boolean
  mainNodeCount?: number
  workflow?: MinimalWorkflow
}) {
  if (input.loading) return "loading"
  if (input.disconnected) return "disconnected"
  if (input.conflict) return "conflict"
  if (input.error) return "error"
  if ((input.mainNodeCount ?? 0) > 0) return "ready"
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

export function workflowPhaseStep(phase: string) {
  if (phase === "planning") return "Plan"
  if (phase === "building") return "Build"
  return "Verify"
}

export function rollupWorkflowStatus(tasks: ReadonlyArray<{ status: string; testStatus: string }>) {
  if (tasks.some((task) => task.testStatus === "failed")) return "failed"
  if (tasks.length > 0 && tasks.every((task) => task.status === "verified")) return "verified"
  if (tasks.some((task) => task.status !== "pending" || task.testStatus !== "none")) return "implemented"
  return "pending"
}

export function cockpitGraphID(input: {
  source: "currentPlan" | "main"
  planSource: "currentPlan" | "version"
  versionNumber?: number | null
  revision: number
}) {
  if (input.source === "main") return "main"
  return `${input.source}-${input.planSource}-${input.planSource === "version" ? input.versionNumber : input.revision}`
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
  activeOperationKind?: "artifact_apply" | null
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

export function enrichWorkflowNodes(input: {
  graph: GraphView
  workflow: Pick<CockpitWorkflow, "currentTask" | "checkpoint" | "tasks" | "modules">
  selectedNodeID: string | null
}) {
  return input.graph.nodes.map((item) => {
    const task = input.workflow.tasks.find((candidate) => candidate.id === item.id)
    const module = input.workflow.modules.find((candidate) => candidate.id === item.id)
    const blockers = input.graph.edges.filter(
      (edge) =>
        edge.targetID === item.id &&
        edge.relation === "blocks" &&
        input.graph.nodes.find((node) => node.id === edge.sourceID)?.status !== "verified",
    )
    const status =
      task?.status ??
      module?.status ??
      (module
        ? rollupWorkflowStatus(module.tasks)
        : item.type === "prd"
          ? rollupWorkflowStatus(input.workflow.tasks)
          : item.status)
    const testStatus =
      task?.testStatus ?? (status === "failed" ? "failed" : status === "verified" ? "passed" : item.testStatus)
    const scopedTasks = module?.tasks ?? (item.type === "prd" ? input.workflow.tasks : [])
    const buildable =
      task?.buildable ??
      (scopedTasks.length ? scopedTasks.some((candidate) => candidate.buildable) : blockers.length === 0)
    const current = task?.current ?? input.workflow.currentTask?.id === item.id
    const selected = input.selectedNodeID === item.id
    const failed = testStatus === "failed"
    const verified = status === "verified"
    const checkpoint =
      input.workflow.checkpoint.scopeNodeID === item.id && input.workflow.checkpoint.status === "pending"
    const blocked = !buildable
    const state = failed
      ? "failed"
      : verified
        ? "verified"
        : checkpoint
          ? "checkpoint"
          : blocked
            ? "blocked"
            : current
              ? "current"
              : selected
                ? "selected"
                : "pending"
    return {
      ...item,
      status,
      testStatus,
      buildable,
      blockerCount: blockers.length,
      current,
      selected,
      failed,
      verified,
      checkpoint,
      blocked,
      state,
      label:
        [
          current ? "Current" : undefined,
          selected ? "Selected" : undefined,
          failed ? "Failed" : undefined,
          verified ? "Verified" : undefined,
          checkpoint ? "Checkpoint" : undefined,
          blocked ? "Blocked" : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || "Pending",
    }
  })
}

export function GraphCockpit(props: {
  source?: "currentPlan" | "main"
  planSource?: "currentPlan" | "version"
  planVersion?: number | null
  workflow: CockpitWorkflow
  graph: GraphView
  selectedNodeID: string | null
  onSelectNode: (id: string | null) => void
  onContinue?: () => void
  onPause?: () => void
  onModeChange?: (mode: "atomic" | "module" | "autopilot") => void
  onBackToSession?: () => void
  onViewChanges?: () => void
  onCenterNode?: (id: string) => void
  onCenterRequest?: (id: string, token: number) => void
  onPublish?: () => void
  projectName?: string
  sessionTitle?: string
  actionError?: string
  actionStatus?: string
  pendingAction?: "mode" | "continue" | "pause"
  publishPending?: boolean
}) {
  const [local, setLocal] = createStore({
    mobileTab: "tasks" as "tasks" | "graph" | "details",
    centerNodeID: null as string | null,
    centerRequestToken: 0,
  })
  const isPlan = () => props.source !== "main"
  const isLivePlan = () => isPlan() && props.planSource !== "version"
  const tasks = () =>
    isPlan()
      ? props.workflow.tasks
      : props.graph.nodes.map(
          (item): Task => ({
            id: item.id,
            name: item.name,
            moduleID: null,
            moduleName: item.type,
            status: item.status,
            testStatus: item.testStatus,
            current: false,
            buildable: item.status !== "deprecated",
            verification: null,
            latestEvidence: null,
          }),
        )
  const modules = () => {
    if (isPlan()) return props.workflow.modules
    const items = tasks()
    return [
      {
        id: null,
        name: "Main graph",
        progress: { verified: items.filter((item) => item.status === "verified").length, total: items.length },
        tasks: items,
      },
    ]
  }
  const model = () =>
    isPlan()
      ? props.workflow
      : {
          ...props.workflow,
          currentTask: null,
          checkpoint: { status: "none", kind: null, reason: null, scopeNodeID: null },
          tasks: tasks(),
          modules: modules(),
        }
  const selectedTask = () =>
    tasks().find((task) => task.id === props.selectedNodeID) ??
    (isPlan() ? tasks().find((task) => task.id === props.workflow.currentTask?.id) : undefined)
  const selectedID = () =>
    props.selectedNodeID ?? (isPlan() ? props.workflow.currentTask?.id : undefined) ?? props.graph.nodes[0]?.id ?? null
  const node = () => props.graph.nodes.find((item) => item.id === selectedID())
  const dependencies = () =>
    props.graph.edges
      .filter((edge) => edge.targetID === selectedID() && edge.relation === "blocks")
      .map((edge) => props.graph.nodes.find((item) => item.id === edge.sourceID)?.name)
      .filter((name): name is string => !!name)
  const evidence = () => selectedTask()?.latestEvidence
  const actions = () =>
    isLivePlan()
      ? cockpitActions(props.workflow, props.pendingAction)
      : { continue: false, pause: false, mode: false, continuePending: false, pausePending: false }
  const canPublish = () =>
    isPlan() &&
    canPublishToMain({
      phase: props.workflow.phase,
      planSource: props.planSource ?? "currentPlan",
      nodeCount: props.graph.nodes.length,
    })
  const state = () => cockpitViewState({ workflow: props.workflow })
  const nodes = () => enrichWorkflowNodes({ graph: props.graph, workflow: model(), selectedNodeID: selectedID() })
  const canvas = () => ({ ...props.graph, nodes: nodes() })
  const nodeState = (id: string) => nodes().find((item) => item.id === id)
  let centerRequestToken = 0
  const requestCenter = (id: string, reveal: boolean) => {
    const token = ++centerRequestToken
    setLocal({
      centerNodeID: id,
      centerRequestToken: token,
      mobileTab: reveal ? "graph" : local.mobileTab,
    })
    props.onCenterRequest?.(id, token)
  }
  const activateTab = (tab: (typeof MOBILE_TABS)[number]) => {
    setLocal("mobileTab", tab)
    document.getElementById(`graph-tab-${tab}`)?.focus()
  }

  return (
    <section class="graph-cockpit flex h-full min-h-0 flex-col text-text-strong" aria-label="Graph workflow cockpit">
      <header
        class="graph-glass flex min-h-16 flex-wrap items-center gap-3 border-b px-4 py-2"
        style={{ "padding-right": "9rem" }}
      >
        <button class="graph-action secondary" aria-label="Back to session" onClick={props.onBackToSession}>
          ← Session
        </button>
        <div class="mr-auto min-w-48">
          <div class="text-xs font-medium uppercase tracking-[0.16em] text-text-weak">
            {isPlan()
              ? props.planSource === "version"
                ? `Published version ${props.planVersion} · read-only`
                : "Current Plan workflow"
              : "Main graph · read-only"}
          </div>
          <div class="font-semibold">
            {isPlan() ? (props.workflow.currentTask?.name ?? "No current task") : "Released project topology"}
          </div>
          <div class="text-xs text-text-weak">
            {[props.projectName, props.sessionTitle].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Show when={isLivePlan()}>
          <div class="rounded-full border border-border-weak-base px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em]">
            {workflowPhaseStep(props.workflow.phase)} phase
          </div>
        </Show>
        <Show when={isLivePlan()}>
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
        </Show>
        <Show
          when={isLivePlan() && !actions().mode && props.workflow.phase !== "complete" && props.workflow.phase !== "failed"}
        >
          <span class="max-w-40 text-xs text-text-weak">
            Pause or wait for active workflow changes before changing execution mode.
          </span>
        </Show>
        <Show when={isPlan()}>
          <div
            class="min-w-36"
            role="progressbar"
            aria-label="Workflow verification progress"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={props.workflow.progress.percent}
          >
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
        </Show>
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
        <Show when={canPublish()}>
          <button class="graph-action primary" disabled={props.publishPending} onClick={props.onPublish}>
            Publish to Main
          </button>
        </Show>
      </header>

      <Show when={props.actionError}>
        <div class="graph-state-strip graph-glass border-b px-4 py-2 text-sm text-icon-critical-base" role="alert">
          {props.actionError}
        </div>
      </Show>

      <Show when={props.actionStatus}>
        <div class="graph-state-strip graph-glass border-b px-4 py-2 text-sm" role="status">
          {props.actionStatus}
        </div>
      </Show>

      <Show when={isPlan() && state() !== "ready"}>
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
            {isPlan() ? "Tasks by module" : "Main graph nodes"}
          </div>
          <For each={modules()}>
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
                        classList={{ current: !!nodeState(task.id)?.current, selected: !!nodeState(task.id)?.selected }}
                        aria-current={task.current ? "step" : undefined}
                        onClick={() => {
                          props.onSelectNode(task.id)
                          if (!window.matchMedia("(max-width: 767px)").matches) requestCenter(task.id, false)
                        }}
                      >
                        <span aria-hidden="true" class="mt-0.5 w-5 text-center">
                          {nodeState(task.id)?.failed
                            ? "!"
                            : nodeState(task.id)?.verified
                              ? "✓"
                              : nodeState(task.id)?.current
                                ? "→"
                                : nodeState(task.id)?.blocked
                                  ? "×"
                                  : "○"}
                        </span>
                        <span class="min-w-0">
                          <span class="block truncate text-sm font-medium">{task.name}</span>
                          <span class="text-xs text-text-weak">{nodeState(task.id)?.label}</span>
                        </span>
                      </button>
                      <button
                        class="graph-locate min-h-11 px-2 text-xs text-text-weak"
                        aria-label={`Locate ${task.name} in graph`}
                        onClick={() => {
                          requestCenter(task.id, true)
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
            graphID={cockpitGraphID({
              source: props.source ?? "currentPlan",
              planSource: props.planSource ?? "currentPlan",
              versionNumber: props.planVersion,
              revision: props.workflow.revision,
            })}
            data={canvas()}
            selectedNodeID={selectedID()}
            currentNodeID={isPlan() ? (props.workflow.currentTask?.id ?? null) : null}
            onSelectNode={(id) => props.onSelectNode(id ?? (isPlan() ? props.workflow.currentTask?.id : null) ?? null)}
            centerNodeID={local.centerNodeID}
            centerRequestToken={local.centerRequestToken}
            onCenterNode={props.onCenterNode}
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
                      {nodeState(selectedNode().id)?.label ?? selectedNode().status}
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
                      {props.planSource === "version"
                        ? `Published version ${props.planVersion} is read-only.`
                        : isPlan() && actions().continue
                        ? "Review the checkpoint and Continue to authorize the next scope."
                        : isPlan() && selectedTask()?.current
                          ? "Complete the current task and run its verification criteria."
                          : "Return to the current task or inspect this dependency."}
                    </p>
                  </InspectorSection>
                </div>
                <footer class="graph-glass sticky bottom-0 flex gap-2 border-t p-3">
                  <button
                    class="graph-action secondary flex-1"
                    aria-label={`View changes for ${selectedTask()?.name ?? selectedNode().name}`}
                    onClick={props.onViewChanges}
                  >
                    View Changes
                  </button>
                  <Show when={isPlan() && selectedID() !== props.workflow.currentTask?.id}>
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
                  <Show when={actions().pause}>
                    <button
                      class="graph-action secondary flex-1"
                      disabled={actions().pausePending}
                      onClick={props.onPause}
                    >
                      Pause
                    </button>
                  </Show>
                </footer>
              </div>
            )}
          </Show>
        </aside>
      </div>
      <div class="sr-only" aria-live="polite">
        {isPlan() ? workflowAnnouncement(props.workflow) : `Main graph. ${props.graph.nodes.length} visible nodes.`}
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
