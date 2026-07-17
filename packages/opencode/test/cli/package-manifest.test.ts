import { expect, test } from "bun:test"
import { packageManifests } from "../../script/package-manifest"

test("publishes each product with only its own platform packages", () => {
  const binaries = Object.fromEntries(
    [
      "opencode-linux-arm64",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
      "opencode-linux-arm64-musl",
      "opencode-linux-x64-musl",
      "opencode-linux-x64-baseline-musl",
      "opencode-darwin-arm64",
      "opencode-darwin-x64",
      "opencode-darwin-x64-baseline",
      "opencode-windows-arm64",
      "opencode-windows-x64",
      "opencode-windows-x64-baseline",
    ].map((name) => [name, "1.2.3"]),
  )
  const manifests = packageManifests("1.2.3", {
    ...binaries,
    unrelated: "1.2.3",
    "opencode-linux-x64/../../escaped": "1.2.3",
  })

  expect(manifests.opencode.name).toBe("opencode-ai")
  expect(manifests.opencode.bin).toEqual({ opencode: "./bin/opencode.exe" })
  expect(manifests.opencode.optionalDependencies).toEqual(binaries)
  expect(manifests.graphVibe.name).toBe("graph-vibe")
  expect(manifests.graphVibe.bin).toEqual({ "graph-vibe": "./bin/graph-vibe.cjs" })
  expect(manifests.graphVibe.optionalDependencies).toEqual(
    Object.fromEntries(Object.keys(binaries).map((name) => [name.replace(/^opencode-/, "graph-vibe-"), "1.2.3"])),
  )
  expect(Object.keys(manifests.graphVibe.optionalDependencies).every((name) => name.startsWith("graph-vibe-"))).toBe(
    true,
  )
})
