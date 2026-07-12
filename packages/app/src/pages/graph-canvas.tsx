import { createEffect, onCleanup, onMount } from "solid-js"
import { deterministicPosition, type GraphEdge } from "./graph-helpers"

type CanvasData = {
  id: string
  name: string
  status?: string
  type?: string
}
export type CanvasNode = { id: string; x: number; y: number; vx: number; vy: number; data: CanvasData }
export const GRAPH_CANVAS_LABEL = "Workflow graph canvas. Use the task rail for keyboard navigation."

export function panCamera(
  camera: { x: number; y: number; zoom: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  return { ...camera, x: camera.x + end.x - start.x, y: camera.y + end.y - start.y }
}

export function reconcileCanvasNodes(graphID: string, previous: CanvasNode[], nodes: CanvasData[]) {
  const existing = new Map(previous.map((node) => [node.id, node]))
  return nodes.map((data) => {
    const node = existing.get(data.id)
    if (node) return { ...node, data }
    return { id: data.id, ...deterministicPosition(graphID, data.id, nodes.length), vx: 0, vy: 0, data }
  })
}

export function screenToWorld(input: {
  clientX: number
  clientY: number
  left: number
  top: number
  width: number
  height: number
  cameraX: number
  cameraY: number
  zoom: number
}) {
  return {
    x: (input.clientX - input.left - input.width / 2 - input.cameraX) / input.zoom,
    y: (input.clientY - input.top - input.height / 2 - input.cameraY) / input.zoom,
  }
}

export function GraphCanvas(props: {
  graphID: string
  data: { nodes: CanvasData[]; edges: GraphEdge[] }
  selectedNodeID: string | null
  currentNodeID: string | null
  onSelectNode: (id: string | null) => void
  onCenterNode?: (id: string) => void
}) {
  let canvas: HTMLCanvasElement | undefined
  let container: HTMLDivElement | undefined
  let nodes: CanvasNode[] = []
  let frame = 0
  let unsettled = 0
  let camera = { x: 0, y: 0, zoom: 1 }
  let panStart: { x: number; y: number } | undefined
  let panOrigin = camera
  let panned = false

  const colors = () => {
    if (!container || typeof getComputedStyle === "undefined") return defaultColors
    const style = getComputedStyle(container)
    return {
      surface: style.getPropertyValue("--graph-canvas") || defaultColors.surface,
      text: style.getPropertyValue("--graph-text") || defaultColors.text,
      edge: style.getPropertyValue("--graph-edge") || defaultColors.edge,
      current: style.getPropertyValue("--graph-current") || defaultColors.current,
      selected: style.getPropertyValue("--graph-selected") || defaultColors.selected,
      verified: style.getPropertyValue("--graph-verified") || defaultColors.verified,
      failed: style.getPropertyValue("--graph-failed") || defaultColors.failed,
      checkpoint: style.getPropertyValue("--graph-checkpoint") || defaultColors.checkpoint,
      pending: style.getPropertyValue("--graph-pending") || defaultColors.pending,
    }
  }

  const draw = () => {
    if (!canvas || !container) return
    const ratio = window.devicePixelRatio || 1
    const width = container.clientWidth
    const height = container.clientHeight
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    const context = canvas.getContext("2d")
    if (!context) return
    const palette = colors()
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = palette.surface
    context.fillRect(0, 0, width, height)
    context.translate(width / 2 + camera.x, height / 2 + camera.y)
    context.scale(camera.zoom, camera.zoom)
    const lookup = new Map(nodes.map((node) => [node.id, node]))
    context.strokeStyle = palette.edge
    context.lineWidth = 1
    props.data.edges.forEach((edge) => {
      const source = lookup.get(edge.sourceID)
      const target = lookup.get(edge.targetID)
      if (!source || !target) return
      context.beginPath()
      context.moveTo(source.x, source.y)
      context.lineTo(target.x, target.y)
      context.stroke()
    })
    nodes.forEach((node) => {
      const current = node.id === props.currentNodeID
      const selected = node.id === props.selectedNodeID
      const state =
        node.data.status === "verified"
          ? palette.verified
          : node.data.status === "failed"
            ? palette.failed
            : node.data.status === "implemented"
              ? palette.checkpoint
              : palette.pending
      context.fillStyle = palette.surface
      context.strokeStyle = current ? palette.current : selected ? palette.selected : state
      context.lineWidth = current ? 5 : selected ? 3 : 2
      context.beginPath()
      if (node.data.status === "failed") context.rect(node.x - 18, node.y - 18, 36, 36)
      else context.arc(node.x, node.y, current ? 22 : 18, 0, Math.PI * 2)
      context.fill()
      context.stroke()
      if (node.data.status === "verified") {
        context.fillStyle = state
        context.font = "bold 13px sans-serif"
        context.textAlign = "center"
        context.fillText("✓", node.x, node.y + 5)
      }
      context.fillStyle = palette.text
      context.font = `${current ? "600 " : ""}12px sans-serif`
      context.textAlign = "center"
      context.fillText(node.data.name, node.x, node.y + 38)
    })
  }

  const settle = () => {
    const lookup = new Map(nodes.map((node) => [node.id, node]))
    nodes.forEach((node) => {
      node.vx = (node.vx - node.x * 0.002) * 0.82
      node.vy = (node.vy - node.y * 0.002) * 0.82
    })
    props.data.edges.forEach((edge) => {
      const source = lookup.get(edge.sourceID)
      const target = lookup.get(edge.targetID)
      if (!source || !target) return
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const force = (distance - 120) * 0.0015
      source.vx += dx * force
      source.vy += dy * force
      target.vx -= dx * force
      target.vy -= dy * force
    })
    nodes.forEach((node) => {
      node.x += node.vx
      node.y += node.vy
    })
  }

  const animate = () => {
    if (unsettled > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle()
      unsettled -= 1
    }
    draw()
    if (unsettled > 0) frame = requestAnimationFrame(animate)
  }

  const start = () => {
    cancelAnimationFrame(frame)
    unsettled = 80
    frame = requestAnimationFrame(animate)
  }

  const world = (event: { clientX: number; clientY: number }) => {
    const rect = canvas!.getBoundingClientRect()
    return screenToWorld({
      clientX: event.clientX,
      clientY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
    })
  }

  const hit = (event: { clientX: number; clientY: number }) => {
    const point = world(event)
    return nodes.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= 26)
  }

  const center = (id: string) => {
    const node = nodes.find((item) => item.id === id)
    if (!node) return
    camera = { x: -node.x * 1.15, y: -node.y * 1.15, zoom: 1.15 }
    draw()
    props.onCenterNode?.(id)
  }

  createEffect(() => {
    nodes = reconcileCanvasNodes(props.graphID, nodes, props.data.nodes)
    props.data.edges.length
    if (typeof window !== "undefined") start()
  })
  createEffect(() => {
    props.selectedNodeID
    props.currentNodeID
    if (typeof window !== "undefined") draw()
  })

  onMount(() => {
    const resize = () => draw()
    window.addEventListener("resize", resize)
    onCleanup(() => window.removeEventListener("resize", resize))
    start()
  })
  onCleanup(() => cancelAnimationFrame(frame))

  return (
    <div
      ref={container}
      class="graph-canvas relative h-full min-h-72 w-full overflow-hidden"
      aria-label="Workflow graph"
    >
      <canvas
        ref={canvas}
        class="h-full w-full touch-none"
        aria-label={GRAPH_CANVAS_LABEL}
        onPointerDown={(event) => {
          if (hit(event)) return
          panStart = { x: event.clientX, y: event.clientY }
          panOrigin = camera
          panned = false
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!panStart) return
          const end = { x: event.clientX, y: event.clientY }
          panned ||= Math.hypot(end.x - panStart.x, end.y - panStart.y) > 3
          camera = panCamera(panOrigin, panStart, end)
          draw()
        }}
        onPointerUp={(event) => {
          panStart = undefined
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onClick={(event) => {
          if (panned) {
            panned = false
            return
          }
          props.onSelectNode(hit(event)?.id ?? null)
        }}
        onDblClick={(event) => {
          const node = hit(event)
          if (node) center(node.id)
        }}
        onWheel={(event) => {
          event.preventDefault()
          const point = world(event)
          const zoom = Math.max(0.35, Math.min(2.5, camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1)))
          const rect = canvas!.getBoundingClientRect()
          camera = {
            zoom,
            x: event.clientX - rect.left - rect.width / 2 - point.x * zoom,
            y: event.clientY - rect.top - rect.height / 2 - point.y * zoom,
          }
          draw()
        }}
      />
      <div class="absolute bottom-3 right-3 flex gap-1" aria-label="Graph view controls">
        <button
          class="graph-control"
          aria-label="Zoom in"
          onClick={() => {
            camera.zoom = Math.min(2.5, camera.zoom * 1.2)
            draw()
          }}
        >
          +
        </button>
        <button
          class="graph-control"
          aria-label="Zoom out"
          onClick={() => {
            camera.zoom = Math.max(0.35, camera.zoom / 1.2)
            draw()
          }}
        >
          -
        </button>
        <button
          class="graph-control"
          aria-label="Center current task"
          onClick={() => props.currentNodeID && center(props.currentNodeID)}
        >
          Center
        </button>
      </div>
    </div>
  )
}

const defaultColors = {
  surface: "#111820",
  text: "#dce7ed",
  edge: "#52636e",
  current: "#4f9f9c",
  selected: "#6f92b6",
  verified: "#668b72",
  failed: "#b36568",
  checkpoint: "#a68a58",
  pending: "#647682",
}
