import { test, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import {
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "blocks Graph Vibe session imports until product migration completes without writing rows",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const sessionID = "ses_cli_import_gate"
      const file = path.join(home, "session.json")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          JSON.stringify({
            info: {
              id: sessionID,
              slug: "cli-import-gate",
              projectID: "global",
              directory: home,
              title: "CLI import gate",
              version: "1.0.0",
              time: { created: 1, updated: 1 },
            },
            messages: [
              {
                info: {
                  id: "msg_cli_import_gate",
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "build",
                  model: { providerID: "test", modelID: "test" },
                },
                parts: [
                  {
                    id: "prt_cli_import_gate",
                    sessionID,
                    messageID: "msg_cli_import_gate",
                    type: "text",
                    text: "blocked",
                  },
                ],
              },
            ],
          }),
        ),
      )

      const env = { OPENCODE_CLIENT: "graph-vibe", OPENCODE_DISABLE_CHANNEL_DB: "1" }
      const result = yield* opencode.spawn(["import", file], { env })
      const databaseResult = yield* opencode.spawn(
        ["db", `SELECT count(*) AS count FROM session WHERE id = '${sessionID}'`, "--format", "json"],
        { env },
      )
      const rows = JSON.parse(databaseResult.stdout) as Array<{ count: number }>

      expect(result.exitCode).not.toBe(0)
      expect(databaseResult.exitCode).toBe(0)
      expect(rows[0]?.count).toBe(0)
    }),
  60_000,
)

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})
