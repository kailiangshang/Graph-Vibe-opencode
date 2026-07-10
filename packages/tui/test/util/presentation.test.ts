import { afterEach, expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

const original = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (original === undefined) {
    delete process.env.OPENCODE_CLIENT
    return
  }
  process.env.OPENCODE_CLIENT = original
})

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode -s ses_123")
})

test("uses the Graph Vibe continuation command", () => {
  process.env.OPENCODE_CLIENT = "graph-vibe"

  expect(sessionEpilogue({ title: "A session", sessionID: "ses_123" })).toContain("graph-vibe -s ses_123")
})
