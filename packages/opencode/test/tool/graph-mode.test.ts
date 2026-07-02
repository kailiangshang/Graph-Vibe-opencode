import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
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
      expect(ids).toContain("graph_artifact_apply")
      expect(ids).toContain("read")
      expect(ids).toContain("grep")
      expect(ids).toContain("glob")
    }),
  )
})
