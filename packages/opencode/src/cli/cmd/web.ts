import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { Product } from "@opencode-ai/core/product"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: `start ${Product.commandName()} server and open web interface`,
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const { runSourceWeb, sourceWebPlan, sourceWebRoot } = yield* Effect.promise(() => import("./web-source"))
    const sourceRoot = sourceWebRoot(Product.current().id, process.env.OPENCODE_GRAPH_VIBE_SOURCE_ROOT)
    if (sourceRoot) {
      const requestedUiPort = Number.parseInt(process.env.OPENCODE_GRAPH_VIBE_UI_PORT ?? "4444", 10)
      const input = {
        sourceRoot,
        directory: process.env.OPENCODE_INITIAL_DIRECTORY ?? process.cwd(),
        hostname: opts.hostname,
        port: opts.port,
        uiPort: Number.isFinite(requestedUiPort) && requestedUiPort > 0 ? requestedUiPort : 4444,
        mdns: opts.mdns,
        mdnsDomain: opts.mdnsDomain,
        cors: opts.cors,
        env: process.env,
      }
      const plan = sourceWebPlan(input)
      UI.empty()
      UI.println(UI.logo("  "))
      UI.empty()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, plan.webUrl)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Backend:          ", UI.Style.TEXT_NORMAL, plan.backendUrl)
      yield* Effect.promise(() => runSourceWeb(input))
      return
    }

    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
