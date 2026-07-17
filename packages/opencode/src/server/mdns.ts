import { Bonjour } from "bonjour-service"
import { Product } from "@opencode-ai/core/product"

let current: { bonjour: Bonjour; identity: string; instance: object; owner: object } | undefined

export function publish(profile: Product.Profile, port: number, domain?: string) {
  const host = domain ?? profile.mdnsDomain
  const name = `${profile.id}-${port}`
  const identity = `${name}:${host}:${port}`
  const owner = {}
  if (current?.identity === identity) {
    current.owner = owner
    return dispose(owner)
  }
  if (current) unpublish()

  const instance = {}
  let bonjour: Bonjour | undefined
  try {
    bonjour = new Bonjour({}, () => {
      try {
        if (current?.instance !== instance) return
        unpublish()
      } catch {}
    })
    const service = bonjour.publish({
      name,
      type: "http",
      host,
      port,
      txt: { path: "/" },
    })

    service.on("error", () => {})

    current = { bonjour, identity, instance, owner }
  } catch {
    if (bonjour) {
      try {
        bonjour.destroy()
      } catch {}
    }
    current = undefined
  }
  return dispose(owner)
}

export function unpublish() {
  if (!current) return
  try {
    current.bonjour.unpublishAll()
    current.bonjour.destroy()
  } catch {}
  current = undefined
}

function dispose(owner: object) {
  return () => {
    if (current?.owner !== owner) return
    unpublish()
  }
}

export * as MDNS from "./mdns"
