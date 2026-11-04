// A session went idle: its run ended, and its next request is placed afresh,
// near its cache while the cache lives.
import { Effect, Schema } from "effect"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const ReleaseRun = Schema.TaggedStruct("ReleaseRun", { sessionID: Schema.String })
export interface ReleaseRun extends Schema.Schema.Type<typeof ReleaseRun> {}

export const RunReleased = Schema.TaggedStruct("RunReleased", { sessionID: Schema.String })
export interface RunReleased extends Schema.Schema.Type<typeof RunReleased> {}

export declare namespace ReleaseRun {
  export type Rejections = never
}

/** Nothing when the session has no run here. */
export const decide = (state: AccountPoolState, command: ReleaseRun): Effect.Effect<ReadonlyArray<RunReleased>> =>
  Effect.succeed(state.runs[command.sessionID] === undefined ? [] : [RunReleased.make({ sessionID: command.sessionID })])
