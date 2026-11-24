import { DateTime, Effect, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { HoldReason } from "./pace.ts"

export interface SendHold {
  readonly reason: string
  readonly until: number
}

export const HeldSend = Schema.Struct({
  sessionID: Schema.String,
  providerID: Schema.String,
  stepID: Schema.optionalKey(Schema.String),
  reasonCode: HoldReason,
  retryAt: Schema.Finite,
})
export type HeldSend = typeof HeldSend.Type
export const HeldSendAnswer = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["held", "ended"]), hold: HeldSend }),
  Schema.Struct({ state: Schema.optionalKey(Schema.Never), hold: Schema.optionalKey(Schema.Never) }),
])
export const readHeldSend = Schema.decodeUnknownOption(HeldSendAnswer)
interface SendHook { readonly kind: string }
const readStep = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
export const stepIDOf = (event: SendHook) => {
  if (!("step" in event)) return Option.none()
  return readStep(event.step).pipe(Option.map((step) => step.id))
}

export const sendHoldMessage = (reason: string, retryAt: number): string => {
  const until = Option.match(DateTime.make(retryAt), { onNone: () => `${retryAt}`, onSome: () => formatNotificationTime(retryAt) })
  return `held by the pool until ${until}: not an error of the task; retry at or after that time. ${reason}`
}

/** A Step on a concrete send is the host's capability witness, not a fork version.
 * Older hosts stop the hook with a defect before the handler, as auth did before
 * there was an unsent Step to defer. Auxiliary requests do not have a Step.
 */
export const refuseSend = (event: SendHook, held: SendHold): Effect.Effect<void> => {
  const reason = sendHoldMessage(held.reason, held.until)
  if (event.kind !== "primary" || !("step" in event) || Option.isNone(Option.fromUndefinedOr(event.step)))
    return Effect.die(new Error(reason))
  return Effect.sync(() => { Object.assign(event, { refuse: { ...held, reason } }) })
}

/** Used only when routing sees the new host's primary Step capability. */
export const deferRoute = (event: SendHook, held: SendHold): Effect.Effect<void> =>
  Effect.sync(() => { Object.assign(event, { defer: { ...held, reason: sendHoldMessage(held.reason, held.until) } }) })
