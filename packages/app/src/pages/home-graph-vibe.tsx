import { Button } from "@opencode-ai/ui/button"
import { Show } from "solid-js"

export function HomeGraphVibe(props: {
  visible: boolean
  pending: boolean
  unavailable: boolean
  capability: string
  projectName?: string
  onStart: () => void
}) {
  return (
    <Show when={props.visible}>
      <section
        aria-label="Graph Vibe workflow"
        class="mb-4 flex min-w-0 flex-col gap-4 border-y border-v2-border-border-base py-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0">
          <p class="text-[11px] uppercase leading-4 tracking-[0.12em] text-v2-text-text-faint [font-weight:530]">
            Graph Vibe
          </p>
          <p class="mt-1 text-[15px] leading-5 tracking-[-0.12px] text-v2-text-text-base [font-weight:530]">
            {props.capability}
          </p>
          <Show when={props.projectName}>
            {(projectName) => (
              <p class="mt-1 min-w-0 truncate text-[12px] leading-4 text-v2-text-text-muted [font-weight:440]">
                Selected project <span class="text-v2-text-text-base">{projectName()}</span>
              </p>
            )}
          </Show>
          <Show when={props.unavailable}>
            <p role="status" class="mt-1 text-[12px] leading-4 text-v2-state-fg-danger [font-weight:530]">
              Server unavailable
            </p>
          </Show>
        </div>
        <Button
          type="button"
          variant="primary"
          size="large"
          class="min-h-11 w-full shrink-0 px-5 sm:w-auto"
          disabled={props.pending || props.unavailable}
          aria-busy={props.pending}
          onClick={(_event: MouseEvent) => props.onStart()}
        >
          <span aria-live="polite">{props.pending ? "Creating workflow…" : "Start Graph Workflow"}</span>
        </Button>
      </section>
    </Show>
  )
}
