import "@/index.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useLocation, useParams, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  Match,
  onCleanup,
  type ParentProps,
  Show,
  Switch,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { legacySessionServer, requireServerKey, sessionHref } from "./utils/session-route"
import { createSessionLineage } from "@/pages/session/session-lineage"
import { SessionPage, SessionRouteErrorBoundary, TargetSessionRouteContent } from "@/pages/session"
import { ProductMigrationPage } from "@/pages/product-migration"
import { ProductProvider, useProduct } from "@/context/product"
import { ServerAvailabilityGate } from "@/components/server-availability-gate"
import { syncBodyDesignMode } from "@/utils/body-design"
import { isTargetScopedRoute } from "@/utils/route-scope"

import { NewHome, LegacyHome } from "@/pages/home"

const NewSession = lazy(() => import("@/pages/new-session"))
const GraphPage = lazy(() => import("@/pages/graph"))

function useProductLayout() {
  const settings = useSettings()
  const product = useProduct()
  return createMemo(() => settings.general.newLayoutDesigns() || product.graphVibe())
}

const SessionRoute = () => {
  const newLayout = useProductLayout()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && newLayout()) {
    const sessionID = params.id
    return (
      <Show when={tabs.ready()}>
        {(_) => {
          const persisted = tabs.store.filter((item) => item.type === "session")
          return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
        }}
      </Show>
    )
  }

  // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
  // is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (!newLayout()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionRouteErrorBoundary sessionID={params.id}>
      <SessionPage />
    </SessionRouteErrorBoundary>
  )
}

function TargetServerRoute(props: {
  render: (newLayout: Accessor<boolean>, server: Accessor<ServerConnection.Any | undefined>) => JSX.Element
}) {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const key = () => requireServerKey(params.serverKey)
  const conn = createMemo(() => {
    return global.servers.list().find((item) => ServerConnection.key(item) === key())
  })
  const available = () => !!conn() && global.servers.health[key()] !== undefined

  return (
    // Owns the server-identity remount. Session changes must NOT remount this
    // subtree (SessionRouteErrorBoundary resets and createSessionLineage
    // re-resolves reactively instead); both rely on this key for server changes.
    <ServerAvailabilityGate serverKey={key} available={available}>
      <ProductProvider server={conn}>
        <TargetServerRouteContent conn={conn} render={props.render} />
      </ProductProvider>
    </ServerAvailabilityGate>
  )
}

function TargetServerRouteContent(props: {
  conn: () => ServerConnection.Any | undefined
  render: (
    newLayout: Accessor<boolean>,
    server: Accessor<ServerConnection.Any | undefined>,
  ) => JSX.Element
}) {
  const newLayout = useProductLayout()
  return (
    <>
      <BodyDesignClass newLayout={newLayout} />
      <ServerSDKProvider server={props.conn}>
        <ServerSyncProvider server={props.conn}>
          <ProductMigrationGate>
            {props.render(newLayout, props.conn)}
          </ProductMigrationGate>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </>
  )
}

function TargetSessionRoute(props: { serverScoped?: JSX.Element }) {
  const params = useParams<{ serverKey: string; id: string }>()
  return (
    <TargetServerRoute
      render={(newLayout, server) => (
        <SessionRouteErrorBoundary
          sessionID={params.id}
          serverKey={requireServerKey(params.serverKey)}
          padded={newLayout()}
          newLayout={newLayout}
        >
          <TargetRouteLayout newLayout={newLayout} server={server} serverScoped={props.serverScoped}>
            <TargetSessionRouteContent padded={newLayout()} newLayout={newLayout} />
          </TargetRouteLayout>
        </SessionRouteErrorBoundary>
      )}
    />
  )
}

function TargetRouteLayout(
  props: ParentProps<{
    newLayout: Accessor<boolean>
    server: Accessor<ServerConnection.Any | undefined>
    serverScoped?: JSX.Element
  }>,
) {
  const params = useParams<{ id: string }>()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)

  return (
    <Show when={props.newLayout() || directory()}>
      <ProductRouteLayout
        newLayout={props.newLayout}
        directory={directory}
        server={props.server}
        serverScoped={props.serverScoped}
      >
        {props.children}
      </ProductRouteLayout>
    </Show>
  )
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell (Permission/Layout/
// Notification/Models + the visual Layout) for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ProductMigrationGate>
        <LegacyServerScopedShell serverScoped={props.serverScoped}>{props.children}</LegacyServerScopedShell>
      </ProductMigrationGate>
    </SelectedServerProviders>
  )
}

function DraftRoute(props: { serverScoped?: JSX.Element }) {
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  return (
    <Show when={tabs.ready()}>
      <Show
        when={tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)}
        keyed
        fallback={<Navigate href="/" />}
      >
        {(draft) => <ResolvedDraftRoute draft={draft} serverScoped={props.serverScoped} />}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab; serverScoped?: JSX.Element }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  const available = () => !!conn() && global.servers.health[props.draft.server] !== undefined

  return (
    <ServerAvailabilityGate serverKey={serverKey} available={available}>
      <ProductProvider server={conn}>
        <ResolvedDraftRouteContent
          conn={conn}
          directory={directory}
          serverKey={serverKey}
          serverScoped={props.serverScoped}
        />
      </ProductProvider>
    </ServerAvailabilityGate>
  )
}

function ResolvedDraftRouteContent(props: {
  conn: () => ServerConnection.Any | undefined
  directory: () => string
  serverKey: () => ServerConnection.Key
  serverScoped?: JSX.Element
}) {
  const newLayout = useProductLayout()
  const server = useServer()
  const direct = () => newLayout() || props.serverKey() !== server.key
  return (
    <Show when={direct()} fallback={<Navigate href={`/${base64Encode(props.directory())}/session`} />}>
      <>
        <BodyDesignClass newLayout={newLayout} />
        <ServerSDKProvider server={props.conn}>
          <ServerSyncProvider server={props.conn}>
            <ProductMigrationGate>
              <ProductRouteLayout
                newLayout={newLayout}
                directory={props.directory}
                server={props.conn}
                serverScoped={props.serverScoped}
              >
              <Show
                when={newLayout()}
                fallback={
                  <SDKProvider directory={props.directory}>
                    <DirectoryDataProvider directory={props.directory} server={props.serverKey}>
                      <SessionPage />
                    </DirectoryDataProvider>
                  </SDKProvider>
                }
              >
                <DraftServerScopedProviders directory={props.directory}>
                  <SDKProvider directory={props.directory}>
                    <DirectoryDataProvider directory={props.directory} server={props.serverKey}>
                      <DraftProviders>
                        <NewSession />
                      </DraftProviders>
                    </DirectoryDataProvider>
                  </SDKProvider>
                </DraftServerScopedProviders>
              </Show>
              </ProductRouteLayout>
            </ProductMigrationGate>
          </ServerSyncProvider>
        </ServerSDKProvider>
      </>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass(props: { newLayout?: Accessor<boolean> }) {
  const productLayout = useProductLayout()
  if (typeof document !== "undefined") syncBodyDesignMode(props.newLayout ?? productLayout, document.body)

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  sessionID?: () => string | undefined
  server?: Accessor<ServerConnection.Any | undefined>
  serverScoped?: JSX.Element
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <PermissionProvider directory={props.directory}>
      <LayoutProvider server={props.server}>
        {props.serverScoped}
        <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
      </LayoutProvider>
    </PermissionProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders
      directory={props.directory}
      sessionID={props.sessionID}
      server={props.server}
      serverScoped={props.serverScoped}
    >
      <LegacyLayout directory={props.directory} server={props.server}>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ProductMigrationGate>
        <ServerScopedProviders serverScoped={props.serverScoped}>
          <NewLayout>{props.children}</NewLayout>
        </ServerScopedProviders>
      </ProductMigrationGate>
    </SelectedServerProviders>
  )
}

function ProductRouteLayout(
  props: ParentProps<{
    newLayout: Accessor<boolean>
    directory?: () => string | undefined
    server?: Accessor<ServerConnection.Any | undefined>
    serverScoped?: JSX.Element
  }>,
) {
  return (
    <Show
      when={props.newLayout()}
      fallback={
        <LegacyServerScopedShell
          directory={props.directory}
          server={props.server}
          serverScoped={props.serverScoped}
        >
          {props.children}
        </LegacyServerScopedShell>
      }
    >
      <ServerScopedProviders directory={props.directory} server={props.server} serverScoped={props.serverScoped}>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </Show>
  )
}

function ProductMigrationGate(props: ParentProps) {
  const sync = useServerSync()
  const migration = () => sync().productMigration
  const unlocked = () =>
    migration().status === "unavailable" ||
    (migration().status === "required" && migration().projection?.status === "completed")

  return (
    <Switch>
      <Match when={unlocked()}>{props.children}</Match>
      <Match when={migration().status === "required" && migration().projection}>
        <ProductMigrationPage
          controller={{
            projection: () => migration().projection!,
            conflict: () => migration().conflict,
            pending: () => migration().pending,
            discover: migration().discover,
            updateDraft: migration().updateDraft,
            execute: migration().execute,
            pause: migration().pause,
            retry: migration().retry,
            skip: migration().skip,
            validate: migration().validate,
            finalize: migration().finalize,
            freshStart: migration().freshStart,
            refresh: migration().refresh,
          }}
        />
      </Match>
      <Match when={migration().status === "error"}>
        <main class="flex min-h-dvh items-center justify-center bg-background-base p-6" aria-label="Graph Vibe data transfer checkpoint">
          <div role="alert" class="max-w-md border-l-2 border-icon-critical-base pl-5">
            <h1 class="text-18-medium text-text-strong">Migration checkpoint unavailable</h1>
            <p class="mt-2 text-13-regular text-text-base">Normal navigation remains locked because the migration service could not be verified.</p>
            <button type="button" class="mt-5 min-h-11 border border-border-strong-base px-4 text-13-medium hover:bg-surface-base-hover" onClick={() => migration().refresh()}>Retry checkpoint</button>
          </div>
        </main>
      </Match>
      <Match when={true}>
        <main class="flex min-h-dvh items-center justify-center bg-background-base" aria-label="Graph Vibe data transfer checkpoint">
          <div role="status" class="font-mono text-11-medium uppercase tracking-wider text-text-weak">Loading transfer checkpoint…</div>
        </main>
      </Match>
    </Switch>
  )
}

function DraftServerScopedProviders(props: ParentProps<{ directory?: () => string | undefined }>) {
  return (
    <PermissionProvider directory={props.directory}>
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </PermissionProvider>
  )
}

// The draft page only renders the prompt composer, so it drops TerminalProvider.
// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  const [startup] = createResource(async () => {
    if (!props.startup) return true
    await props.startup.catch((error) => {
      console.error("[startup] startup gate failed", error)
    })
    return true
  })
  const startupChecking = createMemo(
    () => startupHealthCheck.latest === true && ["unresolved", "pending"].includes(startup.state),
  )
  const loading = createMemo(() => checking() || startupChecking())

  return (
    <>
      <Show when={!checking()}>
        <Show
          when={startupHealthCheck.latest}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (checkMode() === "background") void healthCheckActions.refetch()
              }}
              onServerSelected={(key) => {
                setCheckMode("blocking")
                server.setActive(key)
                void healthCheckActions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={loading()}>
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  startup?: Promise<void>
  serverScoped?: JSX.Element
}) {
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  const RouterShell = () => {
    const settings = useSettings()
    const productLayout = useProductLayout()
    const global = useGlobal()
    const server = useServer()
    const ready = () => settings.general.newLayoutDesigns() || global.servers.health[server.key] !== undefined
    const RoutedLayout = (layoutProps: ParentProps) => {
      const location = useLocation()
      const routeScoped = () => isTargetScopedRoute(location.pathname)
      return (
        <Show when={!routeScoped() && productLayout()} fallback={layoutProps.children}>
          <NewAppLayout serverScoped={props.serverScoped}>{layoutProps.children}</NewAppLayout>
        </Show>
      )
    }
    return (
      <Show when={ready()}>
        <Show when={productLayout().toString()} keyed>
          <Dynamic
            component={props.router ?? Router}
            root={(routerProps) => (
              <TabsProvider>
                <NotificationProvider>
                  <ServerShell>
                    <RoutedLayout>{routerProps.children}</RoutedLayout>
                  </ServerShell>
                </NotificationProvider>
              </TabsProvider>
            )}
          >
            <Routes serverScoped={props.serverScoped} />
          </Dynamic>
        </Show>
      </Show>
    )
  }

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <GlobalProvider>
        <ProductProvider>
          <SettingsProvider>
            <ConnectionGate disableHealthCheck={props.disableHealthCheck} startup={props.startup}>
              <RouterShell />
            </ConnectionGate>
          </SettingsProvider>
        </ProductProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes(props: { serverScoped?: JSX.Element }) {
  const newLayout = useProductLayout()

  return (
    <>
      <Route
        component={(routeProps) => (
          <LegacyServerLayout serverScoped={props.serverScoped}>{routeProps.children}</LegacyServerLayout>
        )}
      >
        <Show when={!newLayout()}>
          {
            <Route path="/" component={LegacyHome} />
          }
        </Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
          <Route path="/session/:id/graph" component={GraphPage} />
        </Route>
      </Route>
      <Show when={newLayout()}>
        <Route path="/" component={NewHome} />
        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />
      </Show>
      <Route path="/new-session" component={() => <DraftRoute serverScoped={props.serverScoped} />} />
      <Route
        path="/server/:serverKey/session/:id"
        component={() => <TargetSessionRoute serverScoped={props.serverScoped} />}
      />
      <Route
        path="/server/:serverKey/session/:id/graph"
        component={() => <TargetGraphRoute serverScoped={props.serverScoped} />}
      />
    </>
  )
}

function NewLayoutLegacySessionRedirect() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      <Navigate
        href={sessionHref(
          legacySessionServer(
            tabs.store.filter((item) => item.type === "session"),
            params.id,
            server.key,
          ),
          params.id,
        )}
      />
    </Show>
  )
}

function TargetGraphRoute(props: { serverScoped?: JSX.Element }) {
  const params = useParams<{ serverKey: string; id: string }>()
  return (
    <TargetServerRoute
      render={(newLayout, server) => (
        <SessionRouteErrorBoundary
          sessionID={params.id}
          serverKey={requireServerKey(params.serverKey)}
          padded={newLayout()}
          newLayout={newLayout}
        >
          <TargetRouteLayout
            newLayout={newLayout}
            server={server}
            serverScoped={props.serverScoped}
          >
            <TargetGraphRouteContent />
          </TargetRouteLayout>
        </SessionRouteErrorBoundary>
      )}
    />
  )
}

function TargetGraphRouteContent() {
  const params = useParams<{ serverKey: string; id: string }>()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)

  return (
    <Show when={directory()} keyed>
      {(dir) => (
        <SDKProvider directory={dir}>
          <DirectoryDataProvider directory={dir}>
            <GraphPage />
          </DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
