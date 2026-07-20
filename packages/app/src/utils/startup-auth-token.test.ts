import { describe, expect, test } from "bun:test"
import { resolveStartupAuthToken } from "./startup-auth-token"

const firstToken = btoa("opencode:first-value")
const secondToken = btoa("opencode:second-value")
const firstServer = "https://first.example.test"
const secondServer = "https://second.example.test"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null
      },
      setItem(key: string, value: string) {
        values.set(key, value)
      },
      removeItem(key: string) {
        values.delete(key)
      },
    },
  }
}

describe("resolveStartupAuthToken", () => {
  test("persists an explicit token in session storage", () => {
    const memory = memoryStorage()

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams({ auth_token: firstToken }),
        storage: () => memory.storage,
      }) === firstToken,
    ).toBe(true)
    expect(memory.values.size).toBe(1)
    expect([...memory.values.values()][0] === firstToken).toBe(true)
  })

  test("restores only the token stored for the resolved server", () => {
    const memory = memoryStorage()
    resolveStartupAuthToken({
      serverUrl: firstServer,
      search: new URLSearchParams({ auth_token: firstToken }),
      storage: () => memory.storage,
    })

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams(),
        storage: () => memory.storage,
      }) === firstToken,
    ).toBe(true)
    expect(
      resolveStartupAuthToken({
        serverUrl: secondServer,
        search: new URLSearchParams(),
        storage: () => memory.storage,
      }),
    ).toBeUndefined()
  })

  test("prefers an explicit token over the stored token", () => {
    const memory = memoryStorage()
    resolveStartupAuthToken({
      serverUrl: firstServer,
      search: new URLSearchParams({ auth_token: firstToken }),
      storage: () => memory.storage,
    })

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams({ auth_token: secondToken }),
        storage: () => memory.storage,
      }) === secondToken,
    ).toBe(true)
    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams(),
        storage: () => memory.storage,
      }) === secondToken,
    ).toBe(true)
  })

  test("clears the matching stored token for an empty explicit token", () => {
    const memory = memoryStorage()
    resolveStartupAuthToken({
      serverUrl: firstServer,
      search: new URLSearchParams({ auth_token: firstToken }),
      storage: () => memory.storage,
    })

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams("auth_token="),
        storage: () => memory.storage,
      }),
    ).toBeUndefined()
    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams(),
        storage: () => memory.storage,
      }),
    ).toBeUndefined()
  })

  test("clears the matching stored token for a malformed explicit token", () => {
    const memory = memoryStorage()
    resolveStartupAuthToken({
      serverUrl: firstServer,
      search: new URLSearchParams({ auth_token: firstToken }),
      storage: () => memory.storage,
    })
    resolveStartupAuthToken({
      serverUrl: secondServer,
      search: new URLSearchParams({ auth_token: secondToken }),
      storage: () => memory.storage,
    })

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams({ auth_token: "malformed" }),
        storage: () => memory.storage,
      }),
    ).toBeUndefined()
    expect(
      resolveStartupAuthToken({
        serverUrl: secondServer,
        search: new URLSearchParams(),
        storage: () => memory.storage,
      }) === secondToken,
    ).toBe(true)
  })

  test("uses an explicit token when session storage access throws", () => {
    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams({ auth_token: firstToken }),
        storage: () => {
          throw new DOMException("Unavailable", "SecurityError")
        },
      }) === firstToken,
    ).toBe(true)
  })

  test("does not fail when session storage operations throw", () => {
    const storage = {
      getItem(_key: string): string | null {
        throw new DOMException("Unavailable", "SecurityError")
      },
      setItem(_key: string, _value: string) {
        throw new DOMException("Unavailable", "SecurityError")
      },
      removeItem(_key: string) {
        throw new DOMException("Unavailable", "SecurityError")
      },
    }

    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams({ auth_token: firstToken }),
        storage: () => storage,
      }) === firstToken,
    ).toBe(true)
    expect(
      resolveStartupAuthToken({
        serverUrl: firstServer,
        search: new URLSearchParams(),
        storage: () => storage,
      }),
    ).toBeUndefined()
  })
})
