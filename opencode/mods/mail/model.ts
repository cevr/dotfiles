// Mail's handlers: list the sessions a caller may write to, and send a
// message: resolve its address and its reply-to, refuse the caller's own
// session, compose the letter, deliver it and log the delivery.
import { Clock, Context, Effect, Layer, Option } from "effect"
import { byTitle, isSessionID, NoSuchSession, notSelf } from "./address.ts"
import { listing, nameOf, select, type SessionCard, type SessionsInput } from "./directory.ts"
import { compose, deliveryOf, EmptyMessage, excerpt, LOG_EXCERPT, type Delivery, type MessageInput, type Rejection } from "./letter.ts"
import { type DeliveryRefused, Sessions, type SessionsUnreadable } from "./service.ts"

/** A delivered message: to whom, and how it reached them. */
export interface Receipt {
  readonly to: SessionCard
  readonly delivery: Delivery
}

export class Mail extends Context.Service<
  Mail,
  {
    /** The `sessions` tool's answer for `caller`. */
    readonly sessions: (caller: string, input: SessionsInput) => Effect.Effect<string, SessionsUnreadable>
    /** Send `caller`'s message. */
    readonly send: (caller: string, input: MessageInput) => Effect.Effect<Receipt, Rejection | SessionsUnreadable | DeliveryRefused>
  }
>()("dotfiles-opencode/mail/Mail") {}

export const layer = Layer.effect(
  Mail,
  Effect.gen(function* () {
    const sessions = yield* Sessions

    /** The session an address names: an id as is, a title among every session of the server. */
    const resolve = Effect.fn("Mail.resolve")(function* (to: string) {
      if (isSessionID(to)) {
        const found = yield* sessions.get(to.trim())
        return yield* Option.match(found, { onNone: () => Effect.fail(new NoSuchSession({ to })), onSome: Effect.succeed })
      }
      return yield* byTitle(to, yield* sessions.list({ children: true }))
    })

    return {
      sessions: Effect.fn("Mail.sessions")(function* (caller: string, input: SessionsInput) {
        const cards = yield* sessions.list({ children: input.children ?? false })
        return listing(select(cards, input), caller, yield* Clock.currentTimeMillis)
      }),
      send: Effect.fn("Mail.send")(function* (caller: string, input: MessageInput) {
        if (input.text.trim() === "") return yield* new EmptyMessage()
        const target = yield* resolve(input.to).pipe(Effect.flatMap((card) => notSelf(card, caller)))
        const sender = Option.getOrElse(yield* sessions.get(caller), (): SessionCard => ({ id: caller, directory: "", running: true, updated: 0 }))
        const replyTo = input.replyTo === undefined || input.replyTo.trim() === "" ? sender : yield* resolve(input.replyTo)
        const wake = input.wake ?? true
        yield* sessions.deliver(target.id, compose(sender, replyTo, input.text), wake)
        const delivery = deliveryOf(target.running, wake)
        yield* Effect.logInfo(`mail: ${nameOf(sender)} → ${nameOf(target)}`).pipe(
          Effect.annotateLogs({
            from: sender.id,
            to: target.id,
            replyTo: replyTo.id,
            delivery,
            excerpt: excerpt(input.text, LOG_EXCERPT),
          }),
        )
        return { to: target, delivery } satisfies Receipt
      }),
    }
  }),
)
