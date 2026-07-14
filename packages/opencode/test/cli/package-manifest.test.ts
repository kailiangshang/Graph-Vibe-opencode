import { expect, test } from "bun:test"
import { packageManifests } from "../../script/package-manifest"

test("publishes Graph Vibe without claiming the OpenCode command", () => {
  const manifests = packageManifests("1.2.3", { "opencode-linux-x64": "1.2.3" })

  expect(manifests.opencode.name).toBe("opencode-ai")
  expect(manifests.opencode.bin).toEqual({ opencode: "./bin/opencode.exe" })
  expect(manifests.graphVibe.name).toBe("graph-vibe")
  expect(manifests.graphVibe.bin).toEqual({ "graph-vibe": "./bin/graph-vibe.cjs" })
  expect(manifests.graphVibe.optionalDependencies).toEqual({ "opencode-linux-x64": "1.2.3" })
})
