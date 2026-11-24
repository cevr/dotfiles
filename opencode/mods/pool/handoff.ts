// An internal proposal and the reply of the pool copy serving the handoff RPC
// now. Neither a credential proposal nor a reply to re-prepare is a permit.
import { Option, Schema } from "effect"
import { RequestKind } from "./accounts.ts"

export const HANDOFF_HEADER = "x-opencode-pool-handoff"
export const HOLD_STORE_RETRY_MS = 1000

const SentPlacement = Schema.Struct({ credentialID: Schema.String, cacheTTL: Schema.optionalKey(Schema.String) })
type SentPlacement = typeof SentPlacement.Type

// The actual signed request, not the proposal. Request-side metadata never
// travels as a header to the upstream provider. OpenCode may evaluate the
// auth, pool and cache plugin graphs independently; the request crosses them.
const sentPlacement = Symbol.for("dotfiles-opencode.pool.sent-placement")
const decodeSent = Schema.decodeUnknownOption(SentPlacement)
export const rememberSentPlacement = (request: Request, placement: SentPlacement): void => {
  Object.defineProperty(request, sentPlacement, { value: placement })
}
export const sentPlacementOf = (request: Request) =>
  Option.flatMap(Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(request, sentPlacement)), (property) => decodeSent(property.value))

export const HandoffInput = Schema.Struct({
  providerID: Schema.String, sessionID: Schema.String, model: Schema.String,
  kind: RequestKind, agent: Schema.String, candidate: Schema.String,
  keepalive: Schema.optionalKey(Schema.Boolean),
  stepID: Schema.optionalKey(Schema.String),
})
export type HandoffInput = typeof HandoffInput.Type

export const Handoff = Schema.TaggedUnion({
  Send: {},
  Prepare: { credentialID: Schema.String, cacheTTL: Schema.optionalKey(Schema.String) },
  Held: { message: Schema.String, retryAt: Schema.optionalKey(Schema.Finite) },
})
export type Handoff = typeof Handoff.Type

export class HandoffHeld extends Schema.TaggedError<HandoffHeld>()("HandoffHeld", { message: Schema.String, retryAt: Schema.Finite }) {}
