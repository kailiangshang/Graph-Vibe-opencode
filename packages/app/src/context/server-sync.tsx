import type {
  Config,
  McpResource,
  OpencodeClient,
  Path,
  ProductMigrationDraftPayload,
  ProductMigrationProjection,
  Project,
  ProviderAuthResponse,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@opencode-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession } from "./server-session"

type ProductMigrationResult =
  | { kind: "required"; projection: ProductMigrationProjection }
  | { kind: "unavailable" }

export function productMigrationResult(response: { data?: ProductMigrationProjection; error?: unknown }): ProductMigrationResult {
  if (response.data) return { kind: "required", projection: response.data }
  if (
    response.error &&
    typeof response.error === "object" &&
    "_tag" in response.error &&
    response.error._tag === "ProductMigrationUnavailable"
  )
    return { kind: "unavailable" }
  throw response.error instanceof Error ? response.error : new Error("Product migration checkpoint unavailable")
}

export function productMigrationErrorMessage(error: unknown) {
  if (!error || typeof error !== "object" || !("_tag" in error)) {
    return "Migration action could not complete. Review the refreshed protected status."
  }
  if (error._tag === "ProductMigrationInsufficientSpace" && "requiredBytes" in error && "availableBytes" in error) {
    const bytes = (value: unknown) => {
      const amount = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
      return amount < 1_024 ? `${amount} B` : `${(amount / 1_024).toFixed(1)} KB`
    }
    return `Insufficient target space: ${bytes(error.requiredBytes)} required, ${bytes(error.availableBytes)} available.`
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
  if (error._tag === "ProductMigrationInsufficientSpace") return "The target does not have enough free space."
  if (error._tag === "ProductMigrationConflict") return "Migration data conflicts with the protected plan."
  if (error._tag === "ProductMigrationItemNotFound") return "The selected migration item is no longer available."
  if (error._tag === "ProductMigrationFinalized") return "Migration has already been finalized."
  return "Migration action could not complete. Review the refreshed protected status."
}

export function productMigrationProjectionIsCurrent(
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

export async function pollProductMigration(input: {
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
    if (projection && (!current || productMigrationProjectionIsCurrent(projection, current))) input.update(projection)
  }
}

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadMcpResourcesQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions<Record<string, McpResource>>({
    queryKey: [scope, directory, "mcpResources"] as const,
    queryFn: () => sdk.experimental.resource.list().then((r) => r.data ?? {}),
    placeholderData: {},
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  sdkFor: (dir: PathKey) => OpencodeClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, sdkFor(directory)),
    references: (directory: PathKey) => loadReferencesQuery(scope, directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory)),
    mcpResources: (directory: PathKey) => loadMcpResourcesQuery(scope, directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const productMigrationClient = serverSDK.createClient({ throwOnError: false })
  const productMigrationKey = [serverSDK.scope, "productMigration"] as const
  const productMigrationQuery = useQuery(() => ({
    queryKey: productMigrationKey,
    retry: false,
    queryFn: () => productMigrationClient.productMigration.get().then(productMigrationResult),
  }))
  const [productMigrationStore, setProductMigrationStore] = createStore({
    pending: 0,
    executing: false,
    conflict: undefined as string | undefined,
  })
  let productMigrationDisposed = false
  let productMigrationConcurrent = false
  onCleanup(() => {
    productMigrationDisposed = true
    setProductMigrationStore("executing", false)
  })

  const requireProductMigration = () => {
    const result = productMigrationQuery.data
    if (result?.kind !== "required") throw new Error("Product migration projection is not available")
    return result.projection
  }

  const applyProductMigration = (
    action: () => Promise<{ data?: ProductMigrationProjection; error?: unknown }>,
    options: { concurrent?: boolean; poll?: boolean } = {},
  ) => {
    if ((productMigrationStore.pending > 0 && !options.concurrent) || (options.concurrent && productMigrationConcurrent)) {
      return Promise.resolve()
    }
    if (options.concurrent) productMigrationConcurrent = true
    setProductMigrationStore({
      pending: productMigrationStore.pending + 1,
      executing: options.poll || productMigrationStore.executing,
      conflict: undefined,
    })
    const request = action()
    const polling = options.poll
      ? pollProductMigration({
          active: () => !productMigrationDisposed && productMigrationStore.executing,
          current: () => requireProductMigration(),
          get: () => productMigrationClient.productMigration.get().then((response) => response.data),
          update: (projection) =>
            queryClient.setQueryData(productMigrationKey, {
              kind: "required",
              projection,
            } satisfies ProductMigrationResult),
        })
      : Promise.resolve()
    const refreshFailure = async (error?: unknown) => {
      await productMigrationQuery.refetch()
      setProductMigrationStore("conflict", productMigrationErrorMessage(error))
    }
    return request
      .then(async (response) => {
        if (response.data) {
          const current = requireProductMigration()
          if (!productMigrationProjectionIsCurrent(response.data, current)) return
          if (options.poll || response.data.status !== "copying") setProductMigrationStore("executing", false)
          queryClient.setQueryData(productMigrationKey, { kind: "required", projection: response.data } satisfies ProductMigrationResult)
          return
        }
        if (
          response.error &&
          typeof response.error === "object" &&
          "_tag" in response.error &&
          response.error._tag === "ProductMigrationRevisionConflict"
        ) {
          const refreshed = await productMigrationQuery.refetch()
          if (refreshed.data?.kind === "required")
            setProductMigrationStore(
              "conflict",
              `Migration changed to revision ${refreshed.data.projection.revision}. Review the refreshed plan.`,
            )
          return
        }
        await refreshFailure(response.error)
      }, refreshFailure)
      .finally(async () => {
        if (options.poll) setProductMigrationStore("executing", false)
        if (options.concurrent) productMigrationConcurrent = false
        setProductMigrationStore("pending", Math.max(0, productMigrationStore.pending - 1))
        await polling
      })
  }

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const session = createServerSession(serverSDK.client)

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void retry(() =>
        sdkFor(directory)
          .command.list()
          .then((x) => setStore("command", x.data ?? [])),
      ).catch((err) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => serverSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    session.apply(event)

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
      loadReferences: () => {
        void queryClient.fetchQuery(queryOptionsApi.references(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    session,
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
            await queryClient.refetchQueries(queryOptionsApi.mcpResources(key))
          },
        })
      },
    },
    productMigration: {
      get status() {
        if (productMigrationQuery.isPending) return "loading" as const
        if (productMigrationQuery.isError) return "error" as const
        return productMigrationQuery.data?.kind ?? ("error" as const)
      },
      get projection() {
        const result = productMigrationQuery.data
        return result?.kind === "required" ? result.projection : undefined
      },
      get pending() {
        return productMigrationStore.pending > 0
      },
      get conflict() {
        return productMigrationStore.conflict
      },
      refresh: () =>
        productMigrationQuery.refetch().then((result) => {
          setProductMigrationStore("conflict", undefined)
          return result.data
        }),
      discover: () =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.discover({
            productMigrationDiscoverPayload: {
              expectedRevision: requireProductMigration().revision,
              currentProject: globalStore.path.directory || undefined,
            },
          }),
        ),
      updateDraft: (payload: ProductMigrationDraftPayload) =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.updateDraft({ productMigrationDraftPayload: payload }),
        ),
      execute: () =>
        applyProductMigration(
          () =>
            productMigrationClient.productMigration.execute({
              productMigrationRevisionPayload: { expectedRevision: requireProductMigration().revision },
            }),
          { poll: true },
        ),
      pause: () =>
        applyProductMigration(
          () =>
            productMigrationClient.productMigration.pause({
              productMigrationRevisionPayload: { expectedRevision: requireProductMigration().revision },
            }),
          { concurrent: true },
        ),
      retry: (itemID: string) =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.retry({
            productMigrationItemPayload: { expectedRevision: requireProductMigration().revision, itemID },
          }),
        ),
      skip: (itemID: string) =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.skip({
            productMigrationItemPayload: { expectedRevision: requireProductMigration().revision, itemID },
          }),
        ),
      validate: () =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.validate({
            productMigrationRevisionPayload: { expectedRevision: requireProductMigration().revision },
          }),
        ),
      finalize: () =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.finalize({
            productMigrationRevisionPayload: { expectedRevision: requireProductMigration().revision },
          }),
        ),
      freshStart: () =>
        applyProductMigration(() =>
          productMigrationClient.productMigration.freshStart({
            productMigrationRevisionPayload: { expectedRevision: requireProductMigration().revision },
          }),
        ),
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
