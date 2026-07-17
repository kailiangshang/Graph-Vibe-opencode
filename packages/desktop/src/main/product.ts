export type Channel = "dev" | "beta" | "prod"

export function desktopProduct(client: string | undefined, channel: Channel) {
  const graph = client === "graph-vibe"
  const suffix = channel === "prod" ? "" : `.${channel}`
  return {
    id: `ai.${graph ? "graph-vibe" : "opencode"}.desktop${suffix}`,
    name: `${graph ? "Graph Vibe" : "OpenCode"}${channel === "prod" ? "" : ` ${channel === "dev" ? "Dev" : "Beta"}`}`,
    client: graph ? "graph-vibe" : "desktop",
  } as const
}
