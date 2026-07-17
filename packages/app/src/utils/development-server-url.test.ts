import { describe, expect, test } from "bun:test"
import { developmentServerUrl } from "./development-server-url"

describe("developmentServerUrl", () => {
  test("uses the page hostname when the backend binds all interfaces", () => {
    expect(developmentServerUrl("0.0.0.0", "4096", "http://192.168.1.20:4444")).toBe("http://192.168.1.20:4096")
    expect(developmentServerUrl("::", "4096", "http://[2001:db8::1]:4444")).toBe("http://[2001:db8::1]:4096")
  })

  test("preserves an explicit backend host", () => {
    expect(developmentServerUrl("[::1]", "5123", "http://localhost:4444")).toBe("http://[::1]:5123")
  })
})
