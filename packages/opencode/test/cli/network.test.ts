import { describe, expect, test } from "bun:test"
import { Product } from "@opencode-ai/core/product"
import { resolveNetworkOptionsNoConfig } from "../../src/cli/network"

const defaults = {
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "opencode.local",
  cors: [],
}

describe("resolveNetworkOptionsNoConfig", () => {
  test("uses the selected product network identity by default", () => {
    expect(resolveNetworkOptionsNoConfig(defaults, undefined, { profile: Product.OpenCode, argv: [] })).toEqual({
      hostname: "127.0.0.1",
      port: 0,
      mdns: false,
      mdnsDomain: "opencode.local",
      cors: [],
    })
    expect(resolveNetworkOptionsNoConfig(defaults, undefined, { profile: Product.GraphVibe, argv: [] })).toEqual({
      hostname: "127.0.0.1",
      port: 0,
      mdns: false,
      mdnsDomain: "graph-vibe.local",
      cors: [],
    })
  })

  test("keeps config above product defaults", () => {
    expect(
      resolveNetworkOptionsNoConfig(
        defaults,
        {
          server: {
            port: 7000,
            hostname: "config-host",
            mdns: true,
            mdnsDomain: "config.local",
            cors: ["https://config.example"],
          },
        },
        { profile: Product.GraphVibe, argv: [] },
      ),
    ).toEqual({
      hostname: "config-host",
      port: 7000,
      mdns: true,
      mdnsDomain: "config.local",
      cors: ["https://config.example"],
    })
  })

  test("keeps explicit CLI values above config", () => {
    expect(
      resolveNetworkOptionsNoConfig(
        {
          port: 8000,
          hostname: "cli-host",
          mdns: false,
          "mdns-domain": "cli.local",
          cors: ["https://cli.example"],
        },
        {
          server: {
            port: 7000,
            hostname: "config-host",
            mdns: true,
            mdnsDomain: "config.local",
            cors: ["https://config.example"],
          },
        },
        {
          profile: Product.GraphVibe,
          argv: ["--port", "8000", "--hostname=cli-host", "--no-mdns", "--mdns-domain", "cli.local"],
        },
      ),
    ).toEqual({
      hostname: "cli-host",
      port: 8000,
      mdns: false,
      mdnsDomain: "cli.local",
      cors: ["https://config.example", "https://cli.example"],
    })
  })
})
