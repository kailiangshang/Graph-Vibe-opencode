import { expect, test } from "bun:test"
import { isTargetScopedRoute } from "./route-scope"

test("recognizes exact target route segments with trailing-slash normalization", () => {
  expect(isTargetScopedRoute("/new-session")).toBe(true)
  expect(isTargetScopedRoute("/new-session/")).toBe(true)
  expect(isTargetScopedRoute("/new-session///")).toBe(true)
  expect(isTargetScopedRoute("/server/key/session/id")).toBe(true)

  expect(isTargetScopedRoute("/new-session-extra")).toBe(false)
  expect(isTargetScopedRoute("/new-session/child")).toBe(false)
  expect(isTargetScopedRoute("/serverish/key/session/id")).toBe(false)
})
