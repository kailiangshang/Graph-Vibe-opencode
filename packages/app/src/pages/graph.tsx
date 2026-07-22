import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query"
import { Show, createEffect, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@/utils/toast"
import { GraphCockpit, cockpitViewState } from "./graph-cockpit"
import {
  CURRENT_PLAN_EMPTY_MESSAGE,
  type GraphView,
  type PublicationScope,
  canPublishToMain,
  normalizeWorkflow,
  reconcileSelection,
  prefersReducedTransparency,
  publicationScope,
  workflowMutationFailure,
  samePublicationScope,
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
  const dialog = useDialog()
  const [state, setState] = createStore({
    selectedNodeID: null as string | null,
    source: "currentPlan" as "currentPlan" | "main",
    conflict: "" as string,
    actionError: "" as string,
    publicationStatus: "" as string,
    publishPending: false,
  })
  const directory = () => sdk().directory
  const queryKey = () => [directory(), "graph"] as const

  onMount(() => {
    const stop = sdk().event.listen((event: { details: { type: string } }) => {
      if (
        ["message.updated", "session.updated", "graph.plan.updated", "graph.main.updated"].includes(event.details.type)
      )
        void queryClient.invalidateQueries({ queryKey: queryKey() })
    })
    onCleanup(stop)
  })

  const planQuery = createQuery(() => ({
    queryKey: [...queryKey(), "plan", params.id] as const,
    queryFn: async () => {
      const response = await sdk().client.graph.planView({ session: params.id!, directory: directory() })
      if (response.error || !response.data) throw new Error("Unable to load the graph")
      return response.data
    },
  }))

  const mainQuery = createQuery(() => ({
    queryKey: [...queryKey(), "main"] as const,
    queryFn: async () => {
      const response = await sdk().client.graph.main({ directory: directory() })
      if (response.error || !response.data) throw new Error("Unable to load the graph")
      return response.data as GraphView
    },
  }))

  const workflowQuery = createQuery(() => ({
    queryKey: [...queryKey(), "workflow", params.id] as const,
    queryFn: async () => {
      const response = await sdk().client.graph.workflow({ session: params.id!, directory: directory() })
      if (response.error || !response.data) throw new Error("Unable to load workflow state")
      return normalizeWorkflow(response.data)
    },
  }))

  createEffect(() => {
    const workflow = workflowQuery.data
    const graph = state.source === "main" ? mainQuery.data : planQuery.data
    if (!workflow || !graph) return
    setState(
      "selectedNodeID",
      reconcileSelection(state.selectedNodeID, graph.nodes, state.source === "currentPlan" ? workflow.currentTask?.id : null),
    )
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

  const promoteMutation = createMutation(() => ({
    mutationFn: async (scope: PublicationScope) => {
      const response = await sdk().client.graph.promote({
        session: scope.sessionID,
        directory: scope.directory,
        graphPromotePayload: {
          message: `Published from ${scope.sessionTitle}`,
          expectedRevision: scope.revision,
        },
      })
      if (response.error || !response.data) throw response.error ?? { _tag: "UnexpectedPromotionResponse" }
      return response.data
    },
    onSuccess: async (result) => {
      await refresh()
      setState({
        selectedNodeID: null,
        source: "main",
        conflict: "",
        actionError: "",
        publicationStatus: "",
        publishPending: false,
      })
      showToast({
        variant: "success",
        title: `Created version ${result.versionNumber}`,
        description: `Published ${result.nodes} nodes and ${result.edges} edges to Main.`,
      })
    },
    onError: async () => {
      await refresh()
      const plan = planQuery.data
      const published = plan?.source === "version"
      const version = typeof plan?.versionNumber === "number" ? plan.versionNumber : null
      if (published) {
        const mainReady = (mainQuery.data?.nodes.length ?? 0) > 0
        setState({
          selectedNodeID: null,
          source: mainReady ? "main" : "currentPlan",
          conflict: "",
          actionError: "",
          publicationStatus: mainReady ? "" : `Published version ${version} is available. Main is still refreshing.`,
          publishPending: false,
        })
        showToast({
          variant: "success",
          title: `Already published as version ${version}`,
          description: mainReady
            ? "Main was refreshed from the concurrent publication."
            : "The published Plan is read-only; Main has not returned topology yet.",
        })
        return
      }
      setState({
        selectedNodeID: null,
        source: "currentPlan",
        conflict: "",
        actionError: "Publication failed. Authoritative graph state was refreshed; review the Plan and retry.",
        publicationStatus: "",
        publishPending: false,
      })
    },
  }))

  const currentPublicationScope = () => {
    const sessionID = params.id
    const plan = planQuery.data
    const workflow = workflowQuery.data
    if (!sessionID || !plan || !workflow) return
    return publicationScope({
      directory: directory(),
      sessionID,
      pathname: location.pathname,
      revision: workflow.revision,
      planSource: plan.source,
      sessionTitle: sync().session.get(sessionID)?.title ?? sessionID,
      nodes: plan.nodes,
      edges: plan.edges,
    })
  }

  const publish = (scope: PublicationScope) => {
    if (state.publishPending || promoteMutation.isPending) return
    const current = currentPublicationScope()
    if (!current || !samePublicationScope(scope, current)) {
      setState({
        selectedNodeID: null,
        source: "currentPlan",
        actionError: "The Plan changed after review. Authoritative state was refreshed; review publication again.",
        publicationStatus: "",
      })
      void refresh()
      return
    }
    setState("publishPending", true)
    setState("actionError", "")
    setState("publicationStatus", "Publishing the reviewed Plan to Main...")
    promoteMutation.mutate(scope)
  }

  const openPublish = () => {
    const scope = currentPublicationScope()
    if (
      !scope ||
      !canPublishToMain({ phase: workflowQuery.data?.phase ?? "", planSource: scope.planSource, nodeCount: scope.nodeCount })
    )
      return
    void dialog.show(() => (
      <PublishToMainDialog
        nodeCount={scope.nodeCount}
        edgeCount={scope.edgeCount}
        onConfirm={() => publish(scope)}
      />
    ))
  }

  const graph = () => (state.source === "main" ? mainQuery.data : planQuery.data)
  const selectedGraphQuery = () => (state.source === "main" ? mainQuery : planQuery)
  const mainEmpty = () => state.source === "main" && !!mainQuery.data && mainQuery.data.nodes.length === 0
  const publishablePlan = () => {
    const plan = planQuery.data
    const workflow = workflowQuery.data
    return !!(
      plan &&
      workflow &&
      canPublishToMain({ phase: workflow.phase, planSource: plan.source, nodeCount: plan.nodes.length })
    )
  }
  const showSourceSwitch = () => {
    if (workflowQuery.isLoading) return false
    return (
      !!workflowQuery.data &&
      ((planQuery.data?.nodes.length ?? 0) > 0 || workflowQuery.data.tasks.length > 0 || state.source === "main")
    )
  }

  const viewState = () => {
    if (selectedGraphQuery().isLoading || workflowQuery.isLoading) return cockpitViewState({ loading: true })
    if (selectedGraphQuery().isPaused || workflowQuery.isPaused) return cockpitViewState({ disconnected: true })
    if (state.conflict) return cockpitViewState({ conflict: true })
    if (selectedGraphQuery().isError || workflowQuery.isError) return cockpitViewState({ error: true })
    return cockpitViewState({
      mainNodeCount: state.source === "main" ? mainQuery.data?.nodes.length : undefined,
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
      <Show when={showSourceSwitch()}>
        <GraphSourceSwitch source={state.source} onChange={(source) => setState("source", source)} />
      </Show>
      <Show when={mainEmpty() && !["loading", "disconnected", "error", "conflict"].includes(viewState())}>
        <GraphState
          title="No published topology"
          detail={
            publishablePlan()
              ? "The completed Plan is ready to publish as the next project-wide version."
              : "Main appears after a completed Plan is published."
          }
        >
          <Show when={publishablePlan()}>
            <Button
              variant="primary"
              size="large"
              class="graph-action primary"
              onClick={() => setState({ source: "currentPlan", selectedNodeID: null })}
            >
              Return to Plan
            </Button>
          </Show>
        </GraphState>
      </Show>
      <Show
        when={
          !mainEmpty() && !["loading", "disconnected", "error", "conflict", "empty"].includes(viewState())
            ? workflowQuery.data
            : undefined
        }
      >
        {(ready) => (
          <div class="flex h-full min-h-0 flex-col">
            <GraphCockpit
              source={state.source}
              planSource={planQuery.data?.source}
              planVersion={typeof planQuery.data?.versionNumber === "number" ? planQuery.data.versionNumber : null}
              workflow={ready()}
              graph={graph()!}
              selectedNodeID={state.selectedNodeID}
              onSelectNode={(id) => setState("selectedNodeID", id)}
              onModeChange={(mode) => modeMutation.mutate(mode)}
              onContinue={() => continueMutation.mutate()}
              onPause={() => pauseMutation.mutate()}
              onPublish={openPublish}
              publishPending={state.publishPending}
              projectName={sync().project?.name ?? sync().project?.worktree}
              sessionTitle={params.id ? sync().session.get(params.id)?.title : undefined}
              actionError={state.actionError}
              actionStatus={state.publicationStatus}
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

function GraphSourceSwitch(props: {
  source: "currentPlan" | "main"
  onChange: (source: "currentPlan" | "main") => void
}) {
  return (
    <div class="graph-source-switch absolute right-4 top-2 z-20 flex rounded-md border border-border-weak-base bg-background-base/90 p-0.5">
      <button
        class="min-h-11 rounded px-3 text-xs"
        classList={{ "bg-surface-raised-base": props.source === "currentPlan" }}
        aria-pressed={props.source === "currentPlan"}
        onClick={() => props.onChange("currentPlan")}
      >
        Plan
      </button>
      <button
        class="min-h-11 rounded px-3 text-xs"
        classList={{ "bg-surface-raised-base": props.source === "main" }}
        aria-pressed={props.source === "main"}
        onClick={() => props.onChange("main")}
      >
        Main
      </button>
    </div>
  )
}

function PublishToMainDialog(props: {
  nodeCount: number
  edgeCount: number
  onConfirm: () => void
}) {
  const dialog = useDialog()
  return (
    <Dialog
      title="Publish to Main"
      description={
        <span class="flex flex-col gap-2">
          <span class="text-14-regular text-text-strong">
            This will publish {props.nodeCount} nodes and {props.edgeCount} edges as a project-wide versioned publication.
          </span>
          <span class="text-12-regular text-text-weak">
            Main will update from the authoritative published graph and this Plan will remain available as a read-only version.
          </span>
        </span>
      }
      fit
    >
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              props.onConfirm()
            }}
          >
            Publish to Main
          </Button>
        </div>
      </div>
    </Dialog>
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
