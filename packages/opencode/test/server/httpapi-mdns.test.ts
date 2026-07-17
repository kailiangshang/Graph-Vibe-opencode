import { afterEach, describe, expect, mock, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Product } from "@opencode-ai/core/product"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

type Event =
  | { kind: "publish"; port: number; name: string; host: string }
  | { kind: "unpublishAll" }
  | { kind: "destroy" }
const events: Event[] = []
let publishError = false
const transportErrorCallbacks: Array<(error: Error) => void> = []

void mock.module("bonjour-service", () => ({
  Bonjour: class {
    constructor(_opts?: unknown, errorCallback?: (error: Error) => void) {
      if (errorCallback) transportErrorCallbacks.push(errorCallback)
    }
    publish(opts: { port: number; name: string; host: string }) {
      if (publishError) throw new Error("publish failed")
      events.push({ kind: "publish", port: opts.port, name: opts.name, host: opts.host })
      return { on: () => {} }
    }
    unpublishAll() {
      events.push({ kind: "unpublishAll" })
    }
    destroy() {
      events.push({ kind: "destroy" })
    }
  },
}))

// Import Server AFTER the mock so the MDNS module picks up the stub.
const { Server } = await import("../../src/server/server")
const { MDNS } = await import("../../src/server/mdns")

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  client: process.env.OPENCODE_CLIENT,
}

afterEach(async () => {
  MDNS.unpublish()
  events.length = 0
  publishError = false
  transportErrorCallbacks.length = 0
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  if (original.client === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = original.client
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi Server.listen mDNS", () => {
  test("skips publish for loopback hostnames", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: true })
    try {
      expect(events.filter((e) => e.kind === "publish")).toEqual([])
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping loopback mdns listener")
    }
    expect(events.filter((e) => e.kind === "publish")).toEqual([])
  })

  test("publishes for non-loopback hostnames and unpublishes on stop", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    try {
      const published = events.filter((e) => e.kind === "publish")
      expect(published.length).toBe(1)
      expect(published[0]!.port).toBe(listener.port)
      expect(published[0]!.name).toBe(`opencode-${listener.port}`)
      expect(published[0]!.host).toBe("opencode.local")
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping mdns listener")
    }
    expect(events.some((e) => e.kind === "unpublishAll")).toBe(true)
    expect(events.some((e) => e.kind === "destroy")).toBe(true)
  })

  test("publishes the Graph Vibe service identity", async () => {
    process.env.OPENCODE_CLIENT = "graph-vibe"
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    try {
      expect(events.filter((event) => event.kind === "publish")).toEqual([
        {
          kind: "publish",
          port: listener.port,
          name: `graph-vibe-${listener.port}`,
          host: "graph-vibe.local",
        },
      ])
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping Graph Vibe mdns listener")
    }
  })

  test("republishes the same port when the product identity changes", () => {
    delete process.env.OPENCODE_CLIENT
    MDNS.publish(Product.OpenCode, 45123)
    process.env.OPENCODE_CLIENT = "graph-vibe"
    MDNS.publish(Product.GraphVibe, 45123)

    expect(events.filter((event) => event.kind === "publish")).toEqual([
      { kind: "publish", port: 45123, name: "opencode-45123", host: "opencode.local" },
      { kind: "publish", port: 45123, name: "graph-vibe-45123", host: "graph-vibe.local" },
    ])
  })

  test("destroys a failed publication before allowing retry", () => {
    publishError = true
    MDNS.publish(Product.OpenCode, 45123)
    expect(events).toEqual([{ kind: "destroy" }])

    publishError = false
    MDNS.publish(Product.OpenCode, 45123)
    expect(events.at(-1)).toEqual({
      kind: "publish",
      port: 45123,
      name: "opencode-45123",
      host: "opencode.local",
    })
  })

  test("transfers ownership when an identical publication is deduplicated", () => {
    const disposeOlder = MDNS.publish(Product.OpenCode, 45123)
    const disposeNewer = MDNS.publish(Product.OpenCode, 45123)

    disposeOlder()
    expect(events.filter((event) => event.kind === "unpublishAll")).toEqual([])

    disposeNewer()
    expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(1)
  })

  test("an asynchronous transport error destroys its current publication without throwing", async () => {
    const dispose = MDNS.publish(Product.OpenCode, 45123)
    expect(transportErrorCallbacks).toHaveLength(1)

    await expect(Promise.resolve().then(() => transportErrorCallbacks[0]!(new Error("transport failed")))).resolves.toBe(
      undefined,
    )
    expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(1)
    expect(events.filter((event) => event.kind === "destroy")).toHaveLength(1)

    dispose()
    expect(events.filter((event) => event.kind === "destroy")).toHaveLength(1)
  })

  test("a stale transport callback cannot destroy its replacement", async () => {
    MDNS.publish(Product.OpenCode, 45123)
    const stale = transportErrorCallbacks[0]
    const disposeCurrent = MDNS.publish(Product.GraphVibe, 45124)
    const replacements = events.filter((event) => event.kind === "unpublishAll").length
    expect(stale).toBeDefined()

    await expect(Promise.resolve().then(() => stale!(new Error("stale transport failure")))).resolves.toBe(undefined)
    expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(replacements)

    disposeCurrent()
    expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(replacements + 1)
  })

  test("captures the product before asynchronous listener startup", async () => {
    delete process.env.OPENCODE_CLIENT
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    const pending = Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    process.env.OPENCODE_CLIENT = "graph-vibe"
    const listener = await pending
    try {
      const published = events.filter((event) => event.kind === "publish")
      expect(published.at(-1)?.name).toBe(`opencode-${listener.port}`)
      expect(published.at(-1)?.host).toBe("opencode.local")
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping captured-profile listener")
    }
  })

  test("an older listener cannot unpublish a newer listener", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    delete process.env.OPENCODE_CLIENT
    const older = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    process.env.OPENCODE_CLIENT = "graph-vibe"
    const newer = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    const replacements = events.filter((event) => event.kind === "unpublishAll").length

    try {
      await withTimeout(older.stop(true), 10_000, "timed out stopping older mdns listener")
      expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(replacements)
    } finally {
      await withTimeout(newer.stop(true), 10_000, "timed out stopping newer mdns listener")
      await withTimeout(older.stop(true), 10_000, "timed out re-stopping older mdns listener")
    }

    expect(events.filter((event) => event.kind === "unpublishAll")).toHaveLength(replacements + 1)
  })

  test("scope finalizer unpublishes even if stop() is not called for force-close", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "mdns-secret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    expect(events.filter((e) => e.kind === "publish").length).toBe(1)
    // Plain (graceful) stop without close=true should still unpublish.
    await withTimeout(listener.stop(), 10_000, "timed out stopping graceful mdns listener")
    expect(events.some((e) => e.kind === "unpublishAll")).toBe(true)
  })
})
