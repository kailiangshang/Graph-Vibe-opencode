# Graph Storage Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the graph persistence layer (3 tables + Effect storage service + CurrentPlan/promote mechanics) to opencode, fully test-driven, zero manual divergence.

**Architecture:** drizzle tables in a new `packages/core/src/graph/sql.ts` (auto-discovered by the migration generator) → `bun run script/migration.ts --name graph` regenerates `schema.gen.ts`/`migration.gen.ts` + emits the migration (generated artifacts, not hand-edits). ID/enum contracts in `packages/schema/src/graph.ts`. An Effect `GraphStorage` service (opencode `Context.Service` pattern) over `Database.Service`. Tests with in-memory sqlite. Enums are enforced Schema-level (opencode convention — no DB `CHECK`); `UNIQUE` rules are DB indexes.

**Tech Stack:** Bun, drizzle-orm/sqlite-core, effect (`Context.Service`, `Layer`, `Schema.TaggedErrorClass`), `@opencode-ai/schema`, `bun:test`.

**Spec:** `docs/specs/2026-06-27-graph-storage.md`. **Patterns reference:** `permission/sql.ts`, `permission/saved.ts`, `database/schema.sql.ts`, `test/database-migration.test.ts`.

**Convention notes (mirror exactly):** snake_case columns; `...Timestamps` spread; `.$type<DomainID>()` for branded IDs; self-export `export * as GraphStorage from "./storage"` on line 1; tag `"@opencode/v2/GraphStorage"`; `Effect.fn("GraphStorage.method")` wrappers; `.pipe(Effect.orDie)` on drizzle ops.

---

### Task 1: Schema contracts (`packages/schema/src/graph.ts`)

**Files:** Create `packages/schema/src/graph.ts`. Verify export resolves as `@opencode-ai/schema/graph` (mirror how `permission-saved.ts` is exported — check `packages/schema/package.json` `exports` and add an entry ONLY if per-file exports are enumerated; if `"./*": "./src/*.ts"` wildcard exists, no edit needed).

- [ ] **Step 1: Write the contracts**

```ts
import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

// IDs (prefix MUST match brand + validate exactly)
export const NodeID = Schema.String.pipe(
  Schema.brand("GraphNode.ID"),
  statics((s) => ({ create: () => s.make("gnd_" + ascending()) })),
)
export type NodeID = typeof NodeID.Type

export const EdgeID = Schema.String.pipe(
  Schema.brand("GraphEdge.ID"),
  statics((s) => ({ create: () => s.make("ged_" + ascending()) })),
)
export type EdgeID = typeof EdgeID.Type

export const VersionID = Schema.String.pipe(
  Schema.brand("GraphVersion.ID"),
  statics((s) => ({ create: () => s.make("gvr_" + ascending()) })),
)
export type VersionID = typeof VersionID.Type

// Enums (Schema-level enforcement; DB stores plain text)
export const NodeType = Schema.Literal("prd", "composite", "atomic")
export const Level = Schema.Literal("L1", "L2")
export const Priority = Schema.Literal("P0", "P1", "P2", "P3")
export const NodeStatus = Schema.Literal("pending", "implemented", "verified", "deprecated")
export const TestStatus = Schema.Literal("none", "pending", "passed", "failed")
export const EdgeRelation = Schema.Literal("contains", "blocks", "addresses", "uses", "deprecated_by")

// Open content map (code_ref, project_type/module, generation_context, …)
export const NodeContent = Schema.Record({ key: Schema.String, value: Schema.Unknown })
export type NodeContent = typeof NodeContent.Type
```

- [ ] **Step 2: Verify it compiles + resolves**

Run: `cd packages/schema && bun typecheck` (or `bun -e 'import("@opencode-ai/schema/graph").then(m=>console.log(Object.keys(m)))'`).
Expected: compiles; exports present.

- [ ] **Step 3: Commit**

```bash
git add packages/schema/src/graph.ts
git commit -m "feat(schema): add graph node/edge/version ID and enum contracts"
```

---

### Task 2: Drizzle tables (`packages/core/src/graph/sql.ts`)

**Files:** Create `packages/core/src/graph/sql.ts`. Verify `SessionTable` is the export name in `packages/core/src/session/sql.ts` (mirror how `permission/sql.ts` imports `ProjectTable` from `../project/sql`).

- [ ] **Step 1: Write the 3 tables**

```ts
import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import * as Graph from "@opencode-ai/schema/graph"

export const GraphNodeTable = sqliteTable(
  "graph_node",
  {
    id: text().$type<Graph.NodeID>().primaryKey(),
    project_id: text().$type<ProjectV2.ID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<string>().references(() => SessionTable.id, { onDelete: "cascade" }), // null=main graph
    type: text().$type<Graph.NodeType.Type>().notNull(),
    name: text().notNull(),
    level: text().$type<Graph.Level.Type>().notNull(),
    priority: text().$type<Graph.Priority.Type>(),
    category: text(),
    status: text().$type<Graph.NodeStatus.Type>().notNull().default("pending"),
    desc: text(),
    content: text({ mode: "json" }).$type<Graph.NodeContent>(),
    code_hash: text(),
    test_status: text().$type<Graph.TestStatus.Type>().notNull().default("none"),
    confidence: real().notNull().default(1),
    ...Timestamps,
  },
  (t) => [
    index("graph_node_project_idx").on(t.project_id),
    index("graph_node_project_session_idx").on(t.project_id, t.session_id),
    index("graph_node_project_type_idx").on(t.project_id, t.type),
    index("graph_node_project_status_idx").on(t.project_id, t.status),
    index("graph_node_session_idx").on(t.session_id),
  ],
)

export const GraphEdgeTable = sqliteTable(
  "graph_edge",
  {
    id: text().$type<Graph.EdgeID>().primaryKey(),
    project_id: text().$type<ProjectV2.ID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<string>().references(() => SessionTable.id, { onDelete: "cascade" }),
    source_id: text().$type<Graph.NodeID>().notNull().references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    target_id: text().$type<Graph.NodeID>().notNull().references(() => GraphNodeTable.id, { onDelete: "cascade" }),
    relation: text().$type<Graph.EdgeRelation.Type>().notNull(),
    confidence: real().notNull().default(1),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (t) => [
    uniqueIndex("graph_edge_src_tgt_rel_idx").on(t.source_id, t.target_id, t.relation),
    index("graph_edge_project_idx").on(t.project_id),
    index("graph_edge_project_session_idx").on(t.project_id, t.session_id),
    index("graph_edge_source_relation_idx").on(t.source_id, t.relation),
    index("graph_edge_target_idx").on(t.target_id),
  ],
)

export const GraphVersionTable = sqliteTable(
  "graph_version",
  {
    id: text().$type<Graph.VersionID>().primaryKey(),
    project_id: text().$type<ProjectV2.ID>().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<string>().references(() => SessionTable.id, { onDelete: "cascade" }),
    version_number: integer().notNull(),
    message: text(),
    snapshot: text({ mode: "json" }).$type<{ nodes: unknown[]; edges: unknown[] }>().notNull(),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (t) => [
    uniqueIndex("graph_version_project_number_idx").on(t.project_id, t.version_number),
    index("graph_version_project_created_idx").on(t.project_id, t.time_created),
  ],
)
```

- [ ] **Step 2: Verify `SessionTable` export name**

Run: `grep -n "export const SessionTable" packages/core/src/session/sql.ts`. If the name differs, fix the import in Step 1.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/graph/sql.ts
git commit -m "feat(core/graph): add graph_node/edge/version drizzle tables"
```

---

### Task 3: Generate migration

- [ ] **Step 1: Run the generator**

Run: `cd packages/core && bun run script/migration.ts --name graph`
Expected: prints creation of `migration/<timestamp>_graph.ts`; rewrites `schema.gen.ts` + `migration.gen.ts`; updates `schema.json`.

- [ ] **Step 2: Verify no drift**

Run: `cd packages/core && bun run script/migration.ts --check`
Expected: `No schema changes, nothing to migrate`.

- [ ] **Step 3: Verify tables exist on a fresh in-memory DB** (smoke)

Run: `cd packages/core && bun -e 'import{Effect}from"effect";import{SqliteClient}from"@effect/sql-sqlite-bun";import{EffectDrizzleSqlite}from"@opencode-ai/effect-drizzle-sqlite";import{DatabaseMigration}from"./src/database/migration";const run=<A,E>(e:Effect.Effect<A,E,any>)=>Effect.runPromise(e.pipe(Effect.provide(SqliteClient.layer({filename:":memory:",disableWAL:true})),Effect.scoped));run(Effect.gen(function*(){const m=EffectDrizzleSqlite.makeWithDefaults();const db=yield* m;yield* DatabaseMigration.apply(db);const r=yield* db.get({}as any,"SELECT name FROM sqlite_master WHERE type=\x27table\x27 AND name=\x27graph_node\x27");console.log("graph_node table:",r)}))()'`
Expected: prints the `graph_node` row. (Adjust the raw call signature to match the actual `db.get` overload seen in `database-migration.test.ts`.)

- [ ] **Step 4: Commit generated artifacts**

```bash
git add packages/core/src/database/schema.gen.ts packages/core/src/database/migration.gen.ts packages/core/src/database/migration/<timestamp>_graph.ts packages/core/schema.json
git commit -m "chore(core/graph): generate graph migration"
```

---

### Task 4: `GraphStorage` service — node CRUD (TDD)

**Files:** Create `packages/core/src/graph/storage.ts` and `packages/core/test/graph.test.ts`.

- [ ] **Step 1: Write the failing test (node CRUD)**

`packages/core/test/graph.test.ts`:
```ts
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Database } from "@opencode-ai/core/database/database"
import * as GraphStorage from "@opencode-ai/core/graph/storage"

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const provide = (effect: Effect.Effect<any, any, any>) =>
  run(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      return yield* effect
    }).pipe(Effect.provide(Layer.merge(Database.layer, GraphStorage.layer))),
    // NOTE: if Database.layer needs the sqlite client too, also provide SqliteClient.layer here; mirror database-migration.test.ts setup.
  )

const PID = "proj_test" as any // a ProjectV2.ID — or insert a project row first in a helper

describe("GraphStorage.node", () => {
  test("create/get/update/delete with defaults", async () => {
    await provide(
      Effect.gen(function* () {
        const g = yield* GraphStorage.Service
        const id = yield* g.node.create({ projectID: PID, type: "atomic", name: "UserSvc", level: "L2" })
        let n = yield* g.node.get(id)
        expect(n.status).toBe("pending")
        expect(n.test_status).toBe("none")
        expect(n.confidence).toBe(1)
        yield* g.node.update(id, { status: "implemented" })
        n = yield* g.node.get(id)
        expect(n.status).toBe("implemented")
        yield* g.node.delete(id)
        await expect(Effect.runPromise(g.node.get(id).pipe(Effect.provide(Layer.succeed(GraphStorage.Service, ...))))).rejects.toThrow()
      }),
    )
  })
})
```
(Remove the awkward last line — replace with a clean "get after delete yields NotFound" assertion using a helper that catches the error via `Effect.either`.)

- [ ] **Step 2: Run, confirm it fails**

Run: `cd packages/core && bun test test/graph.test.ts`
Expected: FAIL — module `@opencode-ai/core/graph/storage` not found.

- [ ] **Step 3: Implement the service (node CRUD + skeleton)**

`packages/core/src/graph/storage.ts`:
```ts
export * as GraphStorage from "./storage"

import { eq, and, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { GraphNodeTable, GraphEdgeTable, GraphVersionTable } from "./sql"
import * as Graph from "@opencode-ai/schema/graph"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("GraphV2.NotFoundError", {
  kind: Schema.Literal("node", "edge", "version"),
  id: Schema.String,
}) {}

export interface NodeRow {
  id: Graph.NodeID
  projectID: ProjectID
  sessionID: string | null
  type: Graph.NodeType.Type
  name: string
  level: Graph.Level.Type
  priority: Graph.Priority.Type | null
  category: string | null
  status: Graph.NodeStatus.Type
  desc: string | null
  content: Graph.NodeContent | null
  codeHash: string | null
  testStatus: Graph.TestStatus.Type
  confidence: number
  timeCreated: number
  timeUpdated: number
}

// (define EdgeRow, VersionRow similarly; define input Schema.Struct for create/list filters)

export interface Interface {
  node: {
    create: (input: NodeCreateInput) => Effect.Effect<Graph.NodeID, never, never>
    get: (id: Graph.NodeID) => Effect.Effect<NodeRow, NotFoundError>
    update: (id: Graph.NodeID, patch: NodePatch) => Effect.Effect<void, NotFoundError>
    delete: (id: Graph.NodeID) => Effect.Effect<void>
    list: (filter: NodeFilter) => Effect.Effect<ReadonlyArray<NodeRow>>
  }
  // edge, main, currentPlan, promote, version added in later tasks
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GraphStorage") {}

const rowToNode = (r: typeof GraphNodeTable.$inferSelect): NodeRow => ({
  id: r.id, projectID: r.project_id, sessionID: r.session_id, type: r.type, name: r.name,
  level: r.level, priority: r.priority, category: r.category, status: r.status, desc: r.desc,
  content: r.content, codeHash: r.code_hash, testStatus: r.test_status, confidence: r.confidence,
  timeCreated: r.time_created, timeUpdated: r.time_updated,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const nodeCreate = Effect.fn("GraphStorage.node.create")(function* (input: NodeCreateInput) {
      const id = Graph.NodeID.create()
      yield* db
        .insert(GraphNodeTable)
        .values({
          id, project_id: input.projectID, session_id: input.sessionID ?? null, type: input.type,
          name: input.name, level: input.level, priority: input.priority ?? null, category: input.category ?? null,
          status: input.status ?? "pending", desc: input.desc ?? null, content: input.content ?? null,
          code_hash: input.codeHash ?? null, test_status: input.testStatus ?? "none",
          confidence: input.confidence ?? 1,
        })
        .run()
        .pipe(Effect.orDie)
      return id
    })

    const nodeGet = Effect.fn("GraphStorage.node.get")(function* (id: Graph.NodeID) {
      const r = yield* db.select().from(GraphNodeTable).where(eq(GraphNodeTable.id, id)).get().pipe(Effect.orDie)
      if (!r) yield* new NotFoundError({ kind: "node", id })
      return rowToNode(r!)
    })

    const nodeUpdate = Effect.fn("GraphStorage.node.update")(function* (id: Graph.NodeID, patch: NodePatch) {
      const res = yield* db.update(GraphNodeTable).set(patch as any).where(eq(GraphNodeTable.id, id)).run().pipe(Effect.orDie)
      if (res.changes === 0) yield* new NotFoundError({ kind: "node", id })
    })

    const nodeDelete = Effect.fn("GraphStorage.node.delete")(function* (id: Graph.NodeID) {
      yield* db.delete(GraphNodeTable).where(eq(GraphNodeTable.id, id)).run().pipe(Effect.orDie)
    })

    const nodeList = Effect.fn("GraphStorage.node.list")(function* (filter: NodeFilter) {
      const conds = [eq(GraphNodeTable.project_id, filter.projectID)]
      if (filter.sessionID !== undefined) conds.push(eq(GraphNodeTable.session_id, filter.sessionID))
      const rows = yield* db.select().from(GraphNodeTable).where(and(...conds)).all().pipe(Effect.orDie)
      return rows.map(rowToNode)
    })

    return Service.of({
      node: { create: nodeCreate, get: nodeGet, update: nodeUpdate, delete: nodeDelete, list: nodeList },
    } as any) // cast relaxed until edge/main/promote/version added
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
```
(Define `ProjectID`, `NodeCreateInput`, `NodePatch`, `NodeFilter` types above; `ProjectID = ProjectV2.ID`.)

- [ ] **Step 4: Run, confirm pass**

Run: `cd packages/core && bun test test/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/storage.ts packages/core/test/graph.test.ts
git commit -m "feat(core/graph): node CRUD service + tests"
```

---

### Task 5: Edge CRUD (TDD)

- [ ] **Step 1: Add failing tests** — edge create/get/delete; FK reject (source/target must exist) by creating edge to a non-existent node and asserting an error; `UNIQUE(source,target,relation)` duplicate rejected; invalid relation rejected at the Schema input layer.

- [ ] **Step 2: Run, confirm fail** (`edge` is not on `Service` yet).

- [ ] **Step 3: Implement** `edge` methods on the service (mirror `node.*`; `create` validates `EdgeRelation` via typed input; `list(filter)` with optional `sourceID/targetID/relation/sessionID`).

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Commit** — `feat(core/graph): edge CRUD service + tests`.

---

### Task 6: `main` / `currentPlan` reads (TDD)

- [ ] **Step 1: Add failing tests** — `project_id` scoping (project A nodes invisible to project B list/main); CurrentPlan isolation (session S1 node in `currentPlan(S1)` but not `main`; main node not in `currentPlan(S1)`).

```ts
test("main vs currentPlan isolation by session_id", async () => {
  await provide(Effect.gen(function* () {
    const g = yield* GraphStorage.Service
    const main = yield* g.node.create({ projectID: PID, type: "atomic", name: "M", level: "L2" }) // session_id null = main
    const plan = yield* g.node.create({ projectID: PID, sessionID: "ses_1", type: "atomic", name: "P", level: "L2" })
    const m = yield* g.main({ projectID: PID })
    expect(m.nodes.map(n=>n.id)).toContain(main); expect(m.nodes.map(n=>n.id)).not.toContain(plan)
    const cp = yield* g.currentPlan({ sessionID: "ses_1" })
    expect(cp.nodes.map(n=>n.id)).toContain(plan); expect(cp.nodes.map(n=>n.id)).not.toContain(main)
  }))
})
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `main({projectID})` (nodes+edges where `session_id IS NULL`) and `currentPlan({sessionID})` (where `session_id = sessionID`); each returns `{ nodes, edges }`. Use `isNull(GraphNodeTable.session_id)`.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Commit** — `feat(core/graph): main/currentPlan reads + tests`.

---

### Task 7: `promote` primitive + version (TDD)

- [ ] **Step 1: Add failing tests** — promote moves session's nodes+edges to main (session_id→null), creates a `graph_version` snapshot with `version_number = MAX+1`, and empties that session's currentPlan; `version.list/get` by project.

```ts
test("promote promotes subgraph + writes version snapshot", async () => {
  await provide(Effect.gen(function* () {
    const g = yield* GraphStorage.Service
    const n1 = yield* g.node.create({ projectID: PID, sessionID: "ses_1", type:"atomic", name:"A", level:"L2" })
    const n2 = yield* g.node.create({ projectID: PID, sessionID: "ses_1", type:"atomic", name:"B", level:"L2" })
    yield* g.edge.create({ projectID: PID, sessionID:"ses_1", sourceID: n1, targetID: n2, relation: "uses" })
    const res = yield* g.promote({ sessionID: "ses_1", projectID: PID, message: "merge 1" })
    expect(res.versionNumber).toBe(1)
    const m = yield* g.main({ projectID: PID })
    expect(m.nodes.length).toBe(2); expect(m.edges.length).toBe(1)
    const cp = yield* g.currentPlan({ sessionID: "ses_1" })
    expect(cp.nodes.length).toBe(0)
    const vs = yield* g.version.list({ projectID: PID })
    expect(vs.length).toBe(1); expect(vs[0].versionNumber).toBe(1)
  }))
})
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `promote({sessionID, projectID, message})` in a `db.transaction(() => Effect.gen(...))`:
  - read session's nodes+edges;
  - `UPDATE graph_node SET session_id=NULL WHERE session_id=? AND project_id=?`; same for edges;
  - `version_number = (SELECT COALESCE(MAX(version_number),0)+1 FROM graph_version WHERE project_id=?)`;
  - insert `GraphVersionTable` with `snapshot = { nodes: [...], edges: [...] }`;
  - return `{ versionNumber, nodes: count, edges: count, versionID }`.
  Implement `version.list({projectID})` / `version.get({projectID, versionNumber})`.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Commit** — `feat(core/graph): promote primitive + version snapshots + tests`.

---

### Task 8: Cascade + final coverage (TDD)

- [ ] **Step 1: Add failing tests** — delete a session row → its nodes/edges cascade-deleted (FK `ON DELETE CASCADE`); delete project → all its graph rows deleted. (These verify the FK schema, so create a real `session`/`project` row first, or assert via the FK definition by attempting promote after delete.)

- [ ] **Step 2: Run; confirm pass** (cascades come from the FK declarations in Task 2 — tests are verification).

- [ ] **Step 3: Commit** — `test(core/graph): cascade verification`.

---

### Task 9: Finalize

- [ ] **Step 1: Full typecheck**

Run: `cd packages/core && bun typecheck`
Expected: PASS.

- [ ] **Step 2: Migration drift check**

Run: `cd packages/core && bun run script/migration.ts --check`
Expected: `No schema changes, nothing to migrate`.

- [ ] **Step 3: Full test run**

Run: `cd packages/core && bun test`
Expected: all green (incl. the existing `database-migration.test.ts`).

- [ ] **Step 4: Divergence check**

Run: `git diff --stat dev` — assert only: `packages/schema/src/graph.ts`, `packages/core/src/graph/*`, `packages/core/test/graph.test.ts`, + generated `schema.gen.ts`/`migration.gen.ts`/`migration/<ts>_graph.ts`/`schema.json`. No other opencode source files touched.

- [ ] **Step 5: Commit & push** (if not already) — final.

---

## Self-Review

- **Spec coverage:** spec §3 (3 tables) → Tasks 1–2; §4 (CurrentPlan/promote/version) → Tasks 6–7; §5 (Service API) → Tasks 4–7; §8 (tests 1–8) → Tasks 4–8; §9 (acceptance: typecheck/test/zero-divergence) → Task 9. ✓
- **Placeholders:** code blocks are concrete; the `NodeCreateInput/NodePatch/NodeFilter/ProjectID` types and `EdgeRow/VersionRow` are referenced and must be defined in Task 4 Step 3 (called out). The smoke-test raw `db.get` signature is flagged "adjust to actual overload." No vague "add error handling." ✓
- **Type consistency:** `Graph.NodeID`/`EdgeID`/`VersionID` used consistently; enum types from `@opencode-ai/schema/graph`; `Service.of(...)` cast relaxed mid-plan (Task 4) and fully typed by Task 7. ✓
- **Convention drift risk:** `SessionTable` export name flagged for verification (Task 2 Step 2); schema-package export path flagged (Task 1 Step 1). Both are the only inference points. ✓

## Execution note

Generated files (`schema.gen.ts`, `migration.gen.ts`, `migration/<ts>_graph.ts`, `schema.json`) are touched by the generator, not by hand — not a manual divergence. `packages/core/src/graph/*`, `packages/schema/src/graph.ts`, `test/graph.test.ts` are pure additions. **Zero opencode source files hand-edited.**
