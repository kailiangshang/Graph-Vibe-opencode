const platformPackage =
  /^opencode-(?:linux-(?:arm64(?:-musl)?|x64(?:-baseline)?(?:-musl)?)|darwin-(?:arm64|x64(?:-baseline)?)|windows-(?:arm64|x64(?:-baseline)?))$/

export function isOpenCodePlatformPackage(name: string) {
  return platformPackage.test(name)
}

export function packageManifests(version: string, binaries: Record<string, string>, license = "MIT") {
  const platforms = Object.entries(binaries).filter(([name]) => isOpenCodePlatformPackage(name))
  const shared = {
    scripts: { postinstall: "node ./postinstall.mjs" },
    version,
    license,
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
  }
  return {
    opencode: {
      name: "opencode-ai",
      bin: { opencode: "./bin/opencode.exe" },
      optionalDependencies: Object.fromEntries(platforms),
      ...shared,
    },
    graphVibe: {
      name: "graph-vibe",
      bin: { "graph-vibe": "./bin/graph-vibe.cjs" },
      optionalDependencies: Object.fromEntries(
        platforms.map(([name, binaryVersion]) => [name.replace(/^opencode-/, "graph-vibe-"), binaryVersion]),
      ),
      ...shared,
    },
  }
}
