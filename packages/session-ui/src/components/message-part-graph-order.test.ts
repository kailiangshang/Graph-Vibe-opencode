import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { groupParts } from "./message-part-groups"

test("keeps the admitted plan card before subsequent artifact activity in the conversation timeline", () => {
  const part = (id: string, tool: string) =>
    ({
      id,
      sessionID: "ses",
      messageID: "msg",
      type: "tool",
      callID: id,
      tool,
      state: { status: "completed", input: {}, output: "done", title: tool, metadata: {}, time: { start: 1, end: 2 } },
    }) as ToolPart
  const groups = groupParts([
    { messageID: "msg", part: part("part-1", "graph_plan_admit") },
    { messageID: "msg", part: part("part-2", "graph_artifact_apply") },
  ])
  expect(groups).toEqual([
    { key: "part:msg:part-1", type: "part", ref: { messageID: "msg", partID: "part-1" } },
    { key: "part:msg:part-2", type: "part", ref: { messageID: "msg", partID: "part-2" } },
  ])
})
