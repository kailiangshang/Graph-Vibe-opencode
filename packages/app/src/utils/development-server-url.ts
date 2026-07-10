export function developmentServerUrl(hostname: string, port: string, pageOrigin: string) {
  if (hostname !== "0.0.0.0" && hostname !== "::") return `http://${hostname}:${port}`
  const url = new URL(pageOrigin)
  url.port = port
  return url.origin
}
