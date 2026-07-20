export type ProductPresentation = {
  id: "opencode" | "graph-vibe"
  name: string
  capability: string
}

const openCode: ProductPresentation = {
  id: "opencode",
  name: "OpenCode",
  capability: "The AI coding agent built for the terminal",
}

export function resolveProductPresentation(product?: {
  id: string
  name: string
  capability: string
}): ProductPresentation {
  if (product?.id === "graph-vibe") return { ...product, id: "graph-vibe" }
  return openCode
}
