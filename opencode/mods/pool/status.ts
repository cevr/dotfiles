// The pool's own RPC, which other mods read: orchestrate asks `pace` before a
// new agent starts, and the status pane draws `status`. The definition is the
// wire contract, kept byte for byte; the schemas below are the shapes its
// methods answer with. No answer carries a secret.
import { Schema } from "effect"
import { QuotaReading, RefusalKind } from "./quota.ts"

/** The pool's own RPC: each pooled provider's accounts, holds and readings. No secrets. */
export const POOL_STATUS = {
  id: "dotfiles-opencode.pool",
  methods: {
    pace: { input: { type: "object", properties: { providerID: { type: "string" } }, required: ["providerID"] }, output: { type: "object" } },
    status: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const

/** An account refused until `until`, set at `at` (epoch ms). */
export const Hold = Schema.Struct({
  kind: RefusalKind,
  until: Schema.Number,
  at: Schema.Number,
})
export type Hold = typeof Hold.Type

/** One account as the status method reports it. */
export const AccountStatus = Schema.Struct({
  credentialID: Schema.String,
  hold: Schema.optionalKey(Hold),
  reading: Schema.optionalKey(QuotaReading),
  /** USD recorded on it in the window. */
  load: Schema.Number,
  /** Sessions whose run or cache is on it now. */
  live: Schema.Number,
  noRoom: Schema.Boolean,
})
export type AccountStatus = typeof AccountStatus.Type

/** A store outside OpenCode whose logins join a pool: what it lists, and the labels it leaves alone. */
export const SourceStatus = Schema.Struct({
  kind: Schema.Literal("gent"),
  dir: Schema.String,
  accounts: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
})
export type SourceStatus = typeof SourceStatus.Type

/** One pool in the status answer; `sources` only when the pool has any. */
export const PoolEntry = Schema.Struct({
  accounts: Schema.Array(AccountStatus),
  sources: Schema.optionalKey(Schema.Array(SourceStatus)),
})
export type PoolEntry = typeof PoolEntry.Type

/** The status method's answer: each pool by its integration id. */
export const PoolsStatus = Schema.Record(Schema.String, PoolEntry)
export type PoolsStatus = typeof PoolsStatus.Type
