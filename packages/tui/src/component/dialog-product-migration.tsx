import type { ProductMigrationDraftPayload, ProductMigrationProjection } from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"

type DraftPatch = {
  sessionsEnabled?: boolean
  category?: ProductMigrationDraftPayload["categories"][number]["category"]
  categorySelected?: boolean
  projectID?: string
  sessionID?: string
  projectSelected?: boolean
  selected?: boolean
}

export function productMigrationGateRequired(profile: { id: string }) {
  return profile.id === "graph-vibe"
}

export function migrationErrorMessage(error: unknown) {
  if (!error || typeof error !== "object" || !("_tag" in error)) {
    return "Migration action could not complete. Review the refreshed protected status."
  }
  if (error._tag === "ProductMigrationInsufficientSpace" && "requiredBytes" in error && "availableBytes" in error) {
    return `Insufficient target space: ${formatMigrationBytes(Number(error.requiredBytes))} required, ${formatMigrationBytes(Number(error.availableBytes))} available.`
  }
  if (error._tag === "ProductMigrationValidationFailed" && "issues" in error && Array.isArray(error.issues)) {
    const codes = error.issues
      .flatMap((issue) =>
        issue && typeof issue === "object" && "code" in issue && typeof issue.code === "string" ? [issue.code] : [],
      )
      .slice(0, 32)
    return `Validation requires attention${codes.length ? `: ${codes.join(", ")}` : "."}`
  }
  if (error._tag === "ProductMigrationSourceError" && "code" in error && typeof error.code === "string") {
    return `The OpenCode source could not be verified (${error.code}).`
  }
  if (error._tag === "ProductMigrationInvalidTransition") return "This action is unavailable at the current checkpoint."
  if (error._tag === "ProductMigrationConflict") return "Migration data conflicts with the protected plan."
  if (error._tag === "ProductMigrationItemNotFound") return "The selected migration item is no longer available."
  if (error._tag === "ProductMigrationFinalized") return "Migration has already been finalized."
  return "Migration action could not complete. Review the refreshed protected status."
}

export function migrationProjectionIsCurrent(
  candidate: ProductMigrationProjection,
  current: ProductMigrationProjection,
) {
  if (Number(candidate.revision) !== Number(current.revision)) {
    return Number(candidate.revision) > Number(current.revision)
  }
  if (Number(candidate.completedItems) !== Number(current.completedItems)) {
    return Number(candidate.completedItems) > Number(current.completedItems)
  }
  const ranks = { pending: 0, copying: 1, completed: 2, failed: 2, skipped: 2 } as const
  const items = new Map(candidate.items.map((item) => [item.itemID, item.status]))
  return current.items.every((item) => ranks[items.get(item.itemID) ?? "pending"] >= ranks[item.status])
}

export async function pollMigrationProjection(input: {
  active: () => boolean
  current?: () => ProductMigrationProjection | undefined
  get: () => Promise<ProductMigrationProjection | undefined>
  update: (projection: ProductMigrationProjection) => void
  wait?: () => Promise<void>
}) {
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
  while (input.active()) {
    await wait()
    if (!input.active()) return
    const projection = await input.get().catch(() => undefined)
    if (!input.active()) return
    const current = input.current?.()
    if (projection && (!current || migrationProjectionIsCurrent(projection, current))) input.update(projection)
  }
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

export function formatMigrationBytes(input: number | string) {
  const bytes = typeof input === "number" && Number.isFinite(input) ? Math.max(0, input) : 0
  if (bytes < 1_024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)) - 1, units.length - 1)
  const value = bytes / 1_024 ** (index + 1)
  return `${value.toFixed(1)} ${units[index]}`
}

type Props = {
  projection: ProductMigrationProjection
  pending?: boolean
  conflict?: string
  onDiscover?: () => void
  onUpdateDraft?: (payload: ProductMigrationDraftPayload) => void
  onExecute?: () => void
  onPause?: () => unknown
  onRetry?: (itemID: string) => void
  onSkip?: (itemID: string) => void
  onValidate?: () => void
  onFinalize?: () => void
  onFreshStart?: () => void
}

const categoryNames = {
  config: "Config",
  credentials: "Credentials",
  mcp: "MCP",
  project: "Projects",
  session: "Sessions",
  graph: "Graph data",
} as const

export function ProductMigrationView(props: Props) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    confirm: undefined as "finalize" | "fresh" | undefined,
    project: 0,
    session: 0,
  })
  let pausing = false
  const failed = createMemo(() => props.projection.items.find((item) => item.status === "failed"))
  const selectedProject = createMemo(() => props.projection.plan?.projects[store.project])
  const selectedSession = createMemo(() => selectedProject()?.sessions[store.session])
  const progress = createMemo(() => {
    const total = Number(props.projection.totalItems) || 0
    const complete = Number(props.projection.completedItems) || 0
    return total ? Math.round((complete / total) * 100) : 0
  })
  const copied = createMemo(
    () =>
      props.projection.status === "copying" &&
      Number(props.projection.totalItems) > 0 &&
      Number(props.projection.completedItems) >= Number(props.projection.totalItems) &&
      !props.pending,
  )
  const statusTitle = createMemo(() => {
    if (copied()) return "Copy complete; validation required"
    if (props.projection.status === "copying") return "Transfer in progress"
    if (props.projection.status === "paused") return "Transfer paused"
    if (props.projection.status === "validating") return "Validating copied data"
    if (props.projection.status === "failed") return "Transfer interrupted"
    return "Validation passed"
  })
  const statusAction = createMemo(() => {
    if (copied()) return "v Validate"
    if (props.projection.status === "copying") return "p Pause"
    if (props.projection.status === "paused") return "x Resume"
    if (props.projection.status === "failed" && failed()) return "r Retry · k Skip"
    if (props.projection.status === "failed") return "v Retry validation"
    if (props.projection.status === "ready_to_finalize") return "f Finalize import · b Back to selection"
    return ""
  })

  useBindings(() => ({
    bindings: store.confirm ? [{
      key: "y",
      desc: "Confirm migration action",
      group: "Migration",
      cmd: () => {
        if (store.confirm === "finalize") props.onFinalize?.()
        if (store.confirm === "fresh") props.onFreshStart?.()
        setStore("confirm", undefined)
      },
    }, {
      key: "n",
      desc: "Cancel confirmation",
      group: "Migration",
      cmd: () => setStore("confirm", undefined),
    }] : [
      ...(props.projection.status === "undiscovered"
        ? [{ key: "d", desc: "Discover OpenCode data", group: "Migration", cmd: () => props.onDiscover?.() }]
        : []),
      ...(props.projection.status === "draft" ? [{
        key: "s",
        desc: "Toggle session import",
        group: "Migration",
        cmd: () => {
          if (!props.projection.plan) return
          props.onUpdateDraft?.(
            migrationDraftPayload(props.projection, { sessionsEnabled: !props.projection.plan.sessionsEnabled }),
          )
        },
      }] : []),
      ...(props.projection.status === "draft" && props.projection.plan?.sessionsEnabled && selectedProject()
        ? [
            { key: "a", desc: "Select project sessions", group: "Migration", cmd: () => props.onUpdateDraft?.(migrationDraftPayload(props.projection, { projectID: selectedProject()!.id, projectSelected: true })) },
            { key: "u", desc: "Clear project sessions", group: "Migration", cmd: () => props.onUpdateDraft?.(migrationDraftPayload(props.projection, { projectID: selectedProject()!.id, projectSelected: false })) },
          ]
        : []),
      ...(props.projection.status === "draft" ? props.projection.plan?.categories.map((item, index) => ({
        key: String(index + 1),
        desc: `Toggle ${categoryNames[item.category]}`,
        group: "Migration",
        cmd: () =>
          props.onUpdateDraft?.(
            migrationDraftPayload(props.projection, {
              category: item.category,
              categorySelected: !item.selected,
            }),
          ),
      })) ?? [] : []),
      {
        key: "left",
        desc: "Previous project",
        group: "Migration",
        cmd: () => {
          const total = props.projection.plan?.projects.length ?? 0
          if (!total) return
          setStore({ project: (store.project - 1 + total) % total, session: 0 })
        },
      },
      {
        key: "right",
        desc: "Next project",
        group: "Migration",
        cmd: () => {
          const total = props.projection.plan?.projects.length ?? 0
          if (!total) return
          setStore({ project: (store.project + 1) % total, session: 0 })
        },
      },
      {
        key: "up",
        desc: "Previous session",
        group: "Migration",
        cmd: () => {
          const total = selectedProject()?.sessions.length ?? 0
          if (total) setStore("session", (store.session - 1 + total) % total)
        },
      },
      {
        key: "down",
        desc: "Next session",
        group: "Migration",
        cmd: () => {
          const total = selectedProject()?.sessions.length ?? 0
          if (total) setStore("session", (store.session + 1) % total)
        },
      },
      ...(props.projection.status === "draft" ? [{
        key: "space",
        desc: "Toggle selected session",
        group: "Migration",
        cmd: () => {
          const project = selectedProject()
          const session = selectedSession()
          if (!props.projection.plan?.sessionsEnabled || !project || !session) return
          props.onUpdateDraft?.(
            migrationDraftPayload(props.projection, {
              projectID: project.id,
              sessionID: session.id,
              selected: !session.selected,
            }),
          )
        },
      }] : []),
      ...(["draft", "paused"].includes(props.projection.status)
        ? [{ key: "x", desc: "Start or resume transfer", group: "Migration", cmd: () => props.onExecute?.() }]
        : []),
      ...(props.projection.status === "copying" && !copied()
        ? [{
            key: "p",
            desc: "Pause transfer",
            group: "Migration",
            cmd: () => {
              if (pausing) return
              pausing = true
              void Promise.resolve(props.onPause?.()).finally(() => {
                pausing = false
              })
            },
          }]
        : []),
      ...(failed()
        ? [
            { key: "r", desc: "Retry failed item", group: "Migration", cmd: () => props.onRetry?.(failed()!.itemID) },
            { key: "k", desc: "Skip failed item", group: "Migration", cmd: () => props.onSkip?.(failed()!.itemID) },
          ]
        : []),
      ...(copied() || (props.projection.status === "failed" && props.projection.validation?.valid === false)
        ? [{ key: "v", desc: "Validate transfer", group: "Migration", cmd: () => props.onValidate?.() }]
        : []),
      ...(props.projection.status === "ready_to_finalize" && props.projection.canFinalize
        ? [{ key: "f", desc: "Finalize import", group: "Migration", cmd: () => setStore("confirm", "finalize") }]
        : []),
      ...(props.projection.status === "ready_to_finalize"
        ? [{ key: "b", desc: "Return to selection", group: "Migration", cmd: () => props.onUpdateDraft?.(migrationDraftPayload(props.projection)) }]
        : []),
      ...(["undiscovered", "draft"].includes(props.projection.status)
        ? [{ key: "z", desc: "Start fresh", group: "Migration", cmd: () => setStore("confirm", "fresh") }]
        : []),
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>TRANSFER CHECKPOINT</text>
        <text fg={theme.textMuted}>Graph Vibe first run · revision {props.projection.revision}</text>
      </box>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>Import OpenCode data into isolated Graph Vibe storage</text>
      <text fg={theme.textMuted}>Only the migration service projection controls this checkpoint. Secret values and message content are never shown.</text>

      <Show when={props.conflict}>
        <box flexDirection="column" border={["left"]} borderColor={theme.warning} paddingLeft={1}>
          <text fg={theme.warning}>{`${props.conflict}\nReview the refreshed plan before repeating the action.`}</text>
        </box>
      </Show>

      <Show when={store.confirm}>
        <box flexDirection="column" border={["left"]} borderColor={theme.warning} paddingLeft={1}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            {store.confirm === "finalize"
              ? "Confirm final import\nThis unlocks Graph Vibe using the validated imported data.\ny Confirm · n Cancel"
              : "Confirm fresh start\nThis unlocks Graph Vibe without importing OpenCode data.\ny Confirm · n Cancel"}
          </text>
        </box>
      </Show>

      <Show when={props.projection.status === "undiscovered"}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.text}>Scan the OpenCode source through the migration service before choosing what to transfer.</text>
          <text fg={theme.primary}>d Discover source · z Start fresh</text>
        </box>
      </Show>

      <Show when={props.projection.source}>
        {(source) => (
          <box flexDirection="column" border={["top", "bottom"]} borderColor={theme.border} paddingTop={1} paddingBottom={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>SOURCE INVENTORY</text>
            <text fg={theme.text}>Database: {source().database}</text>
            <text fg={theme.textMuted}>{formatMigrationBytes(source().databaseBytes)} · {source().sessionCount} sessions · {source().mixedGraph ? "mixed Graph data detected" : "OpenCode data"}</text>
          </box>
        )}
      </Show>

      <Show when={props.projection.status === "draft" ? props.projection.plan : null}>
        {(plan) => (
          <scrollbox flexGrow={1} minHeight={5}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>CATEGORY MANIFEST</text>
              <For each={plan().categories}>
                {(item) => (
                  <text fg={item.selected ? theme.success : theme.textMuted}>
                    {item.selected ? "[x]" : "[ ]"} {categoryNames[item.category]} · {formatMigrationBytes(item.estimatedBytes)}
                  </text>
                )}
              </For>
              <text fg={plan().sessionsEnabled ? theme.success : theme.warning} attributes={TextAttributes.BOLD}>
                Sessions: {plan().sessionsEnabled ? "enabled" : "disabled"}
              </text>
              <text fg={theme.textMuted}>1-6 Categories · s Sessions · a/u Project all/none · ←/→ Project · ↑/↓ Session · space Select</text>
              <For each={plan().projects}>
                {(project, projectIndex) => (
                  <box flexDirection="column" border={["left"]} borderColor={project.current ? theme.primary : theme.border} paddingLeft={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      {store.project === projectIndex() ? "> " : "  "}{project.path.split(/[\\/]/).at(-1) || project.path} · {formatMigrationBytes(project.estimatedBytes)}
                    </text>
                    <text fg={theme.textMuted}>{project.path} · {project.sessionCount} sessions</text>
                    <For each={project.sessions}>
                      {(session, sessionIndex) => (
                        <text fg={session.selected ? theme.success : theme.textMuted}>
                          {store.project === projectIndex() && store.session === sessionIndex() ? ">" : " "}{session.selected ? "[x]" : "[ ]"} {session.title} · {session.archived ? "Archived" : "Available"} · Updated {new Date(session.updatedAt).toISOString().slice(0, 10)} · {formatMigrationBytes(session.estimatedBytes)}{session.hasGraph ? " · Graph" : ""}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        )}
      </Show>

      <Show when={["copying", "paused", "validating", "failed", "ready_to_finalize"].includes(props.projection.status)}>
        <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
          <text fg={failed() ? theme.error : theme.text} attributes={TextAttributes.BOLD}>
            {`${statusTitle()}\n${props.projection.completedItems}/${props.projection.totalItems} items · ${progress()}%${failed() ? `\nCopy failed for ${categoryNames[failed()!.category]}. Raw error details are hidden.` : ""}${statusAction() ? `\n${statusAction()}` : ""}`}
          </text>
          <For each={props.projection.items.filter((item) => item.selected)}>
            {(item) => {
              const session = () => props.projection.plan?.projects.flatMap((project) => project.sessions).find((candidate) => candidate.id === item.sourceID)
              return <text fg={theme.textMuted}>{item.category === "session" ? (session()?.title ?? "Selected session") : categoryNames[item.category]}: {item.status}</text>
            }}
          </For>
          <Show when={props.projection.validation && !props.projection.validation.valid}>
            <text fg={theme.warning}>Validation issue codes: {props.projection.validation?.issues.map((issue) => issue.code).join(", ")}</text>
          </Show>
        </box>
      </Show>

      <Show when={props.projection.status === "draft"}>
        <text fg={theme.primary}>x Begin transfer · z Start fresh</text>
      </Show>
      <Show when={props.projection.status === "completed"}>
        <box flexDirection="column" border={["left"]} borderColor={theme.success} paddingLeft={1}>
          <text fg={theme.success} attributes={TextAttributes.BOLD}>{"Migration complete\nGraph Vibe is unlocked."}</text>
        </box>
      </Show>
      <Show when={props.pending}><text fg={theme.textMuted}>Applying migration action…</text></Show>
    </box>
  )
}

export const DialogProductMigration = ProductMigrationView
