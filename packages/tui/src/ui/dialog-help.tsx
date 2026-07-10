import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Product } from "@opencode-ai/core/product"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Press {commandShortcut()} to see all available actions and commands in any context.
        </text>
      </box>
      {Flag.OPENCODE_EXPERIMENTAL_GRAPH_MODE && (
        <box paddingBottom={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Graph Workflow
          </text>
          <text fg={theme.textMuted}>/graph workflow guide</text>
          <text fg={theme.textMuted}>/graph-start create a guided task draft</text>
          <text fg={theme.textMuted}>/graph-status inspect Current Plan progress</text>
          <text fg={theme.textMuted}>/graph-open open the session graph in Web</text>
          {Product.current().attribution && <text fg={theme.textMuted}>{Product.current().attribution}</text>}
        </box>
      )}
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
