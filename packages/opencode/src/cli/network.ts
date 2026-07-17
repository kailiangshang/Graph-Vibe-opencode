import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Config } from "@/config/config"
import { Effect } from "effect"
import { Product } from "@opencode-ai/core/product"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  const profile = Product.current()
  return yargs.options({
    ...options,
    "mdns-domain": {
      ...options["mdns-domain"],
      describe: `custom domain name for mDNS service (default: ${profile.mdnsDomain})`,
      default: profile.mdnsDomain,
    },
  })
}

export function hasArg(name: string) {
  return hasArgIn(networkArgs(), name)
}

function hasArgIn(args: string[], name: string) {
  return args.some((arg) => arg === name || arg.startsWith(name + "="))
}

function hasBooleanArg(args: string[], name: string) {
  return args.some(
    (arg) => arg === name || arg === name + "=true" || arg === name + "=false" || arg === "--no-" + name.slice(2),
  )
}

function networkArgs() {
  const separator = process.argv.indexOf("--")
  return process.argv.slice(2, separator === -1 ? undefined : separator)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

export function resolveNetworkOptionsNoConfig(
  args: NetworkOptions,
  config?: ConfigV1.Info,
  input?: { profile?: Product.Profile; argv?: string[] },
) {
  const argv = input?.argv ?? networkArgs()
  const profile = input?.profile ?? Product.current()
  const portExplicitlySet = hasArgIn(argv, "--port")
  const hostnameExplicitlySet = hasArgIn(argv, "--hostname")
  const mdnsExplicitlySet = hasBooleanArg(argv, "--mdns")
  const mdnsDomainExplicitlySet = hasArgIn(argv, "--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet
    ? args["mdns-domain"]
    : (config?.server?.mdnsDomain ?? profile.mdnsDomain)
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors }
}
