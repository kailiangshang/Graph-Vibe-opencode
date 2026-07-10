import { TextAttributes } from "@opentui/core"
import { Product } from "@opencode-ai/core/product"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"

export function DialogGraphGuide() {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close guide", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close guide", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.primary}>
          Graph Workflow
        </text>
        <text fg={theme.textMuted}>esc/enter</text>
      </box>
      <text fg={theme.text}>1. Describe the outcome you want in normal language.</text>
      <text fg={theme.text}>2. {Product.current().name} creates and validates a plan.</text>
      <text fg={theme.text}>3. Inspect implementation progress with /graph-status.</text>
      <text fg={theme.text}>4. Completion requires diagnostics to pass.</text>
      <text fg={theme.textMuted}>Start with /graph-start · {Product.current().attribution}</text>
    </box>
  )
}
