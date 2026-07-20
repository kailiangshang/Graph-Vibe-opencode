import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { syncBodyDesignMode } from "@/utils/body-design"

test("updates body design mode reactively and restores its initial state", () => {
  document.body.className = "host text-12-regular"
  document.body.removeAttribute("data-new-layout")

  const state = createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(false)
    syncBodyDesignMode(enabled, document.body)
    return { dispose, setEnabled }
  })

  expect(mode()).toEqual({ enabled: false, legacy: true, family: false, size: false, weight: false })
  state.setEnabled(true)
  expect(mode()).toEqual({ enabled: true, legacy: false, family: true, size: true, weight: true })

  state.dispose()
  expect(document.body.className).toBe("host text-12-regular")
  expect(document.body.hasAttribute("data-new-layout")).toBe(false)
})

test("nested body design ownership blocks outer updates and restores the latest outer mode", () => {
  document.body.className = ""
  document.body.removeAttribute("data-new-layout")

  const outer = createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(false)
    syncBodyDesignMode(enabled, document.body)
    return { dispose, setEnabled }
  })
  const inner = createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(true)
    syncBodyDesignMode(enabled, document.body)
    return { dispose, setEnabled }
  })

  outer.setEnabled(true)
  outer.setEnabled(false)
  expect(mode()).toEqual({ enabled: true, legacy: false, family: true, size: true, weight: true })
  inner.setEnabled(false)
  expect(mode()).toEqual({ enabled: false, legacy: true, family: false, size: false, weight: false })
  inner.setEnabled(true)

  inner.dispose()
  expect(mode()).toEqual({ enabled: false, legacy: true, family: false, size: false, weight: false })
  outer.setEnabled(true)
  expect(mode()).toEqual({ enabled: true, legacy: false, family: true, size: true, weight: true })
  outer.setEnabled(false)
  expect(mode()).toEqual({ enabled: false, legacy: true, family: false, size: false, weight: false })
  outer.dispose()
})

function mode() {
  return {
    enabled: document.body.hasAttribute("data-new-layout"),
    legacy: document.body.classList.contains("text-12-regular"),
    family: document.body.classList.contains("font-(family-name:--font-family-text)"),
    size: document.body.classList.contains("text-[13px]"),
    weight: document.body.classList.contains("font-[440]"),
  }
}
