import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query"
import { Show, createEffect, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Button } from "@opencode-ai/ui/button"
import { GraphCockpit, cockpitViewState } from "./graph-cockpit"
import {
  CURRENT_PLAN_EMPTY_MESSAGE,
  type GraphView,
  normalizeWorkflow,
  reconcileSelection,
  prefersReducedTransparency,
  workflowMutationFailure,
} from "./graph-helpers"
import { useSessionLayout } from "./session/session-layout"

export default function GraphPage() {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const sessionLayout = useSessionLayout()
  const queryClient = useQueryClient()
  const [state, setState] = createStore({
    selectedNodeID: null as string | null,
    source: "currentPlan" as "currentPlan" | "main",
    conflict: "" as string,
    actionError: "" as string,
  })
  const directory = () => sdk().directory
  const queryKey = () => [directory(), params.id, "graph"] as const

  onMount(() => {
    const stop = sdk().event.listen((event: { details: { type: string } }) => {
      if (
        ["message.updated", "session.updated", "graph.plan.updated", "graph.main.updated"].includes(event.details.type)
      )
        void queryClient.invalidateQueries({ queryKey: queryKey() })
    })
    onCleanup(stop)
  })

  const graphQuery = createQuery(() => ({
    queryKey: [...queryKey(), state.source] as const,
    queryFn: async () => {
      const response =
        state.source === "main"
          ? await sdk().client.graph.main({ directory: directory() })
          : await sdk().client.graph.currentPlan({ session: params.id!, directory: directory() })
      if (response.error || !response.data) throw new Error("Unable to load the graph")
      return response.data as GraphView
    },
  }))

  const workflowQuery = createQuery(() => ({
    queryKey: [...queryKey(), "workflow"] as const,
    queryFn: async () => {
      const response = await sdk().client.graph.workflow({ session: params.id!, directory: directory() })
      if (response.error || !response.data) throw new Error("Unable to load workflow state")
      return normalizeWorkflow(response.data)
    },
  }))

  createEffect(() => {
    const workflow = workflowQuery.data
    const graph = graphQuery.data
    if (!workflow || !graph) return
    setState("selectedNodeID", reconcileSelection(state.selectedNodeID, graph.nodes, workflow.currentTask?.id))
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKey() })
  }

  const mutationError = async (action: "mode" | "continue" | "pause", error: unknown) => {
    const failure = workflowMutationFailure(action, error)
    setState("actionError", failure.refresh ? "" : failure.message)
    setState("conflict", failure.refresh ? failure.message : "")
    if (failure.refresh) await refresh()
  }

  const modeMutation = createMutation(() => ({
    mutationFn: async (mode: "atomic" | "module" | "autopilot") => {
      const workflow = workflowQuery.data
      if (!workflow) throw new Error("Workflow is not loaded")
      const response = await sdk().client.graph.workflowMode({
        session: params.id!,
        directory: directory(),
        graphWorkflowModePayload: { mode, expectedRevision: workflow.revision },
      })
      if (response.error || !response.data) throw response.error ?? { _tag: "UnexpectedWorkflowResponse" }
    },
    onSuccess: async () => {
      setState("conflict", "")
      setState("actionError", "")
      await refresh()
    },
    onError: (error) => mutationError("mode", error),
  }))

  const continueMutation = createMutation(() => ({
    mutationFn: async () => {
      const workflow = workflowQuery.data
      if (!workflow) throw new Error("Workflow is not loaded")
      const response = await sdk().client.graph.workflowApprove({
        session: params.id!,
        directory: directory(),
        graphWorkflowApprovePayload: { expectedRevision: workflow.revision },
      })
      if (response.error || !response.data) throw response.error ?? { _tag: "UnexpectedWorkflowResponse" }
    },
    onSuccess: async () => {
      setState("conflict", "")
      setState("actionError", "")
      await refresh()
    },
    onError: (error) => mutationError("continue", error),
  }))

  const pauseMutation = createMutation(() => ({
    mutationFn: async () => {
      const workflow = workflowQuery.data
      if (!workflow) throw new Error("Workflow is not loaded")
      const response = await sdk().client.graph.workflowPause({
        session: params.id!,
        directory: directory(),
        graphWorkflowPausePayload: { expectedRevision: workflow.revision },
      })
      if (response.error || !response.data) throw response.error ?? { _tag: "UnexpectedWorkflowResponse" }
    },
    onSuccess: async () => {
      setState("conflict", "")
      setState("actionError", "")
      await refresh()
    },
    onError: (error) => mutationError("pause", error),
  }))

  const viewState = () => {
    if (graphQuery.isLoading || workflowQuery.isLoading) return "loading"
    return cockpitViewState({
      disconnected: graphQuery.isPaused || workflowQuery.isPaused,
      error: graphQuery.isError || workflowQuery.isError,
      conflict: !!state.conflict,
      workflow: workflowQuery.data,
    })
  }

  return (
    <div
      class="graph-page h-full min-h-0 bg-background-base"
      data-reduced-transparency={
        typeof window !== "undefined" ? prefersReducedTransparency(window.matchMedia.bind(window)) : false
      }
    >
      <Show when={viewState() === "loading"}>
        <GraphState title="Calibrating workflow" detail="Loading tasks, authority, and verification evidence.">
          <Spinner />
        </GraphState>
      </Show>
      <Show when={viewState() === "disconnected"}>
        <GraphState
          title="Connection interrupted"
          detail="The durable workflow remains safe. Reconnect to refresh its current revision."
        />
      </Show>
      <Show when={viewState() === "error"}>
        <GraphState title="Workflow unavailable" detail="Graph state could not be loaded. Check access and retry.">
          <button class="graph-action primary" onClick={refresh}>
            Retry
          </button>
        </GraphState>
      </Show>
      <Show when={viewState() === "conflict"}>
        <GraphState title="Workflow changed" detail={state.conflict}>
          <button class="graph-action primary" onClick={() => setState("conflict", "")}>
            Review refreshed status
          </button>
        </GraphState>
      </Show>
      <Show when={viewState() === "empty"}>
        <GraphState title="No plan admitted" detail={CURRENT_PLAN_EMPTY_MESSAGE}>
          <Button
            variant="primary"
            size="large"
            class="graph-action primary"
            onClick={() => navigate(location.pathname.replace(/\/graph\/?$/, ""))}
          >
            Describe a goal
          </Button>
        </GraphState>
      </Show>
      <Show
        when={
          !["loading", "disconnected", "error", "conflict", "empty"].includes(viewState())
            ? workflowQuery.data
            : undefined
        }
      >
        {(ready) => (
          <div class="flex h-full min-h-0 flex-col">
            <div class="graph-source-switch absolute right-4 top-2 z-20 flex rounded-md border border-border-weak-base bg-background-base/90 p-0.5">
              <button
                class="min-h-11 rounded px-3 text-xs"
                classList={{ "bg-surface-raised-base": state.source === "currentPlan" }}
                aria-pressed={state.source === "currentPlan"}
                onClick={() => setState("source", "currentPlan")}
              >
                Plan
              </button>
              <button
                class="min-h-11 rounded px-3 text-xs"
                classList={{ "bg-surface-raised-base": state.source === "main" }}
                aria-pressed={state.source === "main"}
                onClick={() => setState("source", "main")}
              >
                Main
              </button>
            </div>
            <GraphCockpit
              source={state.source}
              workflow={ready()}
              graph={graphQuery.data!}
              selectedNodeID={state.selectedNodeID}
              onSelectNode={(id) => setState("selectedNodeID", id)}
              onModeChange={(mode) => modeMutation.mutate(mode)}
              onContinue={() => continueMutation.mutate()}
              onPause={() => pauseMutation.mutate()}
              projectName={sync().project?.name ?? sync().project?.worktree}
              sessionTitle={params.id ? sync().session.get(params.id)?.title : undefined}
              actionError={state.actionError}
              onBackToSession={() => navigate(location.pathname.replace(/\/graph\/?$/, ""))}
              onViewChanges={() => {
                sessionLayout.view().reviewPanel.open("other")
                navigate(location.pathname.replace(/\/graph\/?$/, ""))
              }}
              pendingAction={
                modeMutation.isPending
                  ? "mode"
                  : continueMutation.isPending
                    ? "continue"
                    : pauseMutation.isPending
                      ? "pause"
                      : undefined
              }
            />
          </div>
        )}
      </Show>
    </div>
  )
}

function GraphState(props: { title: string; detail: string; children?: JSX.Element }) {
  return (
    <div class="flex h-full items-center justify-center p-6" role="status">
      <div class="graph-glass max-w-md rounded-2xl border p-8 text-center shadow-lg">
        <div class="mx-auto mb-4 h-px w-16 bg-[var(--graph-current)]" />
        <h1 class="text-lg font-semibold">{props.title}</h1>
        <p class="mt-2 text-sm leading-6 text-text-weak">{props.detail}</p>
        <Show when={props.children}>
          <div class="mt-5 flex justify-center">{props.children}</div>
        </Show>
      </div>
    </div>
  )
}
