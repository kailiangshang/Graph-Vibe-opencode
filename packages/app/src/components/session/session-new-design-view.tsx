import { Show, type JSX } from "solid-js"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { useProduct } from "@/context/product"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  const product = useProduct()
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <Show
            when={product.graphVibe()}
            fallback={
              <div role="img" aria-label={product.product().name}>
                <WordmarkV2 class="h-auto w-full text-v2-icon-icon-base" />
              </div>
            }
          >
            <header data-component="graph-vibe-lockup" class="flex aspect-[720/129] items-start gap-4 sm:gap-6">
              <div aria-hidden="true" class="mt-2 flex w-4 shrink-0 flex-col items-center sm:mt-3">
                <span class="size-2 rounded-[2px] border border-v2-border-border-strong bg-v2-background-bg-layer-03" />
                <span class="h-8 w-px bg-v2-border-border-base sm:h-12" />
                <span class="size-2 rounded-[2px] border border-v2-border-border-muted bg-v2-background-bg-layer-01" />
              </div>
              <div class="min-w-0">
                <p class="hidden text-[10px] uppercase leading-4 tracking-[0.16em] text-v2-text-text-faint [font-weight:530] sm:block">
                  Workflow system
                </p>
                <h1 class="whitespace-nowrap text-[clamp(2.25rem,8vw,5.75rem)] leading-[0.9] tracking-[-0.065em] text-v2-text-text-base [font-weight:600] sm:mt-1">
                  {product.product().name}
                </h1>
                <p class="mt-2 text-[12px] leading-4 tracking-[0.02em] text-v2-text-text-muted [font-weight:440] sm:mt-3 sm:text-[13px]">
                  {product.product().capability}
                </p>
              </div>
            </header>
          </Show>
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
