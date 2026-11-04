// Forget what has expired: steps out of the window, past holds, the pins of
// runs that stopped without going idle, and caches that no longer live.
import { Effect, Schema } from "effect"
import { CACHE_LIFE_MS, PIN_IDLE_MS, Step, WINDOW_MS } from "../Accounts.ts"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const PruneLedger = Schema.TaggedStruct("PruneLedger", {})
export interface PruneLedger extends Schema.Schema.Type<typeof PruneLedger> {}

export const LedgerPruned = Schema.TaggedStruct("LedgerPruned", {
  /** Steps out of the window. */
  steps: Schema.Array(Step),
  /** Accounts whose hold has passed. */
  holds: Schema.Array(Schema.String),
  /** Sessions whose pin has gone idle. */
  runs: Schema.Array(Schema.String),
  /** Sessions whose cache no longer lives. */
  caches: Schema.Array(Schema.String),
})
export interface LedgerPruned extends Schema.Schema.Type<typeof LedgerPruned> {}

export declare namespace PruneLedger {
  export type Rejections = never
}

/** Nothing when nothing has expired. */
export const decide = (state: AccountPoolState, _command: PruneLedger, now: number): Effect.Effect<ReadonlyArray<LedgerPruned>> => {
  const steps = state.steps.filter((step) => now - step.at >= WINDOW_MS)
  const holds = Object.entries(state.holds).flatMap(([credentialID, hold]) => (hold.until > now ? [] : [credentialID]))
  const runs = Object.entries(state.runs).flatMap(([sessionID, mark]) => (now - mark.at >= PIN_IDLE_MS ? [sessionID] : []))
  const caches = Object.entries(state.recent).flatMap(([sessionID, mark]) => (now - mark.at >= CACHE_LIFE_MS ? [sessionID] : []))
  if (steps.length + holds.length + runs.length + caches.length === 0) return Effect.succeed([])
  return Effect.succeed([LedgerPruned.make({ steps, holds, runs, caches })])
}
