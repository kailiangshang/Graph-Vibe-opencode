export * as Graph from "./graph"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const NodeID = Schema.String.pipe(
  Schema.brand("GraphNode.ID"),
  statics((schema) => ({ create: () => schema.make("gnd_" + ascending()) })),
)
export type NodeID = typeof NodeID.Type

export const EdgeID = Schema.String.pipe(
  Schema.brand("GraphEdge.ID"),
  statics((schema) => ({ create: () => schema.make("ged_" + ascending()) })),
)
export type EdgeID = typeof EdgeID.Type

export const VersionID = Schema.String.pipe(
  Schema.brand("GraphVersion.ID"),
  statics((schema) => ({ create: () => schema.make("gvr_" + ascending()) })),
)
export type VersionID = typeof VersionID.Type

export const NodeType = Schema.Literals(["prd", "composite", "atomic"])
export type NodeType = typeof NodeType.Type

export const Level = Schema.Literals(["L1", "L2"])
export type Level = typeof Level.Type

export const Priority = Schema.Literals(["P0", "P1", "P2", "P3"])
export type Priority = typeof Priority.Type

export const NodeStatus = Schema.Literals(["pending", "implemented", "verified", "deprecated"])
export type NodeStatus = typeof NodeStatus.Type

export const TestStatus = Schema.Literals(["none", "pending", "passed", "failed"])
export type TestStatus = typeof TestStatus.Type

export const ExecutionMode = Schema.Literals(["atomic", "module", "autopilot"])
export type ExecutionMode = typeof ExecutionMode.Type

export const CheckpointKind = Schema.Literals(["atomic", "module", "decision", "failure", "pause"])
export type CheckpointKind = typeof CheckpointKind.Type

export const CheckpointStatus = Schema.Literals(["none", "pending", "approved"])
export type CheckpointStatus = typeof CheckpointStatus.Type

export const EdgeRelation = Schema.Literals(["contains", "blocks", "addresses", "uses", "deprecated_by"])
export type EdgeRelation = typeof EdgeRelation.Type

export const NodeContent = Schema.Record(Schema.String, Schema.Unknown)
export type NodeContent = typeof NodeContent.Type

const boundedString = (maxLength: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0 && value.length <= maxLength, {
      expected: `a non-empty string no longer than ${maxLength} characters`,
    }),
  )

export const RelativePath = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (value.length === 0 || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
        return false
      }
      if (value.includes("\\")) return false
      const segments = value.split("/")
      return !segments[0]?.startsWith("-") && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    },
    { expected: "a normalized relative path without empty, current, or parent segments" },
  ),
)
export type RelativePath = typeof RelativePath.Type

export const DiagnosticName = Schema.Literals(["test", "typecheck", "lint"])
export type DiagnosticName = typeof DiagnosticName.Type

export const VerificationSpec = Schema.Struct({
  criteria: Schema.NonEmptyArray(boundedString(1_024)).check(Schema.isMaxLength(64)),
  diagnostics: Schema.NonEmptyArray(
    Schema.Struct({
      name: DiagnosticName,
      paths: Schema.optional(Schema.Array(RelativePath).check(Schema.isMaxLength(64))),
    }),
  ).check(Schema.isMaxLength(16)),
})
export interface VerificationSpec extends Schema.Schema.Type<typeof VerificationSpec> {}

export const VerificationEvidence = Schema.Struct({
  kind: Schema.Literal("diagnostics"),
  nodeID: Schema.String,
  criteria: Schema.Array(boundedString(1_024)).check(Schema.isMaxLength(64)),
  artifactPaths: Schema.Array(RelativePath).check(Schema.isMaxLength(256)),
  projectChecksOnly: Schema.Boolean,
  complete: Schema.Boolean,
  passed: Schema.Boolean,
  commands: Schema.Array(
    Schema.Struct({
      name: boundedString(128),
      command: boundedString(2_048),
      exitCode: Schema.NullOr(Schema.Number),
      timedOut: Schema.Boolean,
      passed: Schema.Boolean,
      excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
    }),
  ).check(Schema.isMaxLength(32)),
})
export interface VerificationEvidence extends Schema.Schema.Type<typeof VerificationEvidence> {}

export { ProjectID }

const PlanUpdated = define({ type: "graph.plan.updated", schema: { projectID: ProjectID } })
const MainUpdated = define({ type: "graph.main.updated", schema: { projectID: ProjectID } })
export const Event = { PlanUpdated, MainUpdated, Definitions: inventory(PlanUpdated, MainUpdated) }
