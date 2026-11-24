import { Option, Schema } from "effect"
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

declare const futureRetry: unique symbol
/** Constructed only by comparing an appointment to the decision's clock. */
export type FutureRetryAt = number & { readonly [futureRetry]: true }
const isFutureRetry = (now: number) => (at: number): at is FutureRetryAt =>
  Number.isFinite(at) && at > now && at <= LAST_EPOCH_MS
export const futureRetryAt = (now: number, at: number): Option.Option<FutureRetryAt> =>
  Option.liftPredicate(at, isFutureRetry(now))

/** The next attempt after a due recheck was reserved but evidence is still missing. */
export const pendingRecoveryAt = (now: number): number => clampHoldEnd(now + UNREADABLE_HOLD_MS, now)
export const RecoveryAttempt = Schema.Struct({ at: HoldTime, until: HoldTime })
export type RecoveryAttempt = typeof RecoveryAttempt.Type

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
