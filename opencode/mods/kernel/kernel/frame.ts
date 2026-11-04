// The frames the kernel host and its worker process send each other: the
// worker protocol, an outside contract between two programs. The host decodes
// every frame the worker sends with `Response`; the worker reads the host's
// frames as these types. The worker imports this file for its types only
// (`import type`), so it loads no Effect. wire.ts puts frames on the pipes.
import { Schema } from "effect"

export type Json = Schema.Json

/** One tool the cell can call, as the worker lists it. */
export const Listing = Schema.Struct({ id: Schema.String, description: Schema.String })
export interface Listing extends Schema.Schema.Type<typeof Listing> {}

/**
 * Why a binding was left out of a snapshot: it holds a function, something
 * live (a promise, a weak reference, an iterator, a module), an object of a
 * class, something else a clone cannot carry, or too much.
 */
export const OmissionReason = Schema.Union([
  Schema.Literals(["function", "live", "unsupported", "too-deep", "too-large"]),
  Schema.TemplateLiteral(["instance of ", Schema.String]),
])
export type OmissionReason = typeof OmissionReason.Type

/** One stored binding: its name and its value as the codec encodes it. */
export const SnapshotBinding = Schema.Struct({ name: Schema.String, value: Schema.Json })
export interface SnapshotBinding extends Schema.Schema.Type<typeof SnapshotBinding> {}

export const Omission = Schema.Struct({ name: Schema.String, reason: OmissionReason })
export interface Omission extends Schema.Schema.Type<typeof Omission> {}

const snapshotFields = {
  bindings: Schema.Array(SnapshotBinding),
  omitted: Schema.Array(Omission),
}
export const Snapshot = Schema.Struct(snapshotFields)
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

const evaluationFields = {
  ok: Schema.Boolean,
  /** Console output, then the last value or the error. */
  display: Schema.String,
  truncated: Schema.Boolean,
  /** The bindings the cell added or rebound. */
  bindings: Schema.Array(Schema.String),
}
/** What one evaluation left: its display, and the bindings it added or rebound. */
export const Evaluation = Schema.Struct(evaluationFields)
export interface Evaluation extends Schema.Schema.Type<typeof Evaluation> {}

/** Host to worker. */
export const Request = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("evaluate"),
    id: Schema.String,
    /** Echoed in the end-of-output marker, so cell output cannot forge one. */
    token: Schema.String,
    source: Schema.String,
    tools: Schema.Array(Listing),
  }),
  Schema.Struct({ type: Schema.Literal("snapshot"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("restore"), id: Schema.String, bindings: Schema.Array(SnapshotBinding) }),
  Schema.Struct({ type: Schema.Literal("reply"), call: Schema.String, ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("reply"), call: Schema.String, ok: Schema.Literal(false), message: Schema.String }),
])
export type Request = typeof Request.Type

/** Worker to host. */
export const Response = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("evaluated"), id: Schema.String, ...evaluationFields }),
  Schema.Struct({ type: Schema.Literal("snapshot"), id: Schema.String, ...snapshotFields }),
  Schema.Struct({ type: Schema.Literal("restored"), id: Schema.String, names: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("call"), call: Schema.String, name: Schema.String, input: Schema.Json }),
])
export type Response = typeof Response.Type
