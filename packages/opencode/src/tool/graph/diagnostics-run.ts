import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { buildableNodes } from "@opencode-ai/core/graph/build-order"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphDiagnostics } from "@opencode-ai/core/graph/workflow/diagnostics"
import { Graph } from "@opencode-ai/schema/graph"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Stream from "effect/Stream"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import { formatJson, resolveGraphSession, summarizeGate } from "./util"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_FIX_ATTEMPTS = 2
const MAX_OUTPUT_CHARS = 64_000

export const Parameters = Schema.Struct({
  targetNodeID: GraphStorage.NodeID,
  timeout: Schema.Number.pipe(Schema.optional),
  filter: Schema.String.pipe(Schema.optional),
})

interface CommandResult {
  name: string
  command: string
  exitCode: number | null
  output: string
  timedOut: boolean
  passed: boolean
  failureReason?: string
}

type CommandMetadata = Pick<CommandResult, "name" | "exitCode" | "timedOut" | "passed" | "failureReason">

type ExitKind = { kind: "exit"; code: number } | { kind: "timeout"; code: null } | { kind: "abort"; code: null }

interface NamedCommand {
  name: Graph.DiagnosticName
  executable: "bun"
  args: ReadonlyArray<string>
  command: string
  focused: boolean
  targets: ReadonlyArray<GraphDiagnostics.Target>
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
        if (!(yield* Effect.promise(() => GraphDiagnostics.targetsUnchanged(cmd)))) return changedTarget(cmd)
        const spec = ChildProcess.make(cmd.executable, cmd.args, {
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

        const truncatedOutput = output.slice(0, MAX_OUTPUT_CHARS)
        const failureReason = diagnosticFailureReason(cmd.command, exit, truncatedOutput)

        const result = {
          name: cmd.name,
          command: cmd.command,
          exitCode: exit.code,
          output: truncatedOutput,
          timedOut: exit.kind === "timeout",
          passed: failureReason === undefined,
          ...(failureReason ? { failureReason } : {}),
        } satisfies CommandResult
        if (!(yield* Effect.promise(() => GraphDiagnostics.targetsUnchanged(cmd)))) return changedTarget(cmd)
        return result
      }).pipe(Effect.scoped)

    return {
      description:
        "Run project diagnostics (tests, type checks, lint) for a graph node after artifact application. Updates node test status and promotes to verified on success. Optional 'filter' selects auto-detected commands by name (e.g. 'test', 'typecheck'). Optional 'timeout' sets per-command timeout in milliseconds.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* resolveGraphSession(ctx, sessions)

          const evaluation = yield* build.evaluateWithRevision({
            projectID: session.projectID,
            sessionID: session.sessionID,
            targetNodeID: params.targetNodeID,
            diagnosticsRequested: true,
            executor: "manual",
          })
          const gate = evaluation.gate

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
              metadata: {
                gate: summarizeGate(gate),
                ran: false,
                passed: false,
                complete: false,
                verified: false,
                skipped: [] as GraphDiagnostics.Skipped[],
                results: [] as CommandMetadata[],
              },
              output: formatJson({ ran: false, complete: false, verified: false, gate }),
            }
          }

          const previousFailures = yield* audit.tool.list({
            projectID: session.projectID,
            nodeID: params.targetNodeID,
          })
          const failedDiagCount = previousFailures.filter(
            (r) => r.toolName === "graph.diagnostics.run" && r.status === "failed",
          ).length
          if (failedDiagCount >= MAX_FIX_ATTEMPTS) {
            const reason = `Node has ${failedDiagCount} previous failed diagnostics (max ${MAX_FIX_ATTEMPTS}). Review the failures and revise the plan or seek human input.`
            yield* build.fail({ sessionID: session.sessionID, nodeID: params.targetNodeID, reason })
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
                complete: false,
                verified: false,
                skipped: [] as GraphDiagnostics.Skipped[],
                results: [] as CommandMetadata[],
              },
              output: formatJson({
                ran: false,
                complete: false,
                verified: false,
                reason,
              }),
            }
          }

          const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT_MS

          const target = yield* storage.node.get(params.targetNodeID)
          const resolution = yield* Effect.promise(() => GraphDiagnostics.resolve({
            directory: session.directory,
            verification: target.verification,
            filter: params.filter,
          }))
          if (!resolution.ok) {
            const evidence: Graph.VerificationEvidence = {
              kind: "diagnostics",
              nodeID: params.targetNodeID,
              criteria: target.verification?.criteria ?? [],
              artifactPaths: [],
              projectChecksOnly: target.verification === null,
              complete: false,
              passed: false,
              commands: [],
            }
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.diagnostics.run",
              toolType: "diagnostics",
              status: "blocked",
              outputSummary: resolution.reason,
              evidence,
            })
            return {
              title: "Diagnostics blocked",
              metadata: {
                gate: summarizeGate(gate),
                ran: false,
                passed: false,
                complete: false,
                verified: false,
                skipped: [] as GraphDiagnostics.Skipped[],
                results: [] as CommandMetadata[],
                ...resolution,
              },
              output: formatJson({ ran: false, passed: false, complete: false, verified: false, ...resolution }),
            }
          }
          const cmds = resolution.commands
          const completeDiagnostics = resolution.complete
          if (cmds.length === 0) {
            const reason = params.filter ? `No commands matched filter: ${params.filter}` : "No runnable diagnostic commands"
            return {
              title: "Diagnostics skipped",
              metadata: {
                gate: summarizeGate(gate),
                ran: false,
                passed: false,
                complete: false,
                verified: false,
                skipped: resolution.skipped,
                results: [] as CommandMetadata[],
              },
              output: formatJson({ ran: false, complete: false, verified: false, skipped: resolution.skipped, reason }),
            }
          }

          yield* ctx.ask({
            permission: "graph.diagnostics_run",
            patterns: cmds.map((cmd) => cmd.command),
            always: cmds.map((cmd) => cmd.command),
            metadata: { commands: cmds },
          })

          const executed: CommandResult[] = []
          for (const cmd of cmds) {
            const result = yield* runCmd(cmd, session.directory, ctx.abort, timeoutMs)
            executed.push(result)
          }
          const stable = yield* Effect.forEach(cmds, (command) => Effect.promise(() => GraphDiagnostics.targetsUnchanged(command)))
          const results = executed.map((result, index) => stable[index] ? result : changedTarget(cmds[index]))

          const allPassed = results.every((r) => r.passed)
          const verified = allPassed && completeDiagnostics

          const artifactPaths = (yield* audit.tool.list({
            projectID: session.projectID,
            sessionID: session.sessionID,
            nodeID: params.targetNodeID,
          }))
            .flatMap((record) => record.evidence?.kind === "artifact" ? [record.evidence] : [])
            .at(-1)?.artifactPaths ?? []
          const evidence: Graph.VerificationEvidence = {
            kind: "diagnostics",
            nodeID: params.targetNodeID,
            criteria: target.verification?.criteria ?? [],
            artifactPaths,
            projectChecksOnly: resolution.projectChecksOnly,
            complete: completeDiagnostics,
            passed: verified,
            commands: results.map((result) => ({
              name: result.name,
              command: result.command,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              passed: result.passed,
              excerpt: result.output.slice(0, 8_192),
            })),
          }
          const inputSummary = [
            ...cmds.map((command) => command.name),
            ...(resolution.skipped.length > 0 ? [`skipped=${resolution.skipped.length}`] : []),
          ].join("; ")
          const outputSummary = results.map((result) => `${result.name}:${result.failureReason ?? result.exitCode}`).join(", ")

          let nextHint = ""
          if (verified) {
            const completion = yield* build.completeVerification({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              expectedRevision: evaluation.workflowRevision,
              evidence,
              inputSummary,
              outputSummary,
            }).pipe(
              Effect.as(true),
              Effect.catchTag("GraphWorkflowState.RevisionConflict", () => Effect.succeed(false)),
            )
            if (!completion) {
              yield* audit.tool.record({
                projectID: session.projectID,
                sessionID: session.sessionID,
                nodeID: params.targetNodeID,
                toolName: "graph.diagnostics.run",
                toolType: "diagnostics",
                status: "blocked",
                inputSummary,
                outputSummary: "workflow_revision_conflict",
                evidence,
              })
              return {
                title: "Diagnostics superseded by workflow change",
                metadata: {
                  gate: summarizeGate(gate),
                  ran: true,
                  passed: true,
                  complete: true,
                  verified: false,
                  skipped: resolution.skipped,
                  results: [] as CommandMetadata[],
                },
                output: formatJson({ ran: true, passed: true, complete: true, verified: false, reason: "workflow_revision_conflict" }),
              }
            }
            const cp = yield* domain.currentPlan({ sessionID: session.sessionID })
            const newlyBuildable = buildableNodes(cp.nodes, cp.edges)
              .filter((n) => n.id !== params.targetNodeID)
              .map((n) => n.name)
            if (newlyBuildable.length > 0) {
              nextHint = `\n\nNewly buildable: ${newlyBuildable.join(", ")}`
            }
          }

          if (!verified && !allPassed) {
            yield* build.failVerification({
              projectID: session.projectID, sessionID: session.sessionID, nodeID: params.targetNodeID,
              expectedRevision: evaluation.workflowRevision, evidence, inputSummary, outputSummary,
            }).pipe(Effect.catchTag("GraphWorkflowState.RevisionConflict", () => Effect.void))
          } else if (!verified) {
            yield* audit.tool.record({
              projectID: session.projectID,
              sessionID: session.sessionID,
              nodeID: params.targetNodeID,
              toolName: "graph.diagnostics.run",
              toolType: "diagnostics",
              status: allPassed ? "succeeded" : "failed",
              inputSummary,
              outputSummary,
              evidence,
            })
          }

          return {
            title: verified ? "Diagnostics passed" : allPassed ? "Diagnostics passed - filtered subset" : "Diagnostics failed",
            metadata: {
              gate: summarizeGate(gate),
              ran: true,
              passed: allPassed,
              complete: completeDiagnostics,
              verified,
              skipped: resolution.skipped,
              results: results.map((r) => ({
                name: r.name,
                exitCode: r.exitCode,
                timedOut: r.timedOut,
                passed: r.passed,
                ...(r.failureReason ? { failureReason: r.failureReason } : {}),
              })),
            },
            output: formatJson({
              ran: true,
              passed: allPassed,
              complete: completeDiagnostics,
              verified,
              skipped: resolution.skipped,
              results,
            }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function diagnosticFailureReason(command: string, exit: ExitKind, output: string) {
  if (exit.kind === "timeout") return "timeout"
  if (exit.kind === "abort") return "aborted"
  if (exit.code !== 0) return `exit_code:${exit.code}`
  if (isBunRunUsageOutput(command, output)) return "bun_run_usage"
}

function changedTarget(command: NamedCommand): CommandResult {
  return { name: command.name, command: command.command, exitCode: null, output: "Focused verification target changed", timedOut: false, passed: false, failureReason: "verification_target_changed" }
}

function isBunRunUsageOutput(command: string, output: string) {
  return (
    /\bbun\b/.test(command) &&
    /\brun\b/.test(command) &&
    output.includes("Usage: bun run [flags] <file or script>")
  )
}
