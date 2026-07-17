import { For, Show } from "solid-js"
import { graphPlanCard } from "./graph-activity"

export function GraphPlanCard(props: { card: ReturnType<typeof graphPlanCard> }) {
  return (
    <div data-component="graph-plan-card" class="space-y-3 p-3">
      <div>
        <div class="text-12-medium text-text-weak">Goal</div>
        <div class="text-13-regular text-text-strong">{props.card.goal}</div>
      </div>
      <div class="flex flex-wrap gap-3 text-12-regular text-text-base">
        <span>Mode: {props.card.mode}</span>
        <span>
          {props.card.moduleCount} {props.card.moduleCount === 1 ? "module" : "modules"}
        </span>
        <span>
          {props.card.taskCount} atomic {props.card.taskCount === 1 ? "task" : "tasks"}
        </span>
        <span>Current task: {props.card.currentTask ?? "Pending admission"}</span>
        <span>Next stop: {props.card.nextStop}</span>
      </div>
      <For each={props.card.modules}>
        {(module) => (
          <section>
            <div class="text-12-medium text-text-strong">{module.name}</div>
            <ol class="space-y-1">
              <For each={module.tasks}>
                {(task, index) => (
                  <li class="text-12-regular text-text-base">
                    {index() + 1}. {task.name}
                    <Show when={task.verification?.criteria?.length}>
                      <span class="text-text-weak"> · {task.verification?.criteria?.join("; ")}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </section>
        )}
      </For>
    </div>
  )
}
