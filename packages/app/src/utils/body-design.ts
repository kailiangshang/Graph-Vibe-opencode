import { type Accessor, createRenderEffect, onCleanup } from "solid-js"

const classes = ["text-12-regular", "font-(family-name:--font-family-text)", "text-[13px]", "font-[440]"] as const
const bodyDesignOwner = Symbol("body-design-owner")

type BodyDesignTarget = HTMLElement & {
  [bodyDesignOwner]?: { enabled: Accessor<boolean> }
}

export function syncBodyDesignMode(enabled: Accessor<boolean>, target: BodyDesignTarget) {
  const previousOwner = target[bodyDesignOwner]
  const previous = {
    attribute: target.hasAttribute("data-new-layout"),
    classes: classes.map((name) => target.classList.contains(name)),
  }
  const owner = { enabled }
  target[bodyDesignOwner] = owner

  createRenderEffect(() => {
    const value = enabled()
    if (target[bodyDesignOwner] !== owner) return
    applyBodyDesignMode(target, value)
  })

  onCleanup(() => {
    if (target[bodyDesignOwner] !== owner) return
    if (previousOwner) {
      target[bodyDesignOwner] = previousOwner
      applyBodyDesignMode(target, previousOwner.enabled())
      return
    }
    delete target[bodyDesignOwner]
    target.toggleAttribute("data-new-layout", previous.attribute)
    classes.forEach((name, index) => target.classList.toggle(name, previous.classes[index]))
  })
}

function applyBodyDesignMode(target: BodyDesignTarget, enabled: boolean) {
  target.toggleAttribute("data-new-layout", enabled)
  target.classList.toggle("text-12-regular", !enabled)
  target.classList.toggle("font-(family-name:--font-family-text)", enabled)
  target.classList.toggle("text-[13px]", enabled)
  target.classList.toggle("font-[440]", enabled)
}
