import { For, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { GRAPH_MODES } from "../graph/workflow"

export function DialogGraphMode(props: { onSelect: (mode: "atomic" | "module" | "autopilot") => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [index, setIndex] = createSignal(1)
  const select = () => {
    props.onSelect(GRAPH_MODES[index()].value)
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "up", desc: "Previous mode", group: "Dialog", cmd: () => setIndex((value) => (value + 2) % 3) },
      { key: "down", desc: "Next mode", group: "Dialog", cmd: () => setIndex((value) => (value + 1) % 3) },
      { key: "return", desc: "Select mode", group: "Dialog", cmd: select },
      { key: "escape", desc: "Cancel", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.primary}>
        Choose execution mode
      </text>
      <text fg={theme.textMuted}>Controls when implementation pauses for your review.</text>
      <For each={GRAPH_MODES}>
        {(mode, item) => (
          <box paddingLeft={1} border={item() === index() ? ["left"] : undefined} borderColor={theme.primary}>
            <text fg={item() === index() ? theme.text : theme.textMuted}>
              {item() === index() ? "› " : "  "}
              {mode.label}
              {"recommended" in mode ? " (recommended)" : ""} · {mode.description}
            </text>
          </box>
        )}
      </For>
      <text fg={theme.textMuted}>↑/↓ choose · enter start · esc cancel</text>
    </box>
  )
}
