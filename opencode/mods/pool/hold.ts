import { Schema } from "effect"
import { RefusalKind } from "./quota.ts"

/** No recovered refusal is allowed to extend beyond a weekly window. */
export const MAX_REFUSAL = 7 * 24 * 60 * 60_000
export const DEFAULT_HOLD_MS = 5 * 60_000
export const UNREADABLE_HOLD_MS = 60_000

/** An epoch millisecond that can be displayed and used as a recheck time. */
const LAST_EPOCH_MS = 8.64e15
export const HoldTime = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: LAST_EPOCH_MS }))
export const clampHoldEnd = (end: number, now: number): number => Math.min(end, now + MAX_REFUSAL, LAST_EPOCH_MS)

/** An account refusal; `until` is an appointment, not permission to send, for recovery and sign-in. */
export const Hold = Schema.Struct({
  kind: Schema.Union([RefusalKind, Schema.Literal("record-unreadable")]),
  until: HoldTime,
  at: HoldTime,
  rawKind: Schema.optionalKey(Schema.String),
  refusedUntil: Schema.optionalKey(HoldTime),
})
export type Hold = typeof Hold.Type

/** Pace names precisely the time at which dispatch will seek new evidence. */
export const holdRecheckAt = (hold: Hold): number => hold.until

/** A known authentication/usage condition is rechecked with authenticated evidence, not guessed at. */
export const recoveryDelay = (kind: RefusalKind): number => {
  switch (kind) {
    case "usage-limit":
    case "signin":
      return 0
    case "unauthorized":
    case "rate-limit":
      return DEFAULT_HOLD_MS
  }
}
