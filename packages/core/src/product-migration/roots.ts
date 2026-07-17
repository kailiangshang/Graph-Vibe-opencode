export * as ProductMigrationSourceRoots from "./roots"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { Product } from "../product"

export interface Roots {
  readonly id: string
  readonly data: string
  readonly config: string
  readonly state: string
  readonly database: string
}

export class NotAllowed extends Schema.TaggedErrorClass<NotAllowed>()("ProductMigrationSourceRootNotAllowed", {
  id: Schema.String,
}) {}

export interface Interface {
  readonly resolve: (id?: string) => Effect.Effect<Roots, NotAllowed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProductMigrationSourceRoots") {}

export function layerWith(roots: ReadonlyArray<Roots>, defaultID = roots[0]?.id) {
  return Layer.succeed(
    Service,
    Service.of({
      resolve: (id) => {
        const requested = id ?? defaultID
        const root = roots.find((candidate) => candidate.id === requested)
        return root ? Effect.succeed(root) : Effect.fail(new NotAllowed({ id: requested ?? "" }))
      },
    }),
  )
}

const paths = Global.paths(Product.OpenCode)
export const layer = layerWith([
  {
    id: "native",
    data: paths.data,
    config: paths.config,
    state: paths.state,
    database: path.join(paths.data, Product.OpenCode.database),
  },
])

export const node = LayerNode.make({ service: Service, layer, deps: [] })
