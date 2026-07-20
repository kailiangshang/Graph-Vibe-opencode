import { authFromToken } from "./server"

export type StartupAuthTokenStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function resolveStartupAuthToken(input: {
  serverUrl: string
  search: URLSearchParams
  storage: () => StartupAuthTokenStorage
}) {
  const key = `opencode.startupAuthToken.v1:${encodeURIComponent(input.serverUrl)}`
  const storage = accessStorage(input.storage)

  if (!input.search.has("auth_token")) {
    const token = readStorage(storage, key)
    if (authFromToken(token)) return token ?? undefined
    if (token !== null) removeStorage(storage, key)
    return
  }

  const token = input.search.get("auth_token")
  if (token === null || !authFromToken(token)) {
    removeStorage(storage, key)
    return
  }

  writeStorage(storage, key, token)
  return token
}

function accessStorage(access: () => StartupAuthTokenStorage) {
  try {
    return access()
  } catch {
    return undefined
  }
}

function readStorage(storage: StartupAuthTokenStorage | undefined, key: string) {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(storage: StartupAuthTokenStorage | undefined, key: string, value: string) {
  if (!storage) return
  try {
    storage.setItem(key, value)
  } catch {
    return
  }
}

function removeStorage(storage: StartupAuthTokenStorage | undefined, key: string) {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    return
  }
}
