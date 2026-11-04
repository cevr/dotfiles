// A model request of a session goes out: on the run's pin while its account
// is not held, else on the first account of a new placement.
import { Effect, Schema } from "effect"
import { held, PIN_IDLE_MS, rank, RequestKind } from "../Accounts.ts"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const PlaceRequest = Schema.TaggedStruct("PlaceRequest", {
  sessionID: Schema.String,
  kind: RequestKind,
})
export interface PlaceRequest extends Schema.Schema.Type<typeof PlaceRequest> {}

/** The request goes out on `credentialID`; the session's run is pinned there from `at` (epoch ms). */
export const RequestPlaced = Schema.TaggedStruct("RequestPlaced", {
  sessionID: Schema.String,
  kind: RequestKind,
  credentialID: Schema.String,
  at: Schema.Number,
})
export interface RequestPlaced extends Schema.Schema.Type<typeof RequestPlaced> {}

/** The pool has no account to place the request on: the provider lists no login. */
export class NoAccount extends Schema.TaggedError<NoAccount>()("NoAccount", {
  sessionID: Schema.String,
  kind: RequestKind,
}) {}

export declare namespace PlaceRequest {
  export type Rejections = NoAccount
}

export const decide = (
  state: AccountPoolState,
  command: PlaceRequest,
  now: number,
): Effect.Effect<ReadonlyArray<RequestPlaced>, NoAccount> => {
  const pin = state.runs[command.sessionID]
  const pinned =
    pin !== undefined &&
    now - pin.at < PIN_IDLE_MS &&
    state.credentials.includes(pin.credentialID) &&
    !held(state, pin.credentialID, now)
      ? pin.credentialID
      : undefined
  const choice = pinned ?? rank(state, command.sessionID, now)[0]
  if (choice === undefined) return Effect.fail(new NoAccount({ sessionID: command.sessionID, kind: command.kind }))
  return Effect.succeed([
    RequestPlaced.make({ sessionID: command.sessionID, kind: command.kind, credentialID: choice, at: now }),
  ])
}
