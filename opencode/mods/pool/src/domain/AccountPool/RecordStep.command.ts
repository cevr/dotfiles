// A step of a session's run ended with its price: it counts on the account
// the run's primary request went out on, and the session's cache is there.
import { Effect, Schema } from "effect"
import { placedOn, Step } from "../Accounts.ts"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const RecordStep = Schema.TaggedStruct("RecordStep", {
  sessionID: Schema.String,
  /** USD, as the host reported it; not a price when it is not a finite number at least 0. */
  cost: Schema.Number,
})
export interface RecordStep extends Schema.Schema.Type<typeof RecordStep> {}

export const StepRecorded = Schema.TaggedStruct("StepRecorded", { step: Step })
export interface StepRecorded extends Schema.Schema.Type<typeof StepRecorded> {}

export declare namespace RecordStep {
  export type Rejections = never
}

/** Nothing when the session has no account in this pool or the cost is not a price. */
export const decide = (
  state: AccountPoolState,
  command: RecordStep,
  now: number,
): Effect.Effect<ReadonlyArray<StepRecorded>> => {
  const { sessionID, cost } = command
  const credentialID = placedOn(state, sessionID, "primary") ?? state.runs[sessionID]?.credentialID
  if (credentialID === undefined || !Number.isFinite(cost) || cost < 0) return Effect.succeed([])
  return Effect.succeed([StepRecorded.make({ step: { at: now, sessionID, credentialID, cost } })])
}
