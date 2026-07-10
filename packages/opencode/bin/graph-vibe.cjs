#!/usr/bin/env node

const childProcess = require("child_process")
const path = require("path")

const child = childProcess.spawn(
  process.env.OPENCODE_BIN_PATH || path.join(__dirname, "opencode.exe"),
  process.argv.slice(2),
  {
    stdio: "inherit",
    env: { ...process.env, OPENCODE_CLIENT: "graph-vibe", OPENCODE_ENABLE_GRAPH_MODE: "1" },
  },
)

const forwarders = Object.fromEntries(
  ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
    signal,
    () => {
      if (!child.killed) child.kill(signal)
    },
  ]),
)

for (const [signal, forward] of Object.entries(forwarders)) process.on(signal, forward)

child.on("error", (error) => {
  console.error(error.message)
  process.exit(1)
})

child.on("exit", (code, signal) => {
  for (const [name, forward] of Object.entries(forwarders)) process.removeListener(name, forward)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(typeof code === "number" ? code : 0)
})
