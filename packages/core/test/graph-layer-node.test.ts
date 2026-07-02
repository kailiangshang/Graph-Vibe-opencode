import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GraphDomain } from "@opencode-ai/core/graph/domain"
import { GraphStorage } from "@opencode-ai/core/graph/storage"
import { GraphAudit } from "@opencode-ai/core/graph/workflow/audit"
import { GraphBuild } from "@opencode-ai/core/graph/workflow/build"
import { GraphPlan } from "@opencode-ai/core/graph/workflow/plan"

describe("graph LayerNode wiring", () => {
  test("graph workflow nodes compile", () => {
    expect(() =>
      LayerNode.compile(
        LayerNode.group([GraphStorage.node, GraphDomain.node, GraphAudit.node, GraphPlan.node, GraphBuild.node]),
      ),
    ).not.toThrow()
  })
})
