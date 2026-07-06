import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { buildableNodes } from "@opencode-ai/core/graph/build-order"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Stream from "effect/Stream"
import { Effect, Schema } from "effect"
import path from "node:path"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession, summarizeGate } from "./util"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_FIX_ATTEMPTS = 2
const MAX_OUTPUT_CHARS = 64_000

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  commands: Schema.Array(Schema.String).pipe(Schema.optional),
  timeout: Schema.Number.pipe(Schema.optional),
  filter: Schema.String.pipe(Schema.optional),
})

interface CommandResult {
  name: string
  command: string
  exitCode: number | null
  output: string
  timedOut: boolean
}

type ExitKind = { kind: "exit"; code: number } | { kind: "timeout"; code: null } | { kind: "abort"; code: null }

interface NamedCommand {
  name: string
  command: string
}

export const GraphDiagnosticsRunTool = Tool.define(
  "graph_diagnostics_run",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const build = yield* GraphBuild.Service
    const storage = yield* GraphStorage.Service
    const audit = yield* GraphAudit.Service
    const spawner = yield* ChildProcessSpawner
    const domain = yield* GraphDomain.Service

    const runCmd = (cmd: NamedCommand, cwd: string, abort: AbortSignal, timeoutMs: number) =>
      Effect.gen(function* () {
        const spec = ChildProcess.make(cmd.command, [], {
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
          Effect.sleep(`${timeoutMs} millis`).pipe(
            Effect.map((): ExitKind => ({ kind: "timeout", code: null })),
          ),
          abortEffect.pipe(Effect.map((): ExitKind => ({ kind: "abort", code: null }))),
        ])

        if (exit.kind !== "exit") {
          yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
        }

        yield* Effect.sleep("500 millis")

        return {
          name: cmd.name,
          command: cmd.command,
          exitCode: exit.code,
          output: output.slice(0, MAX_OUTPUT_CHARS),
          timedOut: exit.kind === "timeout",
        } satisfies CommandResult
      }).pipe(Effect.scoped)

    return {
      description:
        "Run project diagnostics (tests, type checks, lint) for a graph node after artifact application. Updates node test status and promotes to verified on success. Optional 'filter' selects auto-detected commands by name (e.g. 'test', 'typecheck'). Optional 'timeout' sets per-command timeout in milliseconds.",
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

          const previousFailures = yield* audit.tool.list({
            projectID: session.projectID,
            nodeID: params.targetNodeID,
          })
          const failedDiagCount = previousFailures.filter(
            (r) => r.toolName === "graph.diagnostics.run" && r.status === "failed",
          ).length
          if (failedDiagCount >= MAX_FIX_ATTEMPTS) {
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.diagnostics.run",
              toolType: "diagnostics",
              status: "blocked",
              outputSummary: `budget_exhausted:${failedDiagCount}`,
            })
            return {
              title: "Diagnostics blocked — fix budget exhausted",
              metadata: {
                gate: summarizeGate(gate),
                ran: false,
                passed: false,
                results: [],
              },
              output: formatJson({
                ran: false,
                reason: `Node has ${failedDiagCount} previous failed diagnostics (max ${MAX_FIX_ATTEMPTS}). Review the failures and revise the plan or seek human input.`,
              }),
            }
          }

          const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT_MS

          let cmds: NamedCommand[]
          if (params.commands) {
            cmds = params.commands.map((c) => ({ name: c, command: c }))
          } else {
            const detected = yield* Effect.promise(() => detectDiagnosticsCommands(session.directory))
            cmds = params.filter
              ? detected.filter((c) => c.name.includes(params.filter!))
              : detected
            if (cmds.length === 0 && params.filter) {
              return {
                title: "Diagnostics skipped",
                metadata: { gate: summarizeGate(gate), ran: false, passed: false, results: [] },
                output: formatJson({ ran: false, reason: `No commands matched filter: ${params.filter}` }),
              }
            }
          }

          const results: CommandResult[] = []
          for (const cmd of cmds) {
            const result = yield* runCmd(cmd, session.directory, ctx.abort, timeoutMs)
            results.push(result)
          }

          const allPassed = results.every((r) => r.exitCode === 0)

          yield* storage.node.update(params.targetNodeID, {
            testStatus: allPassed ? "passed" : "failed",
            ...(allPassed ? { status: "verified" as const } : {}),
          })

          let nextHint = ""
          if (allPassed) {
            const cp = yield* domain.currentPlan({ sessionID: session.sessionID })
            const newlyBuildable = buildableNodes(cp.nodes, cp.edges)
              .filter((n) => n.id !== params.targetNodeID)
              .map((n) => n.name)
            if (newlyBuildable.length > 0) {
              nextHint = `\n\nNewly buildable: ${newlyBuildable.join(", ")}`
            }
          }

          yield* audit.tool.record({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: params.targetNodeID,
            toolName: "graph.diagnostics.run",
            toolType: "diagnostics",
            status: allPassed ? "succeeded" : "failed",
            inputSummary: cmds.map((c) => c.name).join("; "),
            outputSummary: results.map((r) => `${r.name}:${r.exitCode}`).join(", "),
          })

          return {
            title: allPassed ? "Diagnostics passed" : "Diagnostics failed",
            metadata: {
              gate: summarizeGate(gate),
              ran: true,
              passed: allPassed,
              results: results.map((r) => ({ name: r.name, exitCode: r.exitCode, timedOut: r.timedOut })),
            },
            output: formatJson({ ran: true, passed: allPassed, results }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function detectDiagnosticsCommands(directory: string): Promise<NamedCommand[]> {
  const pkg = await Bun.file(path.join(directory, "package.json"))
    .json()
    .catch(() => ({ scripts: {} }))
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {}
  const commands: NamedCommand[] = []
  if (scripts.test) commands.push({ name: "test", command: "bun run test" })
  if (scripts.typecheck) commands.push({ name: "typecheck", command: "bun run typecheck" })
  if (scripts.lint) commands.push({ name: "lint", command: "bun run lint" })
  return commands.length > 0 ? commands : [{ name: "test", command: "bun test" }]
}
