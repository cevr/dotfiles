// A reading of one account came in. A live refusal holds the account until the
// refusal's time; a window read as exhausted holds it until that window resets.
import { Effect, Schema } from "effect"
import { DEFAULT_HOLD_MS } from "../Accounts.ts"
import { Hold } from "../PoolStatus.ts"
import { QuotaReading } from "../Quota.ts"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const TakeReading = Schema.TaggedStruct("TakeReading", {
  credentialID: Schema.String,
  reading: QuotaReading,
})
export interface TakeReading extends Schema.Schema.Type<typeof TakeReading> {}

/**
 * The account's newest reading, and the hold it sets, when it holds the
 * account longer than it is held now. A hold only grows: a shorter refusal
 * never frees an account a longer one holds.
 */
export const ReadingTaken = Schema.TaggedStruct("ReadingTaken", {
  credentialID: Schema.String,
  reading: QuotaReading,
  hold: Schema.optionalKey(Hold),
})
export interface ReadingTaken extends Schema.Schema.Type<typeof ReadingTaken> {}

export declare namespace TakeReading {
  export type Rejections = never
}

export const decide = (
  state: AccountPoolState,
  command: TakeReading,
  now: number,
): Effect.Effect<ReadonlyArray<ReadingTaken>> => {
  const { credentialID, reading } = command
  const refusal = reading.refusal
  const refused =
    refusal !== undefined && (refusal.until === undefined || refusal.until > now)
      ? { kind: refusal.kind, until: refusal.until ?? now + DEFAULT_HOLD_MS }
      : undefined
  const exhausted = reading.windows
    .filter((window) => window.utilization >= 1 && window.resetAt !== undefined && window.resetAt > now)
    .reduce<number | undefined>((latest, window) => Math.max(latest ?? 0, window.resetAt ?? 0), undefined)
  const until = Math.max(refused?.until ?? 0, exhausted ?? 0)
  const current = state.holds[credentialID]
  const grows = until > now && (current === undefined || current.until < until)
  return Effect.succeed([
    ReadingTaken.make({
      credentialID,
      reading,
      ...(grows ? { hold: { kind: refused?.kind ?? "usage-limit", until, at: now } } : {}),
    }),
  ])
}
