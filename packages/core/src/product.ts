export const OpenCode = {
  id: "opencode",
  name: "OpenCode",
  cli: "opencode",
  storage: "opencode",
  database: "opencode.db",
  config: "opencode",
  backendPort: 4096,
  uiPort: 4096,
  mdnsDomain: "opencode.local",
  package: "opencode-ai",
  desktopID: "ai.opencode.desktop",
  protocol: "opencode",
  capability: "The AI coding agent built for the terminal",
  attribution: "",
} as const

export const GraphVibe = {
  id: "graph-vibe",
  name: "Graph Vibe",
  cli: "graph-vibe",
  storage: "graph-vibe",
  database: "graph-vibe.db",
  config: "graph-vibe",
  backendPort: 4097,
  uiPort: 4444,
  mdnsDomain: "graph-vibe.local",
  package: "graph-vibe",
  desktopID: "ai.graph-vibe.desktop",
  protocol: "graph-vibe",
  capability: "Graph-guided development",
  attribution: "Powered by OpenCode",
} as const

export type Profile = typeof OpenCode | typeof GraphVibe

export function forClient(client: string | undefined): Profile {
  return client === GraphVibe.id ? GraphVibe : OpenCode
}

export function current() {
  return forClient(process.env.OPENCODE_CLIENT)
}

export function commandName() {
  const product = current()
  return product === GraphVibe ? product.name : product.cli
}

export interface Interface {
  readonly profile: Profile
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Product") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of({ profile: current() })),
)

export function layerWith(profile: Profile) {
  return Layer.succeed(Service, Service.of({ profile }))
}

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export * as Product from "./product"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
