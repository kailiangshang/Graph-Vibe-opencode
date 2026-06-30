export * as Graph from "./graph"

import { Schema } from "effect"
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

export const EdgeRelation = Schema.Literals(["contains", "blocks", "addresses", "uses", "deprecated_by"])
export type EdgeRelation = typeof EdgeRelation.Type

export const NodeContent = Schema.Record(Schema.String, Schema.Unknown)
export type NodeContent = typeof NodeContent.Type

export { ProjectID }
