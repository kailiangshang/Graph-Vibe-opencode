import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import { formatWorkflowStatus, type Workflow, workflowActions } from "../graph/workflow"

export function DialogGraphStatus(props: {
  workflow: Workflow
  conflict?: string
  onContinue?: () => void
  onPause?: () => void
}) {
  const dialog = useDialog()
  return <GraphStatusView {...props} onClose={() => dialog.clear()} />
}

export function GraphStatusView(props: {
  workflow: Workflow
  conflict?: string
  onContinue?: () => unknown
  onPause?: () => unknown
  onClose: () => void
}) {
  const { theme } = useTheme()
  const [local, setLocal] = createStore({ pending: undefined as "continue" | "pause" | undefined })
  const status = () => formatWorkflowStatus(props.workflow)
  const run = async (kind: "continue" | "pause", action: (() => unknown) | undefined) => {
    if (local.pending || !action) return
    setLocal("pending", kind)
    try {
      await action()
    } finally {
      setLocal("pending", undefined)
    }
  }

  useBindings(() => ({
    bindings: [
      ...(workflowActions(props.workflow).continue && !local.pending
        ? [{ key: "c", desc: "Continue", group: "Workflow", cmd: () => run("continue", props.onContinue) }]
        : []),
      ...(workflowActions(props.workflow).pause && !local.pending
        ? [{ key: "p", desc: "Pause", group: "Workflow", cmd: () => run("pause", props.onPause) }]
        : []),
      { key: "return", desc: "Close status", group: "Dialog", cmd: props.onClose },
      { key: "escape", desc: "Close status", group: "Dialog", cmd: props.onClose },
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
      <box flexDirection="row" gap={2}>
        <text fg={theme.text}>Mode: {status().mode}</text>
        <text fg={theme.text}>Phase: {status().phase}</text>
        <text fg={theme.text}>Progress: {status().progress}</text>
      </box>
      <Show when={props.conflict}>
        <box border={["left"]} borderColor={theme.warning} paddingLeft={1}>
          <text fg={theme.warning}>{props.conflict}</text>
          <text fg={theme.text}>Review refreshed status, then press the action key again.</text>
        </box>
      </Show>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Current task: {status().current}
      </text>
      <Show when={props.workflow.checkpoint.status === "pending"}>
        <box border={["left"]} borderColor={theme.warning} paddingLeft={1}>
          <text fg={theme.warning}>{status().checkpoint}</text>
          <text fg={theme.text}>{status().nextAction}</text>
        </box>
      </Show>
      <For each={status().modules}>
        {(module) => (
          <box>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              {module.name} · {module.progress}
            </text>
            <For each={module.tasks}>{(task) => <text fg={theme.textMuted}> {task}</text>}</For>
          </box>
        )}
      </For>
      <box flexDirection="row" gap={2}>
        <Show when={local.pending === "continue"}>
          <text fg={theme.primary}>Continuing...</text>
        </Show>
        <Show when={local.pending === "pause"}>
          <text fg={theme.primary}>Pausing...</text>
        </Show>
        <Show when={workflowActions(props.workflow).continue && !local.pending}>
          <text fg={theme.primary}>c Continue</text>
        </Show>
        <Show when={workflowActions(props.workflow).pause && !local.pending}>
          <text fg={theme.primary}>p Pause</text>
        </Show>
      </box>
    </box>
  )
}
