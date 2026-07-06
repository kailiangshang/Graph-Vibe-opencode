import { createQuery } from "@tanstack/solid-query"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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

interface GraphEdge {
  id: string
  sourceID: string
  targetID: string
  relation: string
}

interface GraphView {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#ffc107",
  implemented: "#4caf50",
  verified: "#2196f3",
  deprecated: "#757575",
}

const TYPE_COLORS: Record<string, string> = {
  prd: "#ff6b9d",
  composite: "#2196f3",
  atomic: "#4caf50",
}

const EDGE_COLORS: Record<string, string> = {
  contains: "#2196f3",
  blocks: "#f44336",
  addresses: "#4caf50",
  uses: "#9e9e9e",
  deprecated_by: "#757575",
}

const REPULSION = 5000
const ATTRACTION = 0.005
const DAMPING = 0.9
const MIN_DISTANCE = 80
const CENTER_FORCE = 0.01
const NODE_RADIUS = 20

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  data: GraphNode
}

export default function GraphPage() {
  const params = useParams()
  const sdk = useSDK()
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)
  const [viewMode, setViewMode] = createSignal<"list" | "graph">("graph")
  const [dataSource, setDataSource] = createSignal<"currentPlan" | "main">("currentPlan")

  const graphQuery = createQuery(() => ({
    queryKey: [params.dir, params.id, "graph", dataSource()] as const,
    queryFn: async () => {
      if (dataSource() === "main") {
        const res = await sdk().client.graph.main({ directory: params.dir })
        return res.data as GraphView
      }
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
    const nodes = graphQuery.data?.nodes ?? []
    const counts: Record<string, number> = {}
    for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1
    return counts
  })

  return (
    <div class="flex h-full flex-col">
      <div class="border-b p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <h1 class="text-lg font-semibold">
              {dataSource() === "currentPlan" ? "Current Plan" : "Main Graph"}
            </h1>
            <div class="flex gap-1 rounded-lg bg-muted p-0.5">
              <button
                class="rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors"
                classList={{ "bg-background shadow-sm": dataSource() === "currentPlan", "text-muted-foreground": dataSource() !== "currentPlan" }}
                onClick={() => { setDataSource("currentPlan"); setSelectedNodeID(null) }}
              >
                Plan
              </button>
              <button
                class="rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors"
                classList={{ "bg-background shadow-sm": dataSource() === "main", "text-muted-foreground": dataSource() !== "main" }}
                onClick={() => { setDataSource("main"); setSelectedNodeID(null) }}
              >
                Main
              </button>
            </div>
          </div>
          <div class="flex gap-1 rounded-lg bg-muted p-0.5">
            <button
              class="rounded-md px-3 py-1 text-sm font-medium transition-colors"
              classList={{ "bg-background shadow-sm": viewMode() === "graph", "text-muted-foreground": viewMode() !== "graph" }}
              onClick={() => setViewMode("graph")}
            >
              Graph
            </button>
            <button
              class="rounded-md px-3 py-1 text-sm font-medium transition-colors"
              classList={{ "bg-background shadow-sm": viewMode() === "list", "text-muted-foreground": viewMode() !== "list" }}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>
        </div>
        <Show when={!graphQuery.isLoading} fallback={<Spinner />}>
          <div class="mt-1 flex gap-4 text-sm text-muted-foreground">
            <span>{graphQuery.data?.nodes.length ?? 0} nodes</span>
            <span>{graphQuery.data?.edges.length ?? 0} edges</span>
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
        <div class="flex-1 overflow-hidden">
          <Show
            when={(graphQuery.data?.nodes ?? []).length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-muted-foreground">
                {dataSource() === "currentPlan"
                  ? "No CurrentPlan nodes. Use the graph_plan_admit tool to create a plan."
                  : "No main graph nodes. Promote a CurrentPlan to populate the main graph."}
              </div>
            }
          >
            <Show
              when={viewMode() === "graph"}
              fallback={
                <div class="h-full divide-y overflow-auto">
                  <For each={graphQuery.data?.nodes}>
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
              }
            >
              <GraphCanvas
                data={graphQuery.data!}
                selectedNodeID={selectedNodeID()}
                onSelectNode={setSelectedNodeID}
              />
            </Show>
          </Show>
        </div>

        <Show when={selectedNodeID()}>
          <div class="w-80 shrink-0 overflow-auto border-l p-4">
            <Show when={!nodeReadinessQuery.isLoading} fallback={<Spinner />}>
              <h2 class="mb-2 font-semibold">
                {graphQuery.data?.nodes.find((n) => n.id === selectedNodeID())?.name}
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

function GraphCanvas(props: {
  data: GraphView
  selectedNodeID: string | null
  onSelectNode: (id: string | null) => void
}) {
  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined

  let simNodes: SimNode[] = []
  let cam = { x: 0, y: 0, zoom: 1 }
  let dragging = false
  let dragNode: SimNode | null = null
  let panning = false
  let lastMouse = { x: 0, y: 0 }
  let rafId = 0

  const initSim = () => {
    const existing = new Map(simNodes.map((n) => [n.id, n]))
    simNodes = props.data.nodes.map((node, i) => {
      const prev = existing.get(node.id)
      const angle = (i / props.data.nodes.length) * Math.PI * 2
      const r = 150
      return prev ?? {
        id: node.id,
        x: Math.cos(angle) * r + (Math.random() - 0.5) * 50,
        y: Math.sin(angle) * r + (Math.random() - 0.5) * 50,
        vx: 0,
        vy: 0,
        data: node,
      }
    })
  }

  const step = () => {
    const nodes = simNodes
    const edges = props.data.edges
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    for (const a of nodes) {
      a.vx *= DAMPING
      a.vy *= DAMPING
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        if (dist < 300) {
          const force = REPULSION / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }
    }

    for (const edge of edges) {
      const s = nodeMap.get(edge.sourceID)
      const t = nodeMap.get(edge.targetID)
      if (!s || !t) continue
      const dx = t.x - s.x
      const dy = t.y - s.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (dist - MIN_DISTANCE) * ATTRACTION
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      s.vx += fx
      s.vy += fy
      t.vx -= fx
      t.vy -= fy
    }

    for (const n of nodes) {
      n.vx -= n.x * CENTER_FORCE
      n.vy -= n.y * CENTER_FORCE
      if (dragNode !== n) {
        n.x += n.vx
        n.y += n.vy
      }
    }
  }

  const render = () => {
    const canvas = canvasRef
    const container = containerRef
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth
    const h = container.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext("2d")!
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    ctx.translate(w / 2 + cam.x, h / 2 + cam.y)
    ctx.scale(cam.zoom, cam.zoom)

    const edges = props.data.edges
    const nodeMap = new Map(simNodes.map((n) => [n.id, n]))

    for (const edge of edges) {
      const s = nodeMap.get(edge.sourceID)
      const t = nodeMap.get(edge.targetID)
      if (!s || !t) continue
      const dist = Math.sqrt((t.x - s.x) ** 2 + (t.y - s.y) ** 2)
      if (dist < 60 && cam.zoom < 0.55) continue
      ctx.strokeStyle = EDGE_COLORS[edge.relation] ?? "#666"
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(t.x, t.y)
      ctx.stroke()

      const mx = (s.x + t.x) / 2
      const my = (s.y + t.y) / 2
      const angle = Math.atan2(t.y - s.y, t.x - s.x)
      const arrowSize = 8
      ctx.fillStyle = EDGE_COLORS[edge.relation] ?? "#666"
      ctx.beginPath()
      ctx.moveTo(mx + Math.cos(angle) * arrowSize, my + Math.sin(angle) * arrowSize)
      ctx.lineTo(
        mx + Math.cos(angle + 2.5) * arrowSize,
        my + Math.sin(angle + 2.5) * arrowSize,
      )
      ctx.lineTo(
        mx + Math.cos(angle - 2.5) * arrowSize,
        my + Math.sin(angle - 2.5) * arrowSize,
      )
      ctx.fill()
    }

    ctx.globalAlpha = 1
    const showLabels = cam.zoom >= 0.55 || simNodes.length <= 350

    for (const n of simNodes) {
      const isSelected = n.id === props.selectedNodeID
      const color = TYPE_COLORS[n.data.type] ?? "#999"
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = STATUS_COLORS[n.data.status] ?? "#999"
      ctx.lineWidth = isSelected ? 4 : 2.5
      ctx.beginPath()
      ctx.arc(n.x, n.y, NODE_RADIUS + 3, 0, Math.PI * 2)
      ctx.stroke()

      if (isSelected) {
        ctx.shadowColor = STATUS_COLORS[n.data.status] ?? "#999"
        ctx.shadowBlur = 20
        ctx.beginPath()
        ctx.arc(n.x, n.y, NODE_RADIUS + 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      if (showLabels) {
        ctx.fillStyle = "#e0e0e0"
        ctx.font = "12px system-ui, sans-serif"
        ctx.textAlign = "center"
        ctx.fillText(n.data.name, n.x, n.y + NODE_RADIUS + 16)
      }
    }

    ctx.restore()
  }

  const loop = () => {
    step()
    render()
    rafId = requestAnimationFrame(loop)
  }

  const screenToWorld = (sx: number, sy: number) => {
    const canvas = canvasRef!
    const rect = canvas.getBoundingClientRect()
    const x = sx - rect.left
    const y = sy - rect.top
    const container = containerRef!
    return {
      x: (x - container.clientWidth / 2 - cam.x) / cam.zoom,
      y: (y - container.clientHeight / 2 - cam.y) / cam.zoom,
    }
  }

  const hitTest = (wx: number, wy: number): SimNode | null => {
    for (const n of simNodes) {
      const dx = n.x - wx
      const dy = n.y - wy
      if (Math.sqrt(dx * dx + dy * dy) < NODE_RADIUS + 5) return n
    }
    return null
  }

  const onMouseDown = (e: MouseEvent) => {
    const world = screenToWorld(e.clientX, e.clientY)
    const hit = hitTest(world.x, world.y)
    if (hit) {
      dragging = true
      dragNode = hit
    } else {
      panning = true
      lastMouse = { x: e.clientX, y: e.clientY }
    }
  }

  const onMouseMove = (e: MouseEvent) => {
    if (dragging && dragNode) {
      const world = screenToWorld(e.clientX, e.clientY)
      dragNode.x = world.x
      dragNode.y = world.y
      dragNode.vx = 0
      dragNode.vy = 0
    } else if (panning) {
      cam.x += e.clientX - lastMouse.x
      cam.y += e.clientY - lastMouse.y
      lastMouse = { x: e.clientX, y: e.clientY }
    }
  }

  const onMouseUp = (e: MouseEvent) => {
    if (dragging && dragNode) {
      const world = screenToWorld(e.clientX, e.clientY)
      const hit = hitTest(world.x, world.y)
      if (hit === dragNode) {
        props.onSelectNode(hit.id === props.selectedNodeID ? null : hit.id)
      }
    }
    dragging = false
    dragNode = null
    panning = false
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(0.1, Math.min(5, cam.zoom * delta))
    const world = screenToWorld(e.clientX, e.clientY)
    cam.zoom = newZoom
    const container = containerRef!
    const newScreen = {
      x: world.x * cam.zoom + container.clientWidth / 2 + cam.x,
      y: world.y * cam.zoom + container.clientHeight / 2 + cam.y,
    }
    cam.x += e.clientX - newScreen.x
    cam.y += e.clientY - newScreen.y
  }

  onMount(() => {
    initSim()
    const canvas = canvasRef!
    canvas.addEventListener("mousedown", onMouseDown)
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    loop()
  })

  onCleanup(() => {
    cancelAnimationFrame(rafId)
    const canvas = canvasRef
    if (canvas) {
      canvas.removeEventListener("mousedown", onMouseDown)
      canvas.removeEventListener("wheel", onWheel)
    }
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("mouseup", onMouseUp)
  })

  return (
    <div ref={containerRef} class="relative h-full w-full cursor-grab active:cursor-grabbing">
      <canvas ref={canvasRef} class="h-full w-full" />
    </div>
  )
}
