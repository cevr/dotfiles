// A writer's way to the log: `append` encodes the event and hands its line to a small in-memory hold, and returns at
// once; one fiber sends the held lines on, one at a time, through `send` (the digest plugin's RPC). While `send`
// fails or hangs past SEND_TIMEOUT (the digest plugin not loaded yet, gone or stalled) the line waits and is tried
// again after RETRY_EVERY, for an hour at most; a line that finds the hold full, or never went, is dropped and
// counted, the first drop of each cause is logged, and the count goes on as its own `Dropped` line once a send works
// again. So nothing a writer does waits on the digest or fails because of it, and nothing grows unbounded.
import { Cause, Clock, Context, Effect, Layer, Queue, Ref, Schedule } from "effect"
import { DigestEvent, DigestLog, encodeLine, VERSION } from "./event.ts"

/** How many lines wait for the digest at most. */
export const HOLD = 256

/** How long a line waits before it is sent again. */
export const RETRY_EVERY = "2 seconds"

/** What sends one line to the log's owner. */
export type Send = (line: string) => Effect.Effect<unknown, unknown>

/** The relay's hold, for a test to read. */
export class RelayHold extends Context.Service<
  RelayHold,
  {
    /** How many lines wait now. */
    readonly waiting: Effect.Effect<number>
    /** How many lines were dropped since the last `Dropped` line went. */
    readonly dropped: Effect.Effect<number>
  }
>()("dotfiles-opencode/digest/RelayHold") {}

/** How many times a line is tried again before it is dropped: an hour of RETRY_EVERY. */
export const RETRIES = 1_800

/** How long one send may take: one that hangs (a stalled digest) counts as failed and is tried again. */
export const SEND_TIMEOUT = "10 seconds"

/** At most this many distinct causes of a drop are logged; past it, drops are only counted. */
const CAUSES_LOGGED = 32

/** Why a line was dropped, as the log says it. */
type Why = string

/** The hold was full when the line came. */
const HOLD_FULL: Why = "the hold is full"

/** A failed send's cause, short. */
const whyOf = (cause: Cause.Cause<unknown>): Why => `never sent in ${RETRIES} tries: ${Cause.pretty(cause).split("\n")[0]?.slice(0, 200) ?? ""}`

/**
 * Send one line, trying again until it goes: a send that fails, throws or hangs past SEND_TIMEOUT (no RPC on the
 * host yet, a stalled digest) waits and goes again, RETRIES times at most; a line that never went is dropped, and
 * `gaveUp` counts it with why.
 */
const sendUntil = (send: Send, line: string, gaveUp: (why: Why) => Effect.Effect<void>) =>
  Effect.suspend(() => send(line)).pipe(
    Effect.timeout(SEND_TIMEOUT),
    Effect.sandbox,
    Effect.retry({ schedule: Schedule.spaced(RETRY_EVERY), times: RETRIES }),
    Effect.catch((cause) => gaveUp(whyOf(cause))),
    Effect.asVoid,
  )

/** The relay over `send`, its sender fiber in the layer's scope; `hold` lines wait at most. */
export const layer = (send: Send, hold: number = HOLD): Layer.Layer<DigestLog | RelayHold> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const lines = yield* Queue.dropping<string>(hold)
      const dropped = yield* Ref.make(0)
      const logged = new Set<Why>()
      // A drop is counted; the first of each cause is logged, with the count so far.
      const drop = (count: number, why: Why) =>
        Effect.flatMap(Ref.updateAndGet(dropped, (before) => before + count), (total) =>
          Effect.suspend(() => {
            if (logged.has(why) || logged.size >= CAUSES_LOGGED) return Effect.void
            logged.add(why)
            return Effect.logWarning("digest: a line was dropped", { why, dropped: total })
          }),
        )
      const flushDropped = Effect.gen(function* () {
        const count = yield* Ref.getAndSet(dropped, 0)
        if (count === 0) return
        const t = yield* Clock.currentTimeMillis
        // A count that never went is counted again, for the next one.
        yield* sendUntil(send, encodeLine(DigestEvent.cases.Dropped.make({ v: VERSION, t, count })), (why) => drop(count, why))
      })
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.flatMap(Queue.take(lines), (line) => sendUntil(send, line, (why) => drop(1, why))), flushDropped)))
      const log = DigestLog.of({
        append: (event) =>
          Effect.suspend(() => Queue.offer(lines, encodeLine(event))).pipe(
            Effect.flatMap((kept) => Effect.when(drop(1, HOLD_FULL), Effect.succeed(!kept))),
            Effect.ignoreCause,
          ),
      })
      const held = RelayHold.of({ waiting: Queue.size(lines), dropped: Ref.get(dropped) })
      return Context.make(DigestLog, log).pipe(Context.add(RelayHold, held))
    }),
  )
