import type { ProjectV2 } from "@opencode-ai/core/project"
import type { GateResult } from "@opencode-ai/core/graph/workflow/gate"
import { Effect } from "effect"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Tool } from "../tool"

export interface GraphSession {
  readonly projectID: ProjectV2.ID
  readonly sessionID: SessionID
  readonly directory: string
}

export function resolveGraphSession(
  ctx: Tool.Context,
  sessions: Session.Interface,
): Effect.Effect<GraphSession, Session.NotFound> {
  return Effect.gen(function* () {
    const session = yield* sessions.get(ctx.sessionID)
    return { projectID: session.projectID, sessionID: ctx.sessionID, directory: session.directory }
  })
}

export function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? "undefined"
}

export function summarizeGate(result: GateResult) {
  if (result.allowed) return "allowed"
  return `blocked:${result.issues.length}`
}
