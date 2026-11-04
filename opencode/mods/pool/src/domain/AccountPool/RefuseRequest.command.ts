// A request on an account was refused (401 or 429) and no reading said for
// how long: the account is held for the default time, unless it already is.
import { Effect, Schema } from "effect"
import { DEFAULT_HOLD_MS, held } from "../Accounts.ts"
import { Hold } from "../PoolStatus.ts"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const RefuseRequest = Schema.TaggedStruct("RefuseRequest", {
  credentialID: Schema.String,
  /** The response's HTTP status. */
  status: Schema.Number,
})
export interface RefuseRequest extends Schema.Schema.Type<typeof RefuseRequest> {}

export const RequestRefused = Schema.TaggedStruct("RequestRefused", {
  credentialID: Schema.String,
  hold: Hold,
})
export interface RequestRefused extends Schema.Schema.Type<typeof RequestRefused> {}

export declare namespace RefuseRequest {
  export type Rejections = never
}

export const decide = (
  state: AccountPoolState,
  command: RefuseRequest,
  now: number,
): Effect.Effect<ReadonlyArray<RequestRefused>> => {
  if (held(state, command.credentialID, now)) return Effect.succeed([])
  const kind = command.status === 401 ? "unauthorized" : "rate-limit"
  return Effect.succeed([
    RequestRefused.make({ credentialID: command.credentialID, hold: { kind, until: now + DEFAULT_HOLD_MS, at: now } }),
  ])
}
