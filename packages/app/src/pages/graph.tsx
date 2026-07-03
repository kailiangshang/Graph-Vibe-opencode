import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { Spinner } from "@opencode-ai/ui/spinner"

interface GraphNode {
  id: string
  name: string
  type: string
  level: string
  status: string
  testStatus: string
  priority: string | null
  sessionID: string | null
}

interface GraphView {
  nodes: GraphNode[]
  edges: Array<{ id: string; sourceID: string; targetID: string; relation: string }>
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#ffc107",
  implemented: "#4caf50",
  verified: "#2196f3",
  deprecated: "#757575",
}

export default function GraphPage() {
  const params = useParams()
  const sdk = useSDK()
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)

  const currentPlanQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", "currentPlan"] as const,
    queryFn: async () => {
      const res = await sdk().client.graph.currentPlan({
        session: params.id!,
        directory: params.dir,
      })
      return res.data as GraphView
    },
  }))

  const nodeReadinessQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", "readiness", selectedNodeID()] as const,
    enabled: selectedNodeID() !== null,
    queryFn: async () => {
      const res = await sdk().client.graph.nodeReadiness({
        nodeID: selectedNodeID()!,
        session: params.id!,
        directory: params.dir,
      })
      return res.data as {
        inCurrentPlan: boolean
        status: string
        blockers: Array<{ nodeID: string; nodeName: string; nodeStatus: string }>
        validationIssues: Array<{ rule: string; message: string }>
      }
    },
  }))

  const statusCounts = createMemo(() => {
    const nodes = currentPlanQuery.data?.nodes ?? []
    const counts: Record<string, number> = {}
    for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
    return counts
  })

  return (
    <div class="flex h-full flex-col">
      <div class="border-b p-4">
        <h1 class="text-lg font-semibold">Current Plan</h1>
        <Show when={!currentPlanQuery.isLoading} fallback={<Spinner />}>
          <div class="mt-1 flex gap-4 text-sm text-muted-foreground">
            <span>{currentPlanQuery.data?.nodes.length ?? 0} nodes</span>
            <span>{currentPlanQuery.data?.edges.length ?? 0} edges</span>
            <For each={Object.entries(statusCounts())}>
              {([status, count]) => (
                <span style={{ color: STATUS_COLORS[status] ?? "#999" }}>
                  {status}: {count}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <div class="w-2/3 overflow-auto border-r">
          <Show
            when={(currentPlanQuery.data?.nodes ?? []).length > 0}
            fallback={
              <div class="p-8 text-center text-muted-foreground">
                No CurrentPlan nodes. Use the graph_plan_admit tool to create a plan.
              </div>
            }
          >
            <div class="divide-y">
              <For each={currentPlanQuery.data?.nodes}>
                {(node) => (
                  <button
                    class="flex w-full items-center gap-3 p-3 text-left hover:bg-accent"
                    classList={{ "bg-accent": selectedNodeID() === node.id }}
                    onClick={() => setSelectedNodeID(node.id)}
                  >
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: STATUS_COLORS[node.status] ?? "#999" }}
                    />
                    <span class="flex-1 truncate font-medium">{node.name}</span>
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{node.type}</span>
                    <span class="text-xs text-muted-foreground">{node.level}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={selectedNodeID()}>
          <div class="w-1/3 overflow-auto p-4">
            <Show when={!nodeReadinessQuery.isLoading} fallback={<Spinner />}>
              <h2 class="mb-2 font-semibold">
                {currentPlanQuery.data?.nodes.find((n) => n.id === selectedNodeID())?.name}
              </h2>

              <Show when={nodeReadinessQuery.data}>
                <div class="mb-3 text-sm">
                  <div>In CurrentPlan: {nodeReadinessQuery.data!.inCurrentPlan ? "Yes" : "No"}</div>
                  <div>Status: {nodeReadinessQuery.data!.status}</div>
                </div>

                <Show when={(nodeReadinessQuery.data?.blockers ?? []).length > 0}>
                  <h3 class="mb-1 font-medium">Blockers</h3>
                  <ul class="mb-4 space-y-1 text-sm">
                    <For each={nodeReadinessQuery.data?.blockers}>
                      {(blocker) => (
                        <li>
                          {blocker.nodeName} ({blocker.nodeStatus})
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>

                <Show when={(nodeReadinessQuery.data?.validationIssues ?? []).length > 0}>
                  <h3 class="mb-1 font-medium">Validation Issues</h3>
                  <ul class="space-y-1 text-sm">
                    <For each={nodeReadinessQuery.data?.validationIssues}>
                      {(issue) => (
                        <li>
                          {issue.rule}: {issue.message}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
