export const OpenCode = {
  id: "opencode",
  name: "OpenCode",
  cli: "opencode",
  capability: "The AI coding agent built for the terminal",
  attribution: "",
} as const

export const GraphVibe = {
  id: "graph-vibe",
  name: "Graph Vibe",
  cli: "graph-vibe",
  capability: "Graph-guided development",
  attribution: "Powered by OpenCode",
} as const

export function current() {
  return process.env.OPENCODE_CLIENT === GraphVibe.id ? GraphVibe : OpenCode
}

export function commandName() {
  const product = current()
  return product === GraphVibe ? product.name : product.cli
}

export * as Product from "./product"
