import type { ProductMigrationDraftPayload, ProductMigrationProjection } from "@opencode-ai/sdk/v2/client"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"

type DraftPatch = {
  sessionsEnabled?: boolean
  category?: ProductMigrationDraftPayload["categories"][number]["category"]
  categorySelected?: boolean
  projectID?: string
  sessionID?: string
  projectSelected?: boolean
  selected?: boolean
}

export type ProductMigrationController = {
  projection: () => ProductMigrationProjection
  conflict: () => string | undefined
  pending: () => boolean
  discover: () => Promise<unknown>
  updateDraft: (payload: ProductMigrationDraftPayload) => Promise<unknown>
  execute: () => Promise<unknown>
  pause: () => Promise<unknown>
  retry: (itemID: string) => Promise<unknown>
  skip: (itemID: string) => Promise<unknown>
  validate: () => Promise<unknown>
  finalize: () => Promise<unknown>
  freshStart: () => Promise<unknown>
  refresh: () => Promise<unknown>
}

export function migrationView(projection: ProductMigrationProjection) {
  if (projection.status === "undiscovered") return "discover"
  if (projection.status === "draft") return "selection"
  if (projection.status === "copying") return "progress"
  if (projection.status === "paused") return "paused"
  if (projection.status === "failed") return "failed"
  if (projection.status === "validating") return "validation"
  if (projection.status === "ready_to_finalize") return "finalize"
  return "completed"
}

export function migrationProgress(projection: ProductMigrationProjection) {
  const value = Number(projection.completedItems) || 0
  const total = Number(projection.totalItems) || 0
  return { value, max: total || 1, percent: total ? Math.round((value / total) * 100) : 0 }
}

export function formatMigrationBytes(input: number | string) {
  const bytes = typeof input === "number" && Number.isFinite(input) ? Math.max(0, input) : 0
  if (bytes < 1_024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)) - 1, units.length - 1)
  const value = bytes / 1_024 ** (index + 1)
  return `${value.toFixed(1)} ${units[index]}`
}

export function migrationDraftPayload(
  projection: ProductMigrationProjection,
  patch: DraftPatch = {},
): ProductMigrationDraftPayload {
  if (!projection.plan) throw new Error("Migration plan is not available")
  return {
    expectedRevision: projection.revision,
    categories: projection.plan.categories.map((item) => ({
      category: item.category,
      selected: item.category === patch.category ? (patch.categorySelected ?? item.selected) : item.selected,
    })),
    sessionsEnabled: patch.sessionsEnabled ?? projection.plan.sessionsEnabled,
    sessions: projection.plan.projects.flatMap((project) =>
      project.sessions.map((session) => ({
        projectID: project.id,
        sessionID: session.id,
        selected: project.id === patch.projectID && patch.projectSelected !== undefined
          ? patch.projectSelected
          : (!patch.projectID || project.id === patch.projectID) && session.id === patch.sessionID
            ? (patch.selected ?? session.selected)
            : session.selected,
      })).filter((session) => session.selected),
    ).slice(0, 2_000),
  }
}

const labels = {
  config: "Configuration",
  credentials: "Credentials",
  mcp: "MCP connections",
  project: "Projects",
  session: "Sessions",
  graph: "Graph workflow data",
} as const

const mobileSteps = ["manifest", "projects", "sessions", "review"] as const

export function ProductMigrationPage(props: { controller: ProductMigrationController }) {
  const [store, setStore] = createStore({
    project: 0,
    mobileStep: "manifest" as (typeof mobileSteps)[number],
    confirm: undefined as "finalize" | "fresh" | undefined,
  })
  const projection = () => props.controller.projection()
  const plan = () =>
    projection().plan ?? {
      revision: projection().revision,
      sourceFingerprint: "",
      categories: [],
      sessionsEnabled: false,
      projects: [],
      requiredBytes: 0,
    }
  const source = () =>
    projection().source ?? { database: "", databaseBytes: 0, mixedGraph: false, sessionCount: 0 }
  const progress = createMemo(() => migrationProgress(projection()))
  const editable = () => projection().status === "draft" && !props.controller.pending()
  const selectedProject = createMemo(() => plan()?.projects[store.project] ?? plan()?.projects[0])
  let dialog: HTMLDivElement | undefined
  let confirmation: HTMLDivElement | undefined
  let confirmationKind: "finalize" | "fresh" | undefined
  let previousFocus: HTMLElement | undefined

  const openConfirmation = (kind: "finalize" | "fresh") => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    confirmationKind = kind
    setStore("confirm", kind)
    if (!confirmation) return
    dialog = confirmation
    confirmation.hidden = false
    const finalizeHeading = confirmation.querySelector<HTMLElement>("[data-confirm-heading=finalize]")
    const freshHeading = confirmation.querySelector<HTMLElement>("[data-confirm-heading=fresh]")
    const confirmationCopy = confirmation.querySelector<HTMLElement>("[data-confirm-copy]")
    const confirmationAction = confirmation.querySelector<HTMLButtonElement>("[data-confirm-action]")
    if (finalizeHeading) finalizeHeading.hidden = kind !== "finalize"
    if (freshHeading) freshHeading.hidden = kind !== "fresh"
    confirmation.setAttribute("aria-labelledby", kind === "finalize" ? "migration-confirm-finalize-title" : "migration-confirm-fresh-title")
    if (confirmationCopy) confirmationCopy.textContent =
      kind === "finalize"
        ? "Graph Vibe will unlock only after the service records this validated migration as complete."
        : "Graph Vibe will unlock with isolated empty storage. OpenCode data will not be copied."
    if (confirmationAction) confirmationAction.dataset.action = kind === "finalize" ? "confirm-finalize" : "confirm-fresh-start"
    queueMicrotask(() => confirmationAction?.focus())
  }

  const closeConfirmation = () => {
    confirmationKind = undefined
    setStore("confirm", undefined)
    if (confirmation) confirmation.hidden = true
    if (dialog === confirmation) dialog = undefined
    previousFocus?.focus()
    previousFocus = undefined
  }

  const selectMobileStep = (step: (typeof mobileSteps)[number], root?: HTMLElement | null) => {
    setStore("mobileStep", step)
    root?.querySelectorAll<HTMLElement>("[data-mobile-panel]").forEach((panel) => {
      const active = panel.dataset.mobilePanel === step
      panel.dataset.active = String(active)
      panel.classList.toggle("hidden", !active)
      panel.classList.toggle("block", active)
    })
  }

  const trap = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeConfirmation()
      return
    }
    if (event.key !== "Tab" || !dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")]
    if (!focusable.length) return
    const index = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length
    event.preventDefault()
    focusable[next]?.focus()
  }

  onMount(() => document.addEventListener("keydown", trap))
  onCleanup(() => document.removeEventListener("keydown", trap))

  return (
    <main
      class="min-h-dvh w-full overflow-x-hidden bg-background-base text-text-base"
      aria-label="Graph Vibe data transfer checkpoint"
    >
      <div class="mx-auto flex min-h-dvh w-full max-w-[1480px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-8">
        <header class="border-b border-border-weak-base pb-5 lg:flex lg:items-end lg:justify-between">
          <div>
            <p class="font-mono text-11-medium uppercase tracking-[0.22em] text-text-weak">GV / TRANSFER CHECKPOINT / REV {projection().revision}</p>
            <h1 class="mt-2 text-24-medium text-text-strong sm:text-28-medium">Isolate. Inspect. Transfer.</h1>
            <p class="mt-2 max-w-2xl text-13-regular text-text-base">Choose what Graph Vibe imports from OpenCode. The source remains unchanged, and private values or message content are never displayed here.</p>
          </div>
          <div class="mt-4 flex items-center gap-2 font-mono text-11-medium uppercase tracking-wider text-text-weak lg:mt-0">
            <span class="size-2 rounded-full bg-icon-warning-base" aria-hidden="true" />
            Navigation locked until completion
          </div>
        </header>

        <Show when={props.controller.conflict()}>
          {(message) => (
            <div ref={(element) => { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; dialog = element }} role="dialog" aria-modal="true" aria-labelledby="migration-conflict-title" class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
              <div class="w-full max-w-lg border border-border-strong-base bg-surface-raised-base p-6 shadow-xl">
                <p class="font-mono text-11-medium uppercase tracking-wider text-icon-warning-base">Revision conflict</p>
                <h2 id="migration-conflict-title" class="mt-2 text-18-medium text-text-strong">The transfer plan changed</h2>
                <p class="mt-3 text-13-regular text-text-base">{message()}</p>
                <p class="mt-2 text-12-regular text-text-weak">The latest SDK projection has replaced the stale view. Review it before repeating the action.</p>
                <button type="button" autofocus class="mt-5 min-h-11 border border-border-strong-base px-4 text-13-medium hover:bg-surface-base-hover" onClick={() => { const focus = previousFocus; previousFocus = undefined; dialog = undefined; void props.controller.refresh().finally(() => focus?.focus()) }}>Review refreshed plan</button>
              </div>
            </div>
          )}
        </Show>

          <div ref={(element) => { confirmation = element }} hidden role="dialog" aria-modal="true" aria-labelledby="migration-confirm-finalize-title" class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
            <div class="w-full max-w-lg border border-border-strong-base bg-surface-raised-base p-6 shadow-xl">
              <p class="font-mono text-11-medium uppercase tracking-wider text-icon-warning-base">Irreversible checkpoint</p>
              <h2 data-confirm-heading="finalize" id="migration-confirm-finalize-title" class="mt-2 text-18-medium text-text-strong">Finalize this import?</h2>
              <h2 data-confirm-heading="fresh" id="migration-confirm-fresh-title" hidden class="mt-2 text-18-medium text-text-strong">Start without importing?</h2>
              <p data-confirm-copy class="mt-3 text-13-regular text-text-base" />
              <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" data-action="cancel-confirmation" class="min-h-11 border border-border-weak-base px-4 text-13-medium hover:bg-surface-base-hover" onClick={closeConfirmation}>Cancel</button>
                <button
                  type="button"
                  autofocus
                  data-confirm-action
                  class="min-h-11 bg-button-primary-base px-4 text-13-medium text-text-on-color hover:bg-button-primary-hover"
                  onClick={() => {
                    const action = confirmationKind === "finalize" ? props.controller.finalize() : props.controller.freshStart()
                    closeConfirmation()
                    void action
                  }}
                >Confirm and unlock</button>
              </div>
            </div>
          </div>

        <nav aria-label="Migration steps" class="mt-4 grid grid-cols-4 border border-border-weak-base lg:hidden">
          <For each={mobileSteps}>
            {(step) => (
              <button
                type="button"
                data-slot="migration-mobile-step"
                class={`min-h-11 border-r border-border-weak-base px-1 font-mono text-10-medium uppercase last:border-r-0 ${store.mobileStep === step ? "bg-surface-raised-base text-text-strong" : "text-text-weak"}`}
                aria-current={store.mobileStep === step ? "step" : undefined}
                onClick={(event) => selectMobileStep(step, event.currentTarget.closest("main"))}
              >{step[0]!.toUpperCase() + step.slice(1)}</button>
            )}
          </For>
        </nav>

        <Show when={projection().status === "undiscovered"}>
          <section role="status" class="my-auto grid gap-8 py-12 lg:grid-cols-[1.2fr_0.8fr]">
            <div class="border-l-2 border-icon-warning-base pl-5">
              <p class="font-mono text-11-medium uppercase tracking-wider text-text-weak">Stage 00 / Source discovery</p>
              <h2 class="mt-3 text-20-medium text-text-strong">Locate the OpenCode inventory</h2>
              <p class="mt-3 max-w-xl text-13-regular text-text-base">Graph Vibe asks the migration service to inspect the canonical source. No browser-side file probing or inferred state is used.</p>
              <button type="button" class="mt-6 min-h-11 bg-button-primary-base px-5 text-13-medium text-text-on-color hover:bg-button-primary-hover" onClick={() => props.controller.discover()}>Discover OpenCode data</button>
            </div>
            <div class="border border-border-weak-base bg-surface-base p-5">
              <p class="font-mono text-11-medium uppercase tracking-wider text-text-weak">Alternative</p>
              <h3 class="mt-2 text-16-medium text-text-strong">Use empty isolated storage</h3>
              <p class="mt-2 text-12-regular text-text-base">This requires a separate confirmation and never touches OpenCode data.</p>
              <button type="button" data-action="fresh-start" class="mt-5 min-h-11 border border-border-strong-base px-4 text-13-medium hover:bg-surface-base-hover" onClick={() => openConfirmation("fresh")}>Start Graph Vibe fresh</button>
            </div>
          </section>
        </Show>

        <Show when={projection().source && plan()}>
          <div class="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(240px,0.72fr)_minmax(430px,1.45fr)_minmax(260px,0.83fr)]">
            <aside data-mobile-panel="manifest" data-active={store.mobileStep === "manifest"} class={`${store.mobileStep === "manifest" ? "block" : "hidden"} min-h-0 border border-border-weak-base bg-surface-base lg:block`}>
              <div class="border-b border-border-weak-base p-4">
                <p class="font-mono text-10-medium uppercase tracking-wider text-text-weak">OpenCode source</p>
                <p class="mt-2 truncate text-13-medium text-text-strong" title={source().database}>{source().database}</p>
                <p class="mt-1 font-mono text-11-regular text-text-weak">{formatMigrationBytes(source().databaseBytes)} / {source().sessionCount} sessions</p>
              </div>
              <fieldset class="p-4">
                <legend class="font-mono text-10-medium uppercase tracking-wider text-text-weak">Category manifest</legend>
                <div class="mt-3 grid gap-1">
                  <For each={plan()!.categories}>
                    {(item) => (
                      <label class="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border-weak-base px-1 last:border-b-0">
                        <input type="checkbox" checked={item.selected} disabled={!item.available || !editable()} onChange={(event) => props.controller.updateDraft(migrationDraftPayload(projection(), { category: item.category, categorySelected: event.currentTarget.checked }))} />
                        <span class="min-w-0 flex-1 text-12-medium text-text-base">{labels[item.category]}</span>
                        <span class="font-mono text-10-regular text-text-weak">{formatMigrationBytes(item.estimatedBytes)}</span>
                      </label>
                    )}
                  </For>
                </div>
              </fieldset>
            </aside>

            <section class="contents lg:grid lg:min-h-0 lg:grid-cols-[0.9fr_1.1fr] lg:border lg:border-border-weak-base lg:bg-surface-base">
              <div data-slot="migration-projects" data-mobile-panel="projects" data-active={store.mobileStep === "projects"} class={`${store.mobileStep === "projects" ? "block" : "hidden"} min-h-0 border border-border-weak-base bg-surface-base lg:block lg:border-0 lg:border-r lg:border-border-weak-base`}>
                <div class="border-b border-border-weak-base p-4"><h2 class="font-mono text-11-medium uppercase tracking-wider text-text-strong">Projects</h2></div>
                <div class="grid max-h-[52vh] overflow-y-auto p-2">
                  <For each={plan()!.projects}>
                    {(project, index) => (
                      <button type="button" class={`min-h-11 border-l-2 px-3 py-3 text-left ${store.project === index() ? "border-icon-info-base bg-surface-raised-base" : "border-transparent hover:bg-surface-base-hover"}`} onClick={() => setStore("project", index())}>
                        <span class="block truncate text-12-medium text-text-strong">{project.path.split(/[\\/]/).at(-1) || project.path}</span>
                        <span class="mt-1 block font-mono text-10-regular text-text-weak">{project.sessionCount} sessions / {formatMigrationBytes(project.estimatedBytes)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div data-slot="migration-sessions" data-mobile-panel="sessions" data-active={store.mobileStep === "sessions"} class={`${store.mobileStep === "sessions" ? "block" : "hidden"} min-h-0 border border-border-weak-base bg-surface-base lg:block lg:border-0`}>
                <div class="border-b border-border-weak-base p-4">
                  <div class="flex items-center justify-between gap-3">
                    <div><h2 class="font-mono text-11-medium uppercase tracking-wider text-text-strong">Sessions</h2><p class="mt-1 text-11-regular text-text-weak">{plan()!.sessionsEnabled ? "Explicit import enabled" : "Sessions are off"}</p></div>
                    <label class="flex min-h-11 cursor-pointer items-center gap-2 text-11-medium"><input type="checkbox" checked={plan()!.sessionsEnabled} disabled={!editable()} onChange={(event) => props.controller.updateDraft(migrationDraftPayload(projection(), { sessionsEnabled: event.currentTarget.checked }))} /> Import</label>
                  </div>
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <button type="button" data-action="select-project-sessions" disabled={!editable() || !plan()!.sessionsEnabled || !selectedProject()} class="min-h-11 border border-border-weak-base px-2 text-10-medium disabled:opacity-50" onClick={() => props.controller.updateDraft(migrationDraftPayload(projection(), { projectID: selectedProject()!.id, projectSelected: true }))}>Select project</button>
                    <button type="button" data-action="clear-project-sessions" disabled={!editable() || !plan()!.sessionsEnabled || !selectedProject()} class="min-h-11 border border-border-weak-base px-2 text-10-medium disabled:opacity-50" onClick={() => props.controller.updateDraft(migrationDraftPayload(projection(), { projectID: selectedProject()!.id, projectSelected: false }))}>Clear project</button>
                  </div>
                </div>
                <div class="grid max-h-[52vh] overflow-y-auto p-2">
                  <For each={selectedProject()?.sessions ?? []}>
                    {(session) => (
                      <label class={`flex min-h-11 items-center gap-3 border-b border-border-weak-base px-3 py-2 last:border-b-0 ${plan()!.sessionsEnabled ? "cursor-pointer" : "opacity-55"}`}>
                        <input type="checkbox" disabled={!plan()!.sessionsEnabled || !editable()} checked={session.selected} onChange={(event) => props.controller.updateDraft(migrationDraftPayload(projection(), { projectID: selectedProject()!.id, sessionID: session.id, selected: event.currentTarget.checked }))} />
                        <span class="min-w-0 flex-1"><span class="block truncate text-12-medium text-text-base">{session.title}</span><span class="font-mono text-10-regular text-text-weak">{session.archived ? "Archived" : "Available"} / Updated {new Date(session.updatedAt).toISOString().slice(0, 10)} / {session.hasGraph ? "Graph attached / " : ""}{formatMigrationBytes(session.estimatedBytes)}</span></span>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            </section>

            <aside data-mobile-panel="review" data-active={store.mobileStep === "review"} class={`${store.mobileStep === "review" ? "block" : "hidden"} border border-border-weak-base bg-surface-base lg:block`}>
              <MigrationStatus projection={projection()} controller={props.controller} />
              <Show when={projection().status === "draft"}>
                <div class="border-t border-border-weak-base p-4">
                  <p class="font-mono text-10-medium uppercase tracking-wider text-text-weak">Estimated transfer</p>
                  <p class="mt-2 text-20-medium text-text-strong">{formatMigrationBytes(plan()!.requiredBytes)}</p>
                  <button type="button" class="mt-4 min-h-11 w-full bg-button-primary-base px-4 text-13-medium text-text-on-color hover:bg-button-primary-hover" onClick={() => props.controller.execute()}>Begin transfer</button>
                  <button type="button" data-action="fresh-start" class="mt-2 min-h-11 w-full border border-border-weak-base px-4 text-12-medium hover:bg-surface-base-hover" onClick={() => openConfirmation("fresh")}>Start fresh instead</button>
                </div>
              </Show>
              <Show when={projection().status === "ready_to_finalize"}>
                <div class="border-t border-border-weak-base p-4">
                  <button type="button" data-action="finalize" disabled={!projection().canFinalize} class="min-h-11 w-full bg-button-primary-base px-4 text-13-medium text-text-on-color disabled:opacity-50" onClick={() => openConfirmation("finalize")}>Finalize validated import</button>
                  <button type="button" data-action="return-to-draft" class="mt-2 min-h-11 w-full border border-border-weak-base px-4 text-12-medium" onClick={() => props.controller.updateDraft(migrationDraftPayload(projection()))}>Return to selection</button>
                </div>
              </Show>
            </aside>
          </div>
        </Show>
      </div>
    </main>
  )
}

function MigrationStatus(props: { projection: ProductMigrationProjection; controller: ProductMigrationController }) {
  const progress = () => migrationProgress(props.projection)
  const failed = () => props.projection.items.filter((item) => item.status === "failed")
  const copied = () =>
    props.projection.status === "copying" &&
    Number(props.projection.totalItems) > 0 &&
    Number(props.projection.completedItems) >= Number(props.projection.totalItems) &&
    !props.controller.pending()
  return (
    <div class="p-4" role="status" aria-live="polite">
      <p class="font-mono text-10-medium uppercase tracking-wider text-text-weak">Transfer status</p>
      <h2 class="mt-2 text-16-medium text-text-strong">
        {props.projection.status === "draft" && "Ready to transfer"}
        {copied() ? "Copy complete; validation required" : props.projection.status === "copying" && "Transfer in progress"}
        {props.projection.status === "paused" && "Transfer paused"}
        {props.projection.status === "failed" && "Transfer interrupted"}
        {props.projection.status === "validating" && "Validating copied data"}
        {props.projection.status === "ready_to_finalize" && "Ready to finalize"}
        {props.projection.status === "completed" && "Migration complete"}
      </h2>
      <Show when={props.projection.status !== "draft"}>
        <div class="mt-4">
          <div class="h-2 overflow-hidden bg-surface-raised-base" role="progressbar" aria-label="Migration progress" aria-valuemin="0" aria-valuemax={progress().max} aria-valuenow={progress().value} aria-valuetext={`${progress().percent}%`}>
            <div class="h-full bg-icon-info-base transition-[width] motion-reduce:transition-none" style={{ width: `${progress().percent}%` }} />
          </div>
          <p class="mt-2 font-mono text-10-regular text-text-weak">{props.projection.completedItems} / {props.projection.totalItems} items / {progress().percent}%</p>
        </div>
      </Show>
      <Show when={props.projection.items.length > 0}>
        <ul class="mt-4 grid gap-1 font-mono text-10-regular text-text-weak">
          <For each={props.projection.items.filter((item) => item.selected)}>
            {(item) => {
              const session = () => props.projection.plan?.projects.flatMap((project) => project.sessions).find((candidate) => candidate.id === item.sourceID)
              return <li>{item.category === "session" ? (session()?.title ?? "Selected session") : labels[item.category]}: {item.status}</li>
            }}
          </For>
        </ul>
      </Show>
      <Show when={props.projection.status === "copying" && !copied()}><button type="button" data-action="pause" class="mt-4 min-h-11 w-full border border-border-strong-base px-4 text-12-medium hover:bg-surface-base-hover" onClick={() => props.controller.pause()}>Pause transfer</button></Show>
      <Show when={copied()}><button type="button" data-action="validate" class="mt-4 min-h-11 w-full bg-button-primary-base px-4 text-12-medium text-text-on-color" onClick={() => props.controller.validate()}>Validate copied data</button></Show>
      <Show when={props.projection.status === "paused"}><button type="button" class="mt-4 min-h-11 w-full bg-button-primary-base px-4 text-12-medium text-text-on-color" onClick={() => props.controller.execute()}>Resume transfer</button></Show>
      <Show when={failed().length}>
        <div class="mt-4 grid gap-3">
          <For each={failed()}>
            {(item) => (
              <div class="border-l-2 border-icon-critical-base pl-3">
                <p class="text-12-medium text-text-strong">Copy failed: {labels[item.category]}</p>
                <p class="mt-1 text-11-regular text-text-weak">Raw source identifiers and error details are hidden.</p>
                <div class="mt-2 grid grid-cols-2 gap-2">
                  <button type="button" aria-label={`Retry failed ${item.category} item`} class="min-h-11 border border-border-strong-base px-2 text-11-medium" onClick={() => props.controller.retry(item.itemID)}>Retry</button>
                  <button type="button" aria-label={`Skip failed ${item.category} item`} class="min-h-11 border border-border-weak-base px-2 text-11-medium" onClick={() => props.controller.skip(item.itemID)}>Skip</button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.projection.status === "failed" && failed().length === 0}><button type="button" data-action="validate" class="mt-4 min-h-11 w-full border border-border-strong-base px-4 text-12-medium" onClick={() => props.controller.validate()}>Run validation again</button></Show>
      <Show when={props.projection.validation && !props.projection.validation.valid}>
        <div class="mt-4 border-l-2 border-icon-warning-base pl-3">
          <p class="text-12-medium text-text-strong">Validation requires attention</p>
          <p class="mt-1 text-11-regular text-text-weak">Issue codes:</p>
          <ul class="mt-1 font-mono text-10-regular text-text-weak">
            <For each={props.projection.validation?.issues}>{(issue) => <li>{issue.code}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={props.projection.status === "completed"}><p class="mt-3 text-12-regular text-text-base">Graph Vibe is unlocked. Normal navigation is now available.</p></Show>
      <Show when={props.controller.pending()}><p class="mt-3 font-mono text-10-medium uppercase text-text-weak">Applying checkpoint action…</p></Show>
    </div>
  )
}
