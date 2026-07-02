import { afterEach, describe, expect } from "bun:test"
import os from "os"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Instruction } from "@/session/instruction"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const missingGlobal = path.join(os.tmpdir(), "opencode-graph-instruction-missing")

const instructionLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, TestConfig.layer()],
    [Global.node, Global.layerWith({ home: missingGlobal, config: missingGlobal })],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const defaultMode = testEffect(instructionLayer())
const graphMode = testEffect(instructionLayer({ experimentalGraphMode: true }))

afterEach(async () => {
  await disposeAllInstances()
})

describe("graph workflow instructions", () => {
  defaultMode.instance("does not include graph workflow instructions by default", () =>
    Effect.gen(function* () {
      const instruction = yield* Instruction.Service
      const system = (yield* instruction.system()).join("\n")

      expect(system).not.toContain("graph_plan_admit")
      expect(system).not.toContain("graph_build_gate")
      expect(system).not.toContain("graph_artifact_apply")
    }),
  )

  graphMode.instance("includes graph workflow instructions when graph mode is enabled", () =>
    Effect.gen(function* () {
      const instruction = yield* Instruction.Service
      const system = (yield* instruction.system()).join("\n")

      expect(system).toContain("graph_plan_admit")
      expect(system).toContain("graph_build_gate")
      expect(system).toContain("graph_artifact_apply")
      expect(system).toContain("Build gate")
    }),
  )
})
