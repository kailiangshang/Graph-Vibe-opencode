#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
const formattedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
const graphNodeTypesPatched = patchGeneratedType(formattedTypes, "GraphNode", (body) =>
  patchNullableObjectFields(
    patchNullableScalarFields(body, [
      ["  sessionID", "string"],
      ["  priority", '"P0" | "P1" | "P2" | "P3"'],
      ["  category", "string"],
      ["  desc", "string"],
      ["  codeHash", "string"],
    ]),
    ["  content"],
  ),
)
const graphVersionTypesPatched = patchGeneratedType(graphNodeTypesPatched, "GraphVersion", (body) =>
  patchNullableScalarFields(body, [["  message", "string"]]),
)
const graphToolRunTypesPatched = patchGeneratedType(graphVersionTypesPatched, "GraphToolRun", (body) =>
  patchNullableUnionField(
    patchNullableScalarFields(body, [
      ["  inputSummary", "string"],
      ["  outputSummary", "string"],
      ["  error", "string"],
      ["          exitCode", 'number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"'],
    ]),
    "  evidence",
    "  timeCreated",
  ),
)
const graphWorkflowTaskTypesPatched = patchGeneratedType(graphToolRunTypesPatched, "GraphWorkflowTask", (body) =>
  patchNullableObjectFields(
    patchNullableScalarFields(body, [
      ["  moduleID", "string"],
      ["  moduleName", "string"],
      ["      exitCode", 'number | "NaN" | "Infinity" | "-Infinity" | "Infinity" | "-Infinity" | "NaN"'],
    ]),
    ["  verification", "  latestEvidence"],
  ),
)
const graphTypesPatched = patchGeneratedType(graphWorkflowTaskTypesPatched, "GraphWorkflow", (body) =>
  patchNullableScalarFields(body, [
    ["  mode", '"atomic" | "module" | "autopilot"'],
    ["    kind", '"atomic" | "module" | "decision" | "failure" | "pause"'],
    ["    scopeNodeID", "string"],
    ["    scopeName", "string"],
    ["    reason", "string"],
    ["  currentTask", "GraphWorkflowTask"],
  ]),
)
await Bun.write("./src/v2/gen/types.gen.ts", graphTypesPatched)
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`

function patchGeneratedType(source: string, name: string, patch: (body: string) => string) {
  const matches = [...source.matchAll(new RegExp(`(export type ${name} = \\{\\n)([\\s\\S]*?)(^}\\n)`, "gm"))]
  if (matches.length !== 1) {
    throw new Error(`Graph nullability patch expected exactly one generated type ${name}`)
  }
  const match = matches[0]
  const body = match[2]
  const patched = patch(body)
  if (patched === body) throw new Error(`Graph nullability patch did not update generated type ${name}`)
  const start = match.index + match[1].length
  return source.slice(0, start) + patched + source.slice(start + body.length)
}

function patchNullableScalarFields(body: string, fields: ReadonlyArray<readonly [field: string, type: string]>) {
  return fields.reduce((source, [field, type]) => {
    const line = `${field}: ${type}`
    if (source.split("\n").filter((candidate) => candidate === line).length !== 1) {
      throw new Error(`Graph nullability patch expected exactly one generated field: ${line.trim()}`)
    }
    return source.replace(line, `${line} | null`)
  }, body)
}

function patchNullableObjectFields(body: string, fields: ReadonlyArray<string>) {
  return fields.reduce((source, field) => {
    const indentation = field.slice(0, field.length - field.trimStart().length)
    const pattern = new RegExp(`^${field}: \\{\\n[\\s\\S]*?^${indentation}\\}$`, "gm")
    if ([...source.matchAll(pattern)].length !== 1) {
      throw new Error(`Graph nullability patch expected exactly one generated object field: ${field.trim()}`)
    }
    return source.replace(pattern, "$& | null")
  }, body)
}

function patchNullableUnionField(body: string, field: string, nextField: string) {
  const pattern = new RegExp(`^${field}:\\n[\\s\\S]*?(?=^${nextField}:)`, "m")
  const matches = [...body.matchAll(new RegExp(pattern.source, "gm"))]
  if (matches.length !== 1) throw new Error(`Graph nullability patch expected exactly one generated union field: ${field.trim()}`)
  return body.replace(pattern, (value) => `${value.trimEnd()} | null\n`)
}
