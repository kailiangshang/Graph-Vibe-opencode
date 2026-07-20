export function isTargetScopedRoute(pathname: string) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  return normalized === "/new-session" || normalized.startsWith("/server/")
}
