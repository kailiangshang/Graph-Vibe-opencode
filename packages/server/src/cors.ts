import { Context } from "effect"

const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.some((origin) => origin === input || matchesLocalNetworkOrigin(input, origin)) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function matchesLocalNetworkOrigin(input: string, pattern: string) {
  try {
    const actual = new URL(input)
    const expected = new URL(pattern)
    return (
      expected.hostname === "local-network" &&
      actual.origin === input &&
      actual.protocol === expected.protocol &&
      actual.port === expected.port &&
      isLocalNetworkHostname(actual.hostname)
    )
  } catch {
    return false
  }
}

function isLocalNetworkHostname(input: string) {
  const hostname = input.toLowerCase().replace(/^\[|\]$/g, "")
  if (hostname.endsWith(".local")) return true
  if (hostname.includes(":")) {
    const first = Number.parseInt(hostname.split(":", 1)[0] || "0", 16)
    return hostname === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  )
}
