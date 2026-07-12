import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Equal, Fiber, Hash, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { define } from "@opencode-ai/plugin/v2/effect"
import type { VerificationSpec } from "@opencode-ai/schema/graph"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { GraphStorage } from "../src/graph/storage"
import { GraphNodeTable } from "../src/graph/sql"
import { GraphToolRunTable } from "../src/graph/workflow/audit.sql"
import { GraphWorkflowStateTable } from "../src/graph/workflow/state.sql"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Reference } from "../src/reference"
import { SessionTable } from "../src/session/sql"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("LocationServiceMap", () => {
  it.live("materializes graph tools instead of raw write tools when graph mode is enabled", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            yield* (yield* ApplicationTools.Service).register({
              application_context: Tool.make({
                description: "Application context",
                input: Schema.Struct({}),
                output: Schema.Struct({ ok: Schema.Boolean }),
                execute: () => Effect.succeed({ ok: true }),
              }),
            })
            const state = yield* Effect.gen(function* () {
              yield* (yield* Tools.Service).register({
                run_command: Tool.make({
                  description: "Run command",
                  input: Schema.Struct({}),
                  output: Schema.Struct({ ok: Schema.Boolean }),
                  execute: () => Effect.succeed({ ok: true }),
                }),
              })
              const registry = yield* ToolRegistry.Service
              const context = yield* SystemContextRegistry.Service
              return {
                tools: yield* toolDefinitions(registry),
                baseline: (yield* SystemContext.initialize(yield* context.load())).baseline,
              }
            }).pipe(Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))
            expect(state.tools.map((tool) => tool.name).sort()).toEqual([
              "glob",
              "graph_artifact_apply",
              "graph_artifact_begin",
              "graph_artifact_chunk",
              "graph_artifact_seal",
              "graph_build_gate",
              "graph_diagnostics_run",
              "graph_plan_admit",
              "grep",
              "question",
              "read",
              "skill",
              "todowrite",
              "webfetch",
              "websearch",
            ])
            const diagnostics = state.tools.find((tool) => tool.name === "graph_diagnostics_run")
            expect(diagnostics?.inputSchema).not.toHaveProperty("properties.commands")
            const planAdmit = state.tools.find((tool) => tool.name === "graph_plan_admit")
            expect(planAdmit?.inputSchema).not.toHaveProperty("properties.nodes.items.properties.status")
            expect(planAdmit?.inputSchema).not.toHaveProperty("properties.nodes.items.properties.testStatus")
            expect(state.baseline).toContain("Graph Workflow Mode")
          }),
        ),
      ),
    ),
  )

  it.live("does not admit verified nodes from model-supplied plan status", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const state = yield* setupGraphSession(dir.path).pipe(
              Effect.flatMap((state) => {
                const input = {
                  dryRun: false,
                  nodes: [
                    {
                      type: "atomic",
                      name: "Plan status bypass",
                      level: "L2",
                      verification: { criteria: ["observable result"], diagnostics: [{ name: "test" }] },
                      status: "verified",
                      testStatus: "passed",
                    },
                  ],
                  edges: [],
                }
                return executeTool(state.registry, {
                  sessionID: state.sessionID,
                  ...toolIdentity,
                  call: { type: "tool-call", id: "call-plan-status", name: "graph_plan_admit", input },
                }).pipe(Effect.as(state))
              }),
              Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
            )
            const node = (yield* state.db
              .select()
              .from(GraphNodeTable)
              .where(eq(GraphNodeTable.session_id, state.sessionID))
              .all()
              .pipe(Effect.orDie))[0]
            expect(node?.status).toBe("pending")
            expect(node?.test_status).toBe("none")
          }),
        ),
      ),
    ),
  )

  it.live("does not let supplied diagnostics commands verify a node", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() =>
            fs.writeFile(path.join(dir.path, "package.json"), JSON.stringify({ scripts: { test: "bun -e 'process.exit(1)'" } })),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ]).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-supplied-command",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID, commands: ["bun -e 'process.exit(0)'"] },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(
                    LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  ),
                )
                const node = yield* state.db
                  .select()
                  .from(GraphNodeTable)
                  .where(eq(GraphNodeTable.id, state.targetNodeID))
                  .get()
                  .pipe(Effect.orDie)
                expect(node?.status).not.toBe("verified")
                expect(node?.test_status).not.toBe("passed")
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("applies diagnostics permission rules to detected commands", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() =>
            fs.writeFile(path.join(dir.path, "package.json"), JSON.stringify({ scripts: { test: "bun -e 'process.exit(0)'" } })),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "deny" },
                ]).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-denied",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(
                    LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  ),
                )
                const node = yield* state.db
                  .select()
                  .from(GraphNodeTable)
                  .where(eq(GraphNodeTable.id, state.targetNodeID))
                  .get()
                  .pipe(Effect.orDie)
                expect(node?.status).not.toBe("verified")
                expect(node?.test_status).not.toBe("passed")
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("does not verify a node from a filtered diagnostics subset", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "package.json"),
              JSON.stringify({ scripts: { test: "bun -e 'process.exit(0)'", typecheck: "bun -e 'process.exit(1)'" } }),
            ),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ]).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-filtered",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID, filter: "test" },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(
                    LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  ),
                )
                const node = yield* state.db
                  .select()
                  .from(GraphNodeTable)
                  .where(eq(GraphNodeTable.id, state.targetNodeID))
                  .get()
                  .pipe(Effect.orDie)
                expect(node?.status).not.toBe("verified")
                expect(node?.test_status).not.toBe("passed")
                const workflow = yield* state.db
                  .select()
                  .from(GraphWorkflowStateTable)
                  .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                const evidence = yield* state.db
                  .select()
                  .from(GraphToolRunTable)
                  .where(eq(GraphToolRunTable.node_id, state.targetNodeID))
                  .all()
                  .pipe(Effect.orDie)
                expect(workflow?.current_node_id).toBe(state.targetNodeID)
                expect(evidence.find((record) => record.evidence)?.evidence?.complete).toBe(false)
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("advances atomic workflow only after complete successful diagnostics and records evidence", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() =>
            fs.writeFile(path.join(dir.path, "package.json"), JSON.stringify({ scripts: { test: "bun -e 'process.exit(0)'" } })),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ]).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-complete",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(
                    LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  ),
                )
                const workflow = yield* state.db
                  .select()
                  .from(GraphWorkflowStateTable)
                  .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                const audit = yield* state.db
                  .select()
                  .from(GraphToolRunTable)
                  .where(eq(GraphToolRunTable.node_id, state.targetNodeID))
                  .all()
                  .pipe(Effect.orDie)

                expect(workflow?.current_node_id).toBeNull()
                expect(workflow?.checkpoint_status).toBe("none")
                expect(audit.find((record) => record.tool_name === "graph.diagnostics.run")?.evidence).toMatchObject({
                  kind: "diagnostics",
                  nodeID: state.targetNodeID,
                  projectChecksOnly: true,
                  complete: true,
                  passed: true,
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("runs focused paths before complete diagnostics in the current adapter", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(async () => {
            await fs.mkdir(path.join(dir.path, "test"), { recursive: true })
            await fs.writeFile(path.join(dir.path, "test/focused.test.ts"), 'import { expect, test } from "bun:test"\ntest("focused", () => expect(true).toBe(true))\n')
            await fs.writeFile(path.join(dir.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const verification = {
                  criteria: ["focused behavior passes"],
                  diagnostics: [{ name: "test", paths: ["test/focused.test.ts"] }],
                } as const
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ], verification).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-focused",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
                )
                const node = yield* state.db.select().from(GraphNodeTable).where(eq(GraphNodeTable.id, state.targetNodeID)).get().pipe(Effect.orDie)
                const audit = yield* state.db.select().from(GraphToolRunTable).where(eq(GraphToolRunTable.node_id, state.targetNodeID)).all().pipe(Effect.orDie)
                const evidence = audit.find((record) => record.tool_name === "graph.diagnostics.run")?.evidence
                expect(node).toMatchObject({ status: "verified", test_status: "passed" })
                expect(evidence).toMatchObject({ projectChecksOnly: false, complete: true, passed: true })
                expect(evidence?.commands.map((command) => command.command)).toEqual([
                  "bun run test -- test/focused.test.ts",
                  "bun run test",
                ])
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("blocks a missing focused path before current-adapter command execution", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() => fs.writeFile(path.join(dir.path, "package.json"), JSON.stringify({ scripts: { test: "true" } }))).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ], {
                  criteria: ["focused behavior passes"],
                  diagnostics: [{ name: "test", paths: ["test/missing.test.ts"] }],
                }).pipe(
                  Effect.flatMap((state) =>
                    executeTool(state.registry, {
                      sessionID: state.sessionID,
                      ...toolIdentity,
                      call: {
                        type: "tool-call",
                        id: "call-diagnostics-missing-focused",
                        name: "graph_diagnostics_run",
                        input: { targetNodeID: state.targetNodeID },
                      },
                    }).pipe(Effect.as(state)),
                  ),
                  Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
                )
                const node = yield* state.db.select().from(GraphNodeTable).where(eq(GraphNodeTable.id, state.targetNodeID)).get().pipe(Effect.orDie)
                const audit = yield* state.db.select().from(GraphToolRunTable).where(eq(GraphToolRunTable.node_id, state.targetNodeID)).all().pipe(Effect.orDie)
                expect(node?.status).toBe("implemented")
                expect(audit.find((record) => record.tool_name === "graph.diagnostics.run")).toMatchObject({
                  status: "blocked",
                  output_summary: "verification_path_missing",
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("preserves a pause created while diagnostics are running", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "package.json"),
              JSON.stringify({ scripts: { test: "bun -e 'await Bun.write(\"diagnostics-started\", \"1\"); await Bun.sleep(500)'" } }),
            ),
          ).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const state = yield* setupGraphDiagnostics(dir.path, [
                  { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
                ]).pipe(
                  Effect.flatMap((state) =>
                    Effect.gen(function* () {
                      const run = yield* executeTool(state.registry, {
                        sessionID: state.sessionID,
                        ...toolIdentity,
                        call: {
                          type: "tool-call",
                          id: "call-diagnostics-concurrent-pause",
                          name: "graph_diagnostics_run",
                          input: { targetNodeID: state.targetNodeID },
                        },
                      }).pipe(Effect.forkChild)
                      yield* waitForFile(path.join(dir.path, "diagnostics-started")).pipe(Effect.timeout("2 seconds"))
                      const workflow = yield* state.db
                        .select()
                        .from(GraphWorkflowStateTable)
                        .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                        .get()
                        .pipe(Effect.orDie)
                      yield* state.db
                        .update(GraphWorkflowStateTable)
                        .set({
                          checkpoint_kind: "pause",
                          checkpoint_status: "pending",
                          checkpoint_reason: "user review",
                          revision: (workflow?.revision ?? 0) + 1,
                        })
                        .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                        .run()
                        .pipe(Effect.orDie)
                      yield* Fiber.join(run)
                      return state
                    }),
                  ),
                  Effect.provide(
                    LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
                  ),
                )
                const node = yield* state.db
                  .select()
                  .from(GraphNodeTable)
                  .where(eq(GraphNodeTable.id, state.targetNodeID))
                  .get()
                  .pipe(Effect.orDie)
                const workflow = yield* state.db
                  .select()
                  .from(GraphWorkflowStateTable)
                  .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                expect(node?.status).toBe("implemented")
                expect(node?.test_status).not.toBe("passed")
                expect(workflow).toMatchObject({
                  current_node_id: state.targetNodeID,
                  checkpoint_kind: "pause",
                  checkpoint_status: "pending",
                  checkpoint_reason: "user review",
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("creates a durable failure checkpoint when the diagnostics repair budget is exhausted", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const state = yield* setupGraphDiagnostics(dir.path, [
              { action: "graph.diagnostics_run", resource: "*", effect: "allow" },
            ]).pipe(
              Effect.flatMap((state) =>
                Effect.gen(function* () {
                  yield* state.db.insert(GraphToolRunTable).values([
                    {
                      id: "gtr_failed_1",
                      project_id: ProjectV2.ID.global,
                      session_id: state.sessionID,
                      node_id: state.targetNodeID,
                      tool_name: "graph.diagnostics.run",
                      tool_type: "diagnostics",
                      status: "failed",
                    },
                    {
                      id: "gtr_failed_2",
                      project_id: ProjectV2.ID.global,
                      session_id: state.sessionID,
                      node_id: state.targetNodeID,
                      tool_name: "graph.diagnostics.run",
                      tool_type: "diagnostics",
                      status: "failed",
                    },
                  ]).run().pipe(Effect.orDie)
                  yield* executeTool(state.registry, {
                    sessionID: state.sessionID,
                    ...toolIdentity,
                    call: {
                      type: "tool-call",
                      id: "call-diagnostics-budget-exhausted",
                      name: "graph_diagnostics_run",
                      input: { targetNodeID: state.targetNodeID },
                    },
                  })
                  return state
                }),
              ),
              Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
            )
            const workflow = yield* state.db
              .select()
              .from(GraphWorkflowStateTable)
              .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
              .get()
              .pipe(Effect.orDie)
            expect(workflow?.checkpoint_kind).toBe("failure")
            expect(workflow?.checkpoint_status).toBe("pending")
            expect(workflow?.checkpoint_reason).toContain("previous failed diagnostics")
          }),
        ),
      ),
    ),
  )

  it.live("blocks artifact apply before write permission or filesystem mutation at a checkpoint", () =>
    withGraphMode(
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const outputPath = path.join(dir.path, "src", "blocked.ts")
            yield* setupGraphDiagnostics(dir.path, [
              { action: "graph.artifact_write", resource: "*", effect: "deny" },
            ]).pipe(
              Effect.flatMap((state) =>
                Effect.gen(function* () {
                  yield* state.db
                    .update(GraphWorkflowStateTable)
                    .set({ checkpoint_kind: "pause", checkpoint_status: "pending", revision: 3 })
                    .where(eq(GraphWorkflowStateTable.session_id, state.sessionID))
                    .run()
                    .pipe(Effect.orDie)
                  yield* executeTool(state.registry, {
                    sessionID: state.sessionID,
                    ...toolIdentity,
                    call: {
                      type: "tool-call",
                      id: "call-artifact-blocked-checkpoint",
                      name: "graph_artifact_apply",
                      input: {
                        targetNodeID: state.targetNodeID,
                        artifact: { mode: "full", path: "src/blocked.ts", code: "export const blocked = true\n", test: "test\n" },
                      },
                    },
                  })
                }),
              ),
              Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
            )

            expect(yield* Effect.promise(() => fileExists(outputPath))).toBe(false)
          }),
        ),
      ),
    ),
  )

  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "opencode.json"),
              JSON.stringify({
                providers: {
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})

function withGraphMode<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => process.env.OPENCODE_EXPERIMENTAL_GRAPH_MODE),
    () =>
      Effect.sync(() => {
        process.env.OPENCODE_EXPERIMENTAL_GRAPH_MODE = "1"
      }).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_GRAPH_MODE
        else process.env.OPENCODE_EXPERIMENTAL_GRAPH_MODE = previous
      }),
  )
}

function setupGraphDiagnostics(directory: string, permissions: PermissionV2.Ruleset, verification?: VerificationSpec) {
  return Effect.gen(function* () {
    const state = yield* setupGraphSession(directory)
    yield* (yield* AgentV2.Service).transform((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.permissions = [...permissions]
      }),
    )
    const targetNodeID = GraphStorage.NodeID.create()
    yield* state.db
      .insert(GraphNodeTable)
      .values({
        id: targetNodeID,
        project_id: ProjectV2.ID.global,
        session_id: state.sessionID,
        type: "atomic",
        name: "Diagnostics target",
        level: "L2",
        status: "implemented",
        test_status: "pending",
        verification,
        confidence: 1,
      })
      .run()
      .pipe(Effect.orDie)
    yield* state.db
      .insert(GraphWorkflowStateTable)
      .values({
        session_id: state.sessionID,
        project_id: ProjectV2.ID.global,
        mode: "atomic",
        current_node_id: targetNodeID,
        checkpoint_kind: "atomic",
        checkpoint_scope_node_id: targetNodeID,
        checkpoint_status: "approved",
        revision: 2,
      })
      .run()
      .pipe(Effect.orDie)
    return { ...state, targetNodeID }
  })
}

async function fileExists(file: string) {
  return fs.access(file).then(() => true, () => false)
}

function waitForFile(file: string): Effect.Effect<void> {
  return Effect.promise(() => fileExists(file)).pipe(
    Effect.flatMap((exists) => exists ? Effect.void : Effect.sleep("10 millis").pipe(Effect.andThen(waitForFile(file)))),
  )
}

function setupGraphSession(directory: string) {
  return Effect.gen(function* () {
    const sessionID = SessionV2.ID.create()
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "graph-test",
        directory,
        title: "graph test",
        version: "test",
        agent: "build",
      })
      .run()
      .pipe(Effect.orDie)
    return { registry: yield* ToolRegistry.Service, db, sessionID }
  })
}
