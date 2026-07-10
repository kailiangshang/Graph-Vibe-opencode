import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("CLI product identity", () => {
  cliIt.live("keeps the default OpenCode presentation", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--help"], { env: { OPENCODE_CLIENT: "cli" } })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("OpenCode")
      expect(result.stderr).toContain("opencode [project]")
      expect(result.stderr).not.toContain("Graph Vibe")
      expect(result.stderr).not.toContain("forked from")
    }),
  )

  cliIt.live("presents Graph Vibe throughout top-level help", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--help"], {
        env: { OPENCODE_CLIENT: "graph-vibe", OPENCODE_ENABLE_GRAPH_MODE: "1" },
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("Graph Vibe")
      expect(result.stderr).toContain("Graph-guided development")
      expect(result.stderr).toContain("Powered by OpenCode")
      expect(result.stderr).toContain("graph-vibe [project]")
      expect(result.stderr).toContain("attach to a running Graph Vibe server")
      expect(result.stderr).toContain("run Graph Vibe with a message")
      expect(result.stderr).toContain("upgrade Graph Vibe to the latest or a specific version")
      expect(result.stderr).toContain("uninstall Graph Vibe and remove all related files")
      expect(result.stderr).toContain("starts a headless Graph Vibe server")
      expect(result.stderr).toContain("start Graph Vibe server and open web interface")
      expect(result.stderr).not.toContain("\n  opencode ")
      expect(result.stderr).not.toContain("forked from")
    }),
  )
})
