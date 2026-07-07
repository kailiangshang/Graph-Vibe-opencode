import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer, Result, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([ToolRegistry.node, Agent.node])

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    [Database.node, Database.layerFromPath(":memory:")],
  ])

const defaultMode = testEffect(layer())
const graphMode = testEffect(layer({ experimentalGraphMode: true }))
const customPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            custom_graph_tool: {
              description: "custom plugin tool that graph mode must not expose",
              args: {},
              execute: async () => "custom",
            },
          },
        },
      ]),
  }),
)
const graphModeWithCustomTool = testEffect(
  LayerNode.compile(root, [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalGraphMode: true })],
    [Database.node, Database.layerFromPath(":memory:")],
    [Plugin.node, customPluginLayer],
  ]),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("graph mode tool registry", () => {
  defaultMode.instance("keeps default writable tools and hides graph tools by default", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("bash")
      expect(ids).toContain("edit")
      expect(ids).toContain("write")
      expect(ids).toContain("apply_patch")
      expect(ids).not.toContain("graph_plan_admit")
      expect(ids).not.toContain("graph_build_gate")
      expect(ids).not.toContain("graph_artifact_apply")
    }),
  )

  graphMode.instance("replaces raw write and exec tools with graph tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("bash")
      expect(ids).not.toContain("edit")
      expect(ids).not.toContain("write")
      expect(ids).not.toContain("apply_patch")
      expect(ids).toContain("graph_plan_admit")
      expect(ids).toContain("graph_build_gate")
      expect(ids).toContain("graph_artifact_begin")
      expect(ids).toContain("graph_artifact_chunk")
      expect(ids).toContain("graph_artifact_seal")
      expect(ids).toContain("graph_artifact_apply")
      expect(ids).toContain("read")
      expect(ids).toContain("grep")
      expect(ids).toContain("glob")
    }),
  )

  graphMode.instance("exposes files artifacts in graph build gate parameters", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const buildGate = tools.find((tool) => tool.id === "graph_build_gate")
      if (!buildGate) throw new Error("graph_build_gate was not registered")

      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(buildGate.parameters)({
            targetNodeID: GraphStorage.NodeID.create(),
            artifact: {
              mode: "files",
              test: "bun test\n",
              files: [{ path: "src/a.ts", code: "export const a = 1\n" }],
            },
          }),
        ),
      ).toBe(true)
    }),
  )

  graphModeWithCustomTool.instance("excludes custom plugin tools from graph mode", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(ids).not.toContain("custom_graph_tool")
      expect(tools.map((tool) => tool.id)).not.toContain("custom_graph_tool")
      expect(ids).toContain("graph_artifact_apply")
    }),
  )
})
