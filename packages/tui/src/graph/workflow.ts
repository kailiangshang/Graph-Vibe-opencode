import { base64Encode } from "@opencode-ai/core/util/encode"

export const TASK_DRAFT = "What do you want to build or change?\n\nGoal:\nSuccess criteria:\nConstraints:"

export function startGraphPrompt(
  prompt: { set(value: { input: string; parts: never[] }): void; focus(): void } | undefined,
) {
  if (!prompt) return false
  prompt.set({ input: TASK_DRAFT, parts: [] })
  prompt.focus()
  return true
}

type NodeStatus = "pending" | "implemented" | "verified" | "deprecated"
type TestStatus = "none" | "pending" | "passed" | "failed"
type GraphNode = { status: NodeStatus; testStatus: TestStatus }

export function summarizeCurrentPlan(nodes: readonly GraphNode[]) {
  const counts = <T extends string>(values: readonly T[], get: (node: GraphNode) => T) =>
    values.map(
      (value) => [value[0].toUpperCase() + value.slice(1), nodes.filter((node) => get(node) === value).length] as const,
    )

  return {
    total: nodes.length,
    nodes: counts(["pending", "implemented", "verified", "deprecated"], (node) => node.status),
    diagnostics: counts(["none", "pending", "passed", "failed"], (node) => node.testStatus),
  }
}

export function graphWebUrl(input: { webUrl?: string; serverUrl: string; directory: string; sessionID: string }) {
  if (!input.webUrl) return
  const web = new URL(input.webUrl)
  const server = new URL(input.serverUrl)
  const route =
    web.origin === server.origin
      ? `/${base64Encode(input.directory)}/session/${input.sessionID}/graph`
      : `/server/${base64Encode(input.serverUrl.replace(/\/$/, ""))}/session/${input.sessionID}/graph`
  return web.origin + route
}

export function graphServerUrl(webServerUrl: string | undefined, sdkUrl: string) {
  return webServerUrl ?? sdkUrl
}

export async function graphWebAvailable(
  webUrl: string | undefined,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  if (!webUrl) return false
  return request(webUrl, { method: "HEAD" })
    .then((response) => response.ok)
    .catch(() => false)
}
