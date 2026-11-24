// An internal proposal and the reply of the pool copy serving the handoff RPC
// now. Neither a credential proposal nor a reply to re-prepare is a permit.
import { Schema } from "effect"
import { RequestKind } from "./accounts.ts"

export const HANDOFF_HEADER = "x-opencode-pool-handoff"
export const HOLD_STORE_RETRY_MS = 1000

export interface SentPlacement {
  readonly credentialID: string
  readonly cacheTTL?: string
}

// The actual signed request, not the proposal. Request-side metadata never
// travels as a header to the upstream provider.
export const sentPlacements = new WeakMap<Request, SentPlacement>()

export const HandoffInput = Schema.Struct({
  providerID: Schema.String, sessionID: Schema.String, model: Schema.String,
  kind: RequestKind, agent: Schema.String, candidate: Schema.String,
  keepalive: Schema.optionalKey(Schema.Boolean),
})
export type HandoffInput = typeof HandoffInput.Type

export const Handoff = Schema.TaggedUnion({
  Send: {},
  Prepare: { credentialID: Schema.String, cacheTTL: Schema.optionalKey(Schema.String) },
  Held: { message: Schema.String },
})
export type Handoff = typeof Handoff.Type

export class HandoffHeld extends Schema.TaggedError<HandoffHeld>()("HandoffHeld", { message: Schema.String }) {}
