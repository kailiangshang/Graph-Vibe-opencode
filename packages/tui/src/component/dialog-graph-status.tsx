import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import type { summarizeCurrentPlan } from "../graph/workflow"

export function DialogGraphStatus(props: { summary: ReturnType<typeof summarizeCurrentPlan> }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close status", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close status", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.primary}>
          Graph Status
        </text>
        <text fg={theme.textMuted}>esc/enter</text>
      </box>
      <Show
        when={props.summary.total > 0}
        fallback={<text fg={theme.textMuted}>Current Plan is empty. Describe your goal or run /graph-start.</text>}
      >
        <box>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Current Plan · {props.summary.total} nodes
          </text>
          <For each={props.summary.nodes}>
            {([label, count]) => (
              <text fg={theme.textMuted}>
                {label}: {count}
              </text>
            )}
          </For>
        </box>
        <box>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Diagnostics
          </text>
          <For each={props.summary.diagnostics}>
            {([label, count]) => (
              <text fg={theme.textMuted}>
                {label}: {count}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
