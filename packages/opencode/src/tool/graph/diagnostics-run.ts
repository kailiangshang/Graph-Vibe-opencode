import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Stream from "effect/Stream"
import { Effect, Schema } from "effect"
import path from "node:path"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession, summarizeGate } from "./util"

const DIAGNOSTICS_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 64_000

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  commands: Schema.Array(Schema.String).pipe(Schema.optional),
})

interface CommandResult {
  command: string
  exitCode: number | null
  output: string
  timedOut: boolean
}

type ExitKind = { kind: "exit"; code: number } | { kind: "timeout"; code: null } | { kind: "abort"; code: null }

export const GraphDiagnosticsRunTool = Tool.define(
  "graph_diagnostics_run",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const build = yield* GraphBuild.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const spawner = yield* ChildProcessSpawner

    const runCmd = (command: string, cwd: string, abort: AbortSignal) =>
      Effect.gen(function* () {
        const spec = ChildProcess.make(command, [], {
          shell: process.env.SHELL ?? "/bin/sh",
          cwd,
          env: process.env,
          stdin: "ignore",
          detached: false,
        })
        const handle = yield* spawner.spawn(spec)

        let output = ""
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.decodeText(handle.all), (chunk: string) =>
            Effect.sync(() => {
              if (output.length < MAX_OUTPUT_CHARS) output += chunk
            }),
          ),
        )

        const abortEffect = Effect.callback<void>((resume) => {
          if (abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => abort.removeEventListener("abort", handler))
        })

        const exit: ExitKind = yield* Effect.raceAll([
          handle.exitCode.pipe(Effect.map((code): ExitKind => ({ kind: "exit", code }))),
          Effect.sleep(`${DIAGNOSTICS_TIMEOUT_MS} millis`).pipe(
            Effect.map((): ExitKind => ({ kind: "timeout", code: null })),
          ),
          abortEffect.pipe(Effect.map((): ExitKind => ({ kind: "abort", code: null }))),
        ])

        if (exit.kind !== "exit") {
          yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
        }

        yield* Effect.sleep("500 millis")

        return {
          command,
          exitCode: exit.code,
          output: output.slice(0, MAX_OUTPUT_CHARS),
          timedOut: exit.kind === "timeout",
        } satisfies CommandResult
      }).pipe(Effect.scoped)

    return {
      description:
        "Run project diagnostics (tests, type checks, lint) for a graph node after artifact application. Updates node test status and promotes to verified on success.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)

          const gate = yield* build.evaluate({
            projectID: session.projectID,
            sessionID: session.sessionID,
            targetNodeID: params.targetNodeID,
            diagnosticsRequested: true,
            executor: "manual",
          })

          if (!gate.allowed) {
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.diagnostics.run",
              toolType: "diagnostics",
              status: "blocked",
              outputSummary: summarizeGate(gate),
            })
            return {
              title: "Diagnostics blocked",
              metadata: { gate: summarizeGate(gate), ran: false, passed: false, results: [] },
              output: formatJson({ ran: false, gate }),
            }
          }

          yield* ctx.ask({
            permission: "graph.diagnostics_run",
            patterns: [],
            always: ["*"],
            metadata: {},
          })

          const commands =
            params.commands ??
            (yield* Effect.promise(() => detectDiagnosticsCommands(session.directory)))

          const results: CommandResult[] = []
          for (const cmd of commands) {
            const result = yield* runCmd(cmd, session.directory, ctx.abort)
            results.push(result)
          }

          const allPassed = results.every((r) => r.exitCode === 0)

          yield* storage.node.update(params.targetNodeID, {
            testStatus: allPassed ? "passed" : "failed",
            ...(allPassed ? { status: "verified" as const } : {}),
          })

          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: params.targetNodeID,
            toolName: "graph.diagnostics.run",
            toolType: "diagnostics",
            status: allPassed ? "succeeded" : "failed",
            inputSummary: commands.join("; "),
            outputSummary: results.map((r) => `${r.command}:${r.exitCode}`).join(", "),
          })

          return {
            title: allPassed ? "Diagnostics passed" : "Diagnostics failed",
            metadata: {
              gate: summarizeGate(gate),
              ran: true,
              passed: allPassed,
              results: results.map((r) => ({ command: r.command, exitCode: r.exitCode })),
            },
            output: formatJson({ ran: true, passed: allPassed, results }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function detectDiagnosticsCommands(directory: string): Promise<string[]> {
  const pkg = await Bun.file(path.join(directory, "package.json"))
    .json()
    .catch(() => ({ scripts: {} }))
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {}
  const commands: string[] = []
  if (scripts.test) commands.push("bun run test")
  if (scripts.typecheck) commands.push("bun run typecheck")
  if (scripts.lint) commands.push("bun run lint")
  return commands.length > 0 ? commands : ["bun test"]
}
