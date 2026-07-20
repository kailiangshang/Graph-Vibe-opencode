import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, createRenderEffect, onCleanup } from "solid-js"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type ProductPresentation, resolveProductPresentation } from "@/utils/product-presentation"
import type { ServerHealth } from "@/utils/server-health"

export function createProductState(
  serverKey: Accessor<ServerConnection.Key>,
  health: Accessor<Record<ServerConnection.Key, ServerHealth | undefined>>,
) {
  const product = () => resolveProductPresentation(health()[serverKey()]?.product)

  return {
    product,
    graphVibe: () => product().id === "graph-vibe",
  }
}

const productTitleOwner = Symbol("product-title-owner")
type ProductTitleTarget = {
  title: string
  [productTitleOwner]?: { product: Accessor<ProductPresentation> }
}

export function syncProductDocumentTitle(product: Accessor<ProductPresentation>, target: ProductTitleTarget) {
  const previousOwner = target[productTitleOwner]
  const previousTitle = target.title
  const owner = { product }
  target[productTitleOwner] = owner
  createRenderEffect(() => {
    const value = product()
    if (target[productTitleOwner] !== owner) return
    target.title = value.name
  })
  onCleanup(() => {
    if (target[productTitleOwner] !== owner) return
    if (previousOwner) {
      target[productTitleOwner] = previousOwner
      target.title = previousOwner.product().name
      return
    }
    delete target[productTitleOwner]
    target.title = previousTitle
  })
}

export const { use: useProduct, provider: ProductProvider } = createSimpleContext({
  name: "Product",
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const server = useServer()
    const product = createProductState(
      () => {
        const conn = props.server?.()
        return conn ? ServerConnection.key(conn) : server.key
      },
      () => global.servers.health,
    )
    if (typeof document !== "undefined") syncProductDocumentTitle(product.product, document)
    return product
  },
})
