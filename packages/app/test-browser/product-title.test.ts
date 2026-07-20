import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { syncProductDocumentTitle } from "@/context/product"
import { resolveProductPresentation } from "@/utils/product-presentation"

const graphVibe = {
  id: "graph-vibe" as const,
  name: "Graph Vibe",
  capability: "Graph-guided development",
}

test("updates the title reactively and restores it on disposal", () => {
  document.title = "Host"

  const state = createRoot((dispose) => {
    const [product, setProduct] = createSignal(resolveProductPresentation(undefined))
    syncProductDocumentTitle(product, document)
    return { dispose, setProduct }
  })

  expect(document.title).toBe("OpenCode")
  state.setProduct(graphVibe)
  expect(document.title).toBe("Graph Vibe")

  state.dispose()
  expect(document.title).toBe("Host")
})

test("outer title stays reactive after the inner owner is disposed", () => {
  document.title = "Host"

  const outer = createRoot((dispose) => {
    const [product, setProduct] = createSignal(graphVibe)
    syncProductDocumentTitle(product, document)
    return { dispose, setProduct }
  })
  expect(document.title).toBe("Graph Vibe")

  const inner = createRoot((dispose) => {
    syncProductDocumentTitle(() => resolveProductPresentation(undefined), document)
    return { dispose }
  })
  expect(document.title).toBe("OpenCode")

  outer.setProduct({ ...graphVibe, name: "Graph Vibe Updated" })
  expect(document.title).toBe("OpenCode")

  inner.dispose()
  expect(document.title).toBe("Graph Vibe Updated")

  outer.setProduct({ ...graphVibe, name: "Graph Vibe Current" })
  expect(document.title).toBe("Graph Vibe Current")

  outer.dispose()
  expect(document.title).toBe("Host")
})
