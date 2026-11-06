// Mail's handlers: list the sessions a caller may write to (this server's and
// each paired host's), and send a message: resolve its address and its
// reply-to, refuse the caller's own session, compose the letter, deliver it
// and log the delivery. An id this server does not have goes to each paired
// host in turn, as a parcel the host composes and delivers itself
// (`receive`); the first that has the session takes it.
import { Clock, Context, Effect, Layer, Option } from "effect"
import { byTitle, isSessionID, NoSuchSession, notSelf } from "./address.ts"
import { listing, type Missed, nameOf, select, type SessionCard, type SessionsInput } from "./directory.ts"
import { compose, deliveryOf, EmptyMessage, excerpt, LOG_EXCERPT, type Delivery, type MessageInput, type Party, type Rejection } from "./letter.ts"
import type { Arrival, Parcel } from "./peer.ts"
import { DeliveryRefused, Peers, Sessions, type SessionsUnreadable } from "./service.ts"

/** A delivered message: to whom (with its host, when on a paired one), and how it reached them. */
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
    /** This server's sessions, as a paired host lists them. */
    readonly cards: (scope: { readonly children: boolean }) => Effect.Effect<ReadonlyArray<SessionCard>, SessionsUnreadable>
    /** A paired host's parcel for one of this server's sessions: compose its letter and deliver it. */
    readonly receive: (peer: string, parcel: Parcel) => Effect.Effect<Arrival>
  }
>()("dotfiles-opencode/mail/Mail") {}

const delivered = (sender: Party, target: Party, replyTo: Party, delivery: Delivery, text: string) =>
  Effect.logInfo(`mail: ${sender.host === undefined ? "" : `${sender.host}/`}${nameOf(sender)} → ${target.host === undefined ? "" : `${target.host}/`}${nameOf(target)}`).pipe(
    Effect.annotateLogs({
      from: sender.id,
      to: target.id,
      replyTo: replyTo.id,
      delivery,
      excerpt: excerpt(text, LOG_EXCERPT),
      ...(sender.host === undefined ? {} : { fromHost: sender.host }),
      ...(target.host === undefined ? {} : { toHost: target.host }),
    }),
  )

export const layer = Layer.effect(
  Mail,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const peers = yield* Peers

    /** The session of this server an address names: an id as is (none when it has no such session), a title among every session of the server. */
    const local = Effect.fn("Mail.local")(function* (to: string) {
      if (isSessionID(to)) return Option.getOrUndefined(yield* sessions.get(to.trim()))
      return yield* byTitle(to, yield* sessions.list({ children: true }))
    })

    const resolve = Effect.fn("Mail.resolve")(function* (to: string) {
      const found = yield* local(to)
      return found ?? (yield* new NoSuchSession({ to }))
    })

    /** An id this server lacks, offered to each paired host in turn. */
    const away = Effect.fn("Mail.away")(function* (to: string, sender: SessionCard, replyTo: SessionCard, text: string, wake: boolean) {
      const parcel: Parcel = {
        to: to.trim(),
        from: { id: sender.id, title: nameOf(sender) },
        replyTo: { id: replyTo.id, title: nameOf(replyTo) },
        body: text,
        wake,
      }
      const asked: Array<{ readonly name: string; readonly missed?: string }> = []
      for (const name of yield* peers.names) {
        const arrival = yield* peers.deliver(name, parcel).pipe(Effect.catchTag("PeerUnreachable", (failure) => Effect.succeed({ outcome: "missed" as const, message: failure.message })))
        if (arrival.outcome === "delivered") {
          const target: SessionCard = { ...arrival.to, host: name }
          yield* delivered(sender, target, replyTo, arrival.delivery, text)
          return { to: target, delivery: arrival.delivery } satisfies Receipt
        }
        if (arrival.outcome === "refused") return yield* new DeliveryRefused({ sessionID: parcel.to, message: `${name} refused it: ${arrival.message}` })
        asked.push(arrival.outcome === "missed" ? { name, missed: arrival.message } : { name })
      }
      return yield* new NoSuchSession({ to, ...(asked.length === 0 ? {} : { peers: asked }) })
    })

    return {
      sessions: Effect.fn("Mail.sessions")(function* (caller: string, input: SessionsInput) {
        const scope = { children: input.children ?? false }
        const own = yield* sessions.list(scope)
        const remote = yield* Effect.forEach(
          yield* peers.names,
          (name) =>
            peers.sessions(name, scope).pipe(
              Effect.map((cards) => ({ cards: cards.map((card): SessionCard => ({ ...card, host: name })), missed: [] as ReadonlyArray<Missed> })),
              Effect.catchTag("PeerUnreachable", (failure) => Effect.succeed({ cards: [] as ReadonlyArray<SessionCard>, missed: [{ peer: name, message: failure.message }] })),
            ),
          { concurrency: "unbounded" },
        )
        const cards = [...own, ...remote.flatMap((answer) => answer.cards)]
        return listing(select(cards, input), caller, yield* Clock.currentTimeMillis, remote.flatMap((answer) => answer.missed))
      }),
      send: Effect.fn("Mail.send")(function* (caller: string, input: MessageInput) {
        if (input.text.trim() === "") return yield* new EmptyMessage()
        const found = yield* local(input.to)
        const sender = Option.getOrElse(yield* sessions.get(caller), (): SessionCard => ({ id: caller, directory: "", running: true, updated: 0 }))
        const replyTo = input.replyTo === undefined || input.replyTo.trim() === "" ? sender : yield* resolve(input.replyTo)
        const wake = input.wake ?? true
        if (found === undefined) return yield* away(input.to, sender, replyTo, input.text, wake)
        const target = yield* notSelf(found, caller)
        yield* sessions.deliver(target.id, compose(sender, replyTo, input.text), wake)
        const delivery = deliveryOf(target.running, wake)
        yield* delivered(sender, target, replyTo, delivery, input.text)
        return { to: target, delivery } satisfies Receipt
      }),
      cards: (scope) => sessions.list(scope),
      receive: Effect.fn("Mail.receive")(function* (peer: string, parcel: Parcel) {
        const read = yield* sessions.get(parcel.to.trim()).pipe(Effect.result)
        if (read._tag === "Failure") return { outcome: "refused", message: `the sessions could not be read: ${read.failure.message}` } satisfies Arrival
        if (Option.isNone(read.success)) return { outcome: "unknown" } satisfies Arrival
        const target = read.success.value
        const from: Party = { ...parcel.from, host: peer }
        const replyTo: Party = { ...parcel.replyTo, host: peer }
        const wrote = yield* sessions.deliver(target.id, compose(from, replyTo, parcel.body), parcel.wake).pipe(Effect.result)
        if (wrote._tag === "Failure") return { outcome: "refused", message: wrote.failure.message } satisfies Arrival
        const delivery = deliveryOf(target.running, parcel.wake)
        yield* delivered(from, target, replyTo, delivery, parcel.body)
        return { outcome: "delivered", to: target, delivery } satisfies Arrival
      }),
    }
  }),
)
