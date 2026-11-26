// The handle registry at work, in the wakes plugin. Every change goes through the `Handles` decider
// (handle.ts): decide, commit the changed handles to the wake store, then act — send a letter, set the
// one timer of a burst, say what was cancelled. A letter's delivery id is in `Claimed`, so a send that
// stopped short goes again under the same id and the host's inbox keeps one (H1).
//
// - The claim: at once when the session's turn runs (the letter joins it, H9), else one one-shot timer
//   at the first settle plus the window (H6); never a poll (W5a).
// - A send the host refuses for an archived session parks the letter; it goes again, under its id,
//   when the session is back or at the next instance start, never in a loop. A deleted session's go.
// - Ownership (H4): each handle names the instance that runs its work, `<server id>/<location>/<epoch>`.
//   This instance's own end retires its open calls (`lost`); at its start, and when a session's handles
//   are read, it retires every other owner proven dead: the same server and location at an earlier
//   epoch, or a server that no longer runs. Nothing else retires a call, and no timer does.
// - A call's value is kept in this instance's memory only (at most VALUE_BYTES each and SESSION_BYTES
//   per session; past that it reads `Unavailable`), never in the store and never in a letter.
//
// The registry opens only `call` and `land` (H8): no path here sends for an entry, a shell or a subagent.
import { Clock, Context, Duration, Effect, FiberMap, FiberSet, Layer, Option, Ref, Schema, Semaphore } from "effect"
import * as Handles from "./handle.ts"
import { Courier, WakeStore } from "./service.ts"

/** Where this instance runs, and the host's facts the registry reads at the moment it decides. */
export interface Config {
  /** The server's id (`Config.server`) and this plugin's location; the instance's epoch there is the store's next one, taken as it starts. */
  readonly server: string
  readonly location: string
  /** Whether the server by `id` still runs: a fact of its process, not a timer. */
  readonly live: (id: string) => Effect.Effect<boolean>
  /** Whether a turn of the session runs now (or a compaction, or the owner's prompt waits). */
  readonly busy: (sessionID: string) => Effect.Effect<boolean>
  /** The handles a stop or a cancel ended: their work is to be interrupted by whoever runs it. */
  readonly cancelled?: (ids: ReadonlyArray<string>) => Effect.Effect<void>
}

/** A value kept for `get` is at most this large, and a session's values together at most `SESSION_BYTES`. */
export const VALUE_BYTES = 256 * 1024
export const SESSION_BYTES = 16 * 1024 * 1024
/** A send that failed for another reason than an archive or a deletion goes once more after this long. */
export const RETRY_MS = 30_000

/** The owner string of an instance. */
export const ownerOf = (server: string, location: string, epoch: number) => `${server}/${location}/${epoch}`

interface Owner {
  readonly server: string
  readonly location: string
  readonly epoch: number
}

/** An owner string read back; none when it does not read (it is then never proven dead). */
export const ownerParts = (owner: string): Option.Option<Owner> => {
  const first = owner.indexOf("/")
  const last = owner.lastIndexOf("/")
  if (first < 0 || last <= first) return Option.none()
  const epoch = Number(owner.slice(last + 1))
  if (!Number.isInteger(epoch)) return Option.none()
  return Option.some({ server: owner.slice(0, first), location: owner.slice(first + 1, last), epoch })
}

/** What opening a handle asks: its id, its session, its kind and, for a call, its tool. */
export interface Opening {
  readonly id: string
  readonly sessionID: string
  readonly kind: Handles.Kind
  readonly tool: Option.Option<string>
}

/** What settling a handle says: how it ended, what it answered, and for a `started` end what it started. */
export interface Ending {
  readonly id: string
  readonly outcome: Handles.Outcome
  readonly value: Option.Option<Schema.Json>
  readonly to: Option.Option<string>
}

export class Registry extends Context.Service<
  Registry,
  {
    /** Record a handle of this instance's; whether it was opened (not for a deleted session, nor an id opened before). Committed when this returns (H11). */
    readonly open: (opening: Opening) => Effect.Effect<boolean>
    /** The handle's end, once (H3); its letter follows by the claim's rule. */
    readonly settle: (ending: Ending) => Effect.Effect<void>
    /** How the session's handle stands, at once. */
    readonly get: (sessionID: string, id: string) => Effect.Effect<Handles.Reading>
    /** The session's handles. */
    readonly list: (sessionID: string) => Effect.Effect<ReadonlyArray<Handles.Handle>>
    /** Cancel the session's open handle; whether it was open. */
    readonly cancel: (sessionID: string, id: string) => Effect.Effect<boolean>
    /** The owner stopped the session (H10): its open handles cancelled, no letter. The ids cancelled. */
    readonly stopped: (sessionID: string) => Effect.Effect<ReadonlyArray<string>>
    /** The session was deleted: its handles go, and nothing of it is told again (H5). */
    readonly forget: (sessionID: string) => Effect.Effect<void>
    /** The session is back from the archive: its parked letters go, under their ids. */
    readonly unpark: (sessionID: string) => Effect.Effect<void>
    /** At the instance's start: retire the dead owners, unpark, send what is owed, claim what settled meanwhile. */
    readonly start: Effect.Effect<void>
  }
>()("dotfiles-opencode/wake/Registry") {}

const encodedLength = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** Each id whose handle `after` has and `before` has not as it is. */
const changedIds = (before: Handles.State, after: Handles.State) =>
  [...after.handles.values()].filter((handle) => before.handles.get(handle.id) !== handle)

export const layer = (config: Config) =>
  Layer.effect(
    Registry,
    Effect.gen(function* () {
      const store = yield* WakeStore
      const courier = yield* Courier
      const lock = yield* Semaphore.make(1)
      const locked = lock.withPermits(1)
      const timers = yield* FiberMap.make<string>()
      const later = yield* FiberSet.make()
      const epoch = yield* store.nextEpoch(config.server, config.location)
      const me = ownerOf(config.server, config.location, epoch)
      /** Sessions deleted while this instance ran. */
      const gone = yield* Ref.make<ReadonlySet<string>>(new Set())
      /** Each settled call's value, by handle id, with its session and size. */
      const values = new Map<string, { readonly session: string; readonly value: Schema.Json; readonly bytes: number }>()
      const cancelled = config.cancelled ?? (() => Effect.void)

      const current = Effect.gen(function* () {
        const stored = Handles.stateOf(yield* store.handles)
        return { handles: stored.handles, gone: yield* Ref.get(gone) }
      })

      /** Decide `command` on the stored handles and commit what changed; the events and the state after. */
      const transact = (command: Handles.Command) =>
        locked(
          Effect.gen(function* () {
            const before = yield* current
            const events = yield* Handles.Handles.decide(before, command, yield* Clock.currentTimeMillis)
            const after = events.reduce(Handles.Handles.evolve, before)
            for (const handle of changedIds(before, after)) yield* store.writeHandle(handle)
            for (const id of before.handles.keys()) if (!after.handles.has(id)) yield* store.removeHandle(id)
            yield* Ref.set(gone, after.gone)
            return { events, after }
          }),
        )

      /** Whether `owner` is proven dead: this server and location at an earlier epoch, or a server that no longer runs. */
      const dead = (owner: string) =>
        Option.match(Option.filter(ownerParts(owner), () => owner !== me), {
          onNone: () => Effect.succeed(false),
          onSome: (parts) => {
            if (parts.server !== config.server) return config.live(parts.server).pipe(Effect.map((runs) => !runs))
            return Effect.succeed(parts.location === config.location && parts.epoch < epoch)
          },
        })

      /** Send the owed letter: admitted, it is delivered; an archived session parks it; a deleted one is forgotten. */
      const send = (letter: Handles.Owed): Effect.Effect<void> =>
        Effect.gen(function* () {
          const state = yield* current
          const told = letter.ids.flatMap((id) => Option.toArray(Option.flatMap(Option.fromNullishOr(state.handles.get(id)), Handles.toldOf)))
          const sent = yield* courier.deliver(letter.session, letter.delivery, Handles.letterOf(told), letter.mode !== "notice").pipe(
            Effect.as("sent" as const),
            Effect.catchTag("DeliveryRefused", (refused) => {
              if (refused.archived === true) return Effect.succeed("archived" as const)
              if (refused.gone) return Effect.succeed("gone" as const)
              return Effect.logWarning("handles: the session did not take a letter; it goes again", { delivery: letter.delivery, message: refused.message }).pipe(Effect.as("refused" as const))
            }),
          )
          if (sent === "sent") yield* transact(Handles.Deliver.make({ delivery: letter.delivery }))
          if (sent === "archived") yield* transact(Handles.Park.make({ delivery: letter.delivery }))
          if (sent === "gone") yield* forget(letter.session)
          if (sent === "refused") yield* FiberSet.run(later, Effect.sleep(Duration.millis(RETRY_MS)).pipe(Effect.andThen(sendOwed(Option.some(letter.session)))))
        })

      /** Send every letter the session is owed (every session's, with none named). */
      const sendOwed = (session: Option.Option<string>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const letters = Handles.owed(yield* current).filter((letter) => Option.getOrElse(Option.map(session, (only) => only === letter.session), () => true))
          for (const letter of letters) yield* send(letter)
        })

      /** Claim the session's settled handles now; whether a letter was claimed. */
      const claimNow = (session: string) =>
        Effect.gen(function* () {
          const delivery = yield* courier.newDelivery
          const busy = yield* config.busy(session)
          const now = yield* Clock.currentTimeMillis
          const { events } = yield* transact(Handles.Claim.make({ session, delivery, now, busy }))
          if (events.length === 0) return false
          yield* sendOwed(Option.some(session))
          return true
        })

      /** The one timer of a burst: sleep until the window of the first settle is up, then claim. */
      const waitAndClaim = (session: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A notice (only what the owner declined) is claimed at once; anything else when the window is up.
          for (;;) {
            if (yield* claimNow(session)) return
            const due = Handles.dueAt(yield* current, session)
            if (Option.isNone(due)) return
            const now = yield* Clock.currentTimeMillis
            if (due.value > now) yield* Effect.sleep(Duration.millis(due.value - now))
          }
        })

      /** A settle came: join the running turn at once, else set the burst's one timer (kept if set). */
      const schedule = (session: string) =>
        Effect.gen(function* () {
          if (yield* config.busy(session)) {
            yield* claimNow(session)
            return
          }
          yield* FiberMap.run(timers, session, waitAndClaim(session), { onlyIfMissing: true })
        })

      /** What the events of a command call for: the claims of what settled, and the work of what was cancelled. */
      const act = (events: ReadonlyArray<Handles.Event>) =>
        Effect.gen(function* () {
          const settled = new Set<string>()
          const ended: Array<string> = []
          const state = yield* current
          for (const event of events) {
            if (event._tag === "Settled") Option.map(Option.fromNullishOr(state.handles.get(event.id)), (handle) => settled.add(handle.session))
            if (event._tag === "Cancelled") ended.push(event.id)
          }
          if (ended.length > 0) yield* cancelled(ended)
          for (const session of settled) yield* schedule(session)
        })

      const run = (command: Handles.Command) => transact(command).pipe(Effect.tap(({ events }) => act(events)))

      /** Retire every owner of the state's open calls that is proven dead (`within`: only the session's). */
      const retireDead = (within: Option.Option<string>) =>
        Effect.gen(function* () {
          const state = yield* current
          const scoped: Handles.State = {
            handles: new Map([...state.handles].filter(([, handle]) => Option.getOrElse(Option.map(within, (session) => handle.session === session), () => true))),
            gone: state.gone,
          }
          for (const owner of Handles.openOwners(scoped)) if (yield* dead(owner)) yield* run(Handles.Retired.make({ owner, at: yield* Clock.currentTimeMillis }))
        })

      const forget = (session: string) =>
        Effect.gen(function* () {
          for (const [id, kept] of values) if (kept.session === session) values.delete(id)
          yield* transact(Handles.Forget.make({ session }))
          // Last: a send from the session's own timer forgets it, and this ends that timer.
          yield* FiberMap.remove(timers, session)
        })

      /** Keep a call's value for `get`, within the bounds; a value past them reads `Unavailable`. */
      const keep = (id: string, session: string, value: Schema.Json) => {
        const bytes = Option.getOrElse(Option.map(encodedLength(value), (text) => text.length), () => VALUE_BYTES + 1)
        const held = [...values.values()].filter((kept) => kept.session === session).reduce((sum, kept) => sum + kept.bytes, 0)
        if (bytes <= VALUE_BYTES && held + bytes <= SESSION_BYTES) values.set(id, { session, value, bytes })
      }

      const readingOf = (handle: Handles.Handle): Handles.Reading => {
        const settled = (disposition: Handles.Disposition): Handles.Reading => ({
          state: "settled",
          disposition,
          value: Option.getOrElse(Option.map(Option.fromNullishOr(values.get(handle.id)), (kept) => kept.value), () =>
            Handles.Unavailable.make({ reason: `${handle.id}'s value is not kept: its server went, or it was past the bound` }),
          ),
        })
        switch (handle.phase._tag) {
          case "Open":
            return { state: "open", kind: handle.kind }
          case "Settled":
          case "Claimed":
          case "Delivered":
            return settled(handle.phase.disposition)
          case "Cancelled":
            return { state: "cancelled" }
          case "Handed":
            return { state: "handed", to: handle.phase.to }
        }
      }

      const ofSession = (sessionID: string) => Effect.map(current, (state) => [...state.handles.values()].filter((handle) => handle.session === sessionID))

      // This instance's end retires its own open calls: they may have run, and are never run again.
      yield* Effect.addFinalizer(() =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) => transact(Handles.Retired.make({ owner: me, at }))),
          Effect.ignoreCause,
        ),
      )

      return Registry.of({
        open: (opening) =>
          Effect.gen(function* () {
            const open = Handles.Open.make({ id: opening.id, session: opening.sessionID, kind: opening.kind, owner: me })
            const { events } = yield* transact(Option.match(opening.tool, { onNone: () => open, onSome: (tool) => ({ ...open, tool }) }))
            return events.length > 0
          }),
        settle: (ending) =>
          Effect.gen(function* () {
            const state = yield* current
            for (const handle of Option.toArray(Option.fromNullishOr(state.handles.get(ending.id))))
              for (const value of Option.toArray(ending.value)) if (ending.outcome === "succeeded" || ending.outcome === "failed") keep(handle.id, handle.session, value)
            const settle = Handles.Settle.make({ id: ending.id, disposition: ending.outcome, at: yield* Clock.currentTimeMillis })
            yield* run(Option.match(ending.to, { onNone: () => settle, onSome: (to) => ({ ...settle, to }) }))
          }),
        get: (sessionID, id) =>
          Effect.gen(function* () {
            yield* retireDead(Option.some(sessionID))
            const found = Option.filter(Option.fromNullishOr((yield* current).handles.get(id)), (handle) => handle.session === sessionID)
            return Option.match(found, { onNone: (): Handles.Reading => ({ state: "unknown" }), onSome: readingOf })
          }),
        list: (sessionID) => retireDead(Option.some(sessionID)).pipe(Effect.andThen(ofSession(sessionID))),
        cancel: (sessionID, id) =>
          Effect.gen(function* () {
            const mine = Option.exists(Option.fromNullishOr((yield* current).handles.get(id)), (handle) => handle.session === sessionID)
            if (!mine) return false
            const { events } = yield* run(Handles.Cancel.make({ id }))
            return events.length > 0
          }),
        stopped: (sessionID) =>
          run(Handles.Stopped.make({ session: sessionID })).pipe(
            Effect.map(({ events }) => cancelledIds(events)),
          ),
        forget,
        unpark: (sessionID) => transact(Handles.Unpark.make({ session: sessionID })).pipe(Effect.andThen(sendOwed(Option.some(sessionID)))),
        start: Effect.gen(function* () {
          yield* retireDead(Option.none())
          for (const session of Handles.parkedSessions(yield* current)) yield* transact(Handles.Unpark.make({ session }))
          yield* sendOwed(Option.none())
          for (const session of Handles.unclaimedSessions(yield* current)) yield* schedule(session)
        }),
      })
    }),
  )

/** The ids the events cancelled. */
const cancelledIds = (events: ReadonlyArray<Handles.Event>): ReadonlyArray<string> => {
  const ids: Array<string> = []
  for (const event of events) if (event._tag === "Cancelled") ids.push(event.id)
  return ids
}
