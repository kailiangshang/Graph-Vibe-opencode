import { describe, expect, test } from "bun:test"
import { Product } from "@opencode-ai/core/product"
import { uninstallPackageCommand, uninstallShellIdentity } from "../../src/cli/cmd/uninstall"

describe("product uninstall identity", () => {
  test("Graph Vibe never targets OpenCode packages or shell paths", () => {
    const command = uninstallPackageCommand(Product.GraphVibe, "npm")
    expect(command).toEqual(["npm", "uninstall", "-g", "graph-vibe"])
    expect(uninstallPackageCommand(Product.GraphVibe, "brew")).toEqual(["brew", "uninstall", "graph-vibe"])
    expect(uninstallShellIdentity(Product.GraphVibe)).toEqual({ marker: "# graph-vibe", bin: ".graph-vibe/bin" })
    expect(command?.join(" ")).not.toContain("opencode")
  })

  test("OpenCode retains existing package identity", () => {
    expect(uninstallPackageCommand(Product.OpenCode, "npm")).toEqual(["npm", "uninstall", "-g", "opencode-ai"])
    expect(uninstallShellIdentity(Product.OpenCode)).toEqual({ marker: "# opencode", bin: ".opencode/bin" })
  })
})
