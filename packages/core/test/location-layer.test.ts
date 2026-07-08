import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Equal, Hash, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { define } from "@opencode-ai/plugin/v2/effect"
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
              }),
            ),
          ),
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

function setupGraphDiagnostics(directory: string, permissions: PermissionV2.Ruleset) {
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
        confidence: 1,
      })
      .run()
      .pipe(Effect.orDie)
    return { ...state, targetNodeID }
  })
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
