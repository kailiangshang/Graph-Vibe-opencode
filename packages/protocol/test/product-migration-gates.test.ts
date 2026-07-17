import { describe, expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makePermissionGroup } from "../src/groups/permission"
import { PtyGroup } from "../src/groups/pty"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/LocationMiddleware") {}
class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

const spec = OpenApi.fromApi(
  HttpApi.make("migration-gates")
    .add(makePermissionGroup(LocationMiddleware, SessionLocationMiddleware))
    .add(PtyGroup),
)

function operation(path: string, method: string) {
  const operation = spec.paths[path]?.[method as "get"]
  if (!operation) throw new Error(`Missing ${method.toUpperCase()} ${path}`)
  return JSON.stringify(operation.responses?.["404"]) ?? ""
}

describe("product migration mutation contracts", () => {
  test("permission mutations declare ProductMigrationRequired", () => {
    expect(operation("/api/session/{sessionID}/permission", "post")).toContain("ProductMigrationRequired")
    expect(operation("/api/session/{sessionID}/permission/{requestID}/reply", "post")).toContain(
      "ProductMigrationRequired",
    )
    expect(operation("/api/permission/saved/{id}", "delete")).toContain("ProductMigrationRequired")
    expect(operation("/api/permission/request", "get")).not.toContain("ProductMigrationRequired")
    expect(operation("/api/session/{sessionID}/permission/{requestID}", "get")).not.toContain(
      "ProductMigrationRequired",
    )
  })

  test("PTY mutations declare ProductMigrationRequired", () => {
    expect(operation("/api/pty", "post")).toContain("ProductMigrationRequired")
    expect(operation("/api/pty/{ptyID}", "put")).toContain("ProductMigrationRequired")
    expect(operation("/api/pty/{ptyID}", "delete")).toContain("ProductMigrationRequired")
    expect(operation("/api/pty/{ptyID}/connect-token", "post")).toContain("ProductMigrationRequired")
    expect(operation("/api/pty/{ptyID}/connect", "get")).toContain("ProductMigrationRequired")
    expect(operation("/api/pty", "get")).not.toContain("ProductMigrationRequired")
    expect(operation("/api/pty/{ptyID}", "get")).not.toContain("ProductMigrationRequired")
  })
})
