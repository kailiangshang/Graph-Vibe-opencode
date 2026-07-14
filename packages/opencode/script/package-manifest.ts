export function packageManifests(version: string, binaries: Record<string, string>, license = "MIT") {
  const shared = {
    scripts: { postinstall: "node ./postinstall.mjs" },
    version,
    license,
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    optionalDependencies: binaries,
  }
  return {
    opencode: {
      name: "opencode-ai",
      bin: { opencode: "./bin/opencode.exe" },
      ...shared,
    },
    graphVibe: {
      name: "graph-vibe",
      bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
      ...shared,
    },
  }
}
