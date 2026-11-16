// The hand-off of the TUI's environment to its subagents, coalesced. A server
// restart (an install) resets every connection for a while, and each member
// that appears or runs again in that window asks for a hand: one toast per
// failed hand stacked hundreds deep. Here a transport failure is the server
// coming back, not a failure: the hand is tried again with a backoff until
// the server answers, for up to RETRY_FOR_MS. Hands are keyed per session,
// so a repeat while one is on its way collapses into it. What still fails (a
// refusal, or a server gone past the bound) is told once for the whole
// burst, once no hand is left on its way, with the count and the first error.
import { Effect, Option, Schema } from "effect"

/** The timers the hand-off runs on: the real ones in the TUI, a driven one in a test. */
export interface Clock {
  readonly now: () => number
  /** Runs `run` after `ms`; the result cancels it. */
  readonly after: (ms: number, run: () => void) => () => void
}

/** The first wait before a hand the transport failed is tried again; each next one doubles, up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 500
export const RETRY_MAX_MS = 10_000
/** How long a session's hand is tried again while the transport fails, from its first try. */
export const RETRY_FOR_MS = 5 * 60_000
/** How long the hand-off waits, once no hand is on its way, before it tells what failed: hands that come within it join the burst. */
export const QUIET_MS = 1_000

/** A hand the server did not take: `transport` when the client could not reach it at all (a restart, a reset connection), and the error's text. */
export class HandFailed extends Schema.TaggedError<HandFailed>()("HandFailed", {
  transport: Schema.Boolean,
  message: Schema.String,
}) {}

/** The client's failure to reach the server at all: `@opencode/client`'s `ClientError` with reason `Transport`. */
export const isTransport = Schema.is(Schema.Struct({ name: Schema.Literal("ClientError"), reason: Schema.Literal("Transport") }))

/** A client call as a hand: its answer dropped, its rejection a `HandFailed` that says whether the transport failed. */
export const fromClient = <A>(call: () => Promise<A>): Effect.Effect<void, HandFailed> =>
  Effect.asVoid(
    Effect.tryPromise({
      try: call,
      catch: (error) => new HandFailed({ transport: isTransport(error), message: String(error) }),
    }),
  )

/** The hands of one burst that failed for good: how many sessions, and the first error's text. */
export interface Failed {
  readonly count: number
  readonly error: string
}

/** The toast's title for a burst of `count` failed hands. */
export const notHanded = (count: number): string =>
  Option.match(
    Option.liftPredicate(count, (one) => one === 1),
    {
      onSome: () => "Rex pane not handed to a subagent",
      onNone: () => `Rex pane not handed to ${count} subagents`,
    },
  )

export interface Hands {
  /** Hands the environment to `sessionID`; while its hand is on its way, once more after it. */
  readonly hand: (sessionID: string) => void
  /** Stops every retry and the pending report. */
  readonly dispose: () => void
}

/** A session's hand: sending (and whether it was asked again meanwhile), or waiting out a backoff. */
interface Entry {
  readonly since: number
  delay: number
  again: boolean
  /** The waiting retry's cancel; none while a send is on its way. */
  retry: Option.Option<() => void>
}

export const coalescedHands = (input: {
  readonly send: (sessionID: string) => Effect.Effect<void, HandFailed>
  readonly report: (failed: Failed) => void
  readonly clock: Clock
}): Hands => {
  const { clock } = input
  const active = new Map<string, Entry>()
  // The sessions whose hand failed for good in this burst, each with its error, the first one first.
  const failed = new Map<string, string>()
  const state = { flush: Option.none<() => void>(), disposed: false }

  const report = () => {
    state.flush = Option.none()
    if (state.disposed || active.size > 0) return
    Option.map(Option.fromIterable(failed.values()), (error) => input.report({ count: failed.size, error }))
    failed.clear()
  }
  const settle = () => {
    if (active.size > 0 || failed.size === 0 || Option.isSome(state.flush)) return
    state.flush = Option.some(clock.after(QUIET_MS, report))
  }

  const handed = (sessionID: string, entry: Entry) => {
    if (state.disposed) return
    if (entry.again) return attempt(sessionID, entry)
    active.delete(sessionID)
    failed.delete(sessionID)
    settle()
  }
  const refused = (sessionID: string, entry: Entry, failure: HandFailed) => {
    if (state.disposed) return
    if (failure.transport && clock.now() - entry.since < RETRY_FOR_MS) {
      entry.retry = Option.some(clock.after(entry.delay, () => attempt(sessionID, entry)))
      entry.delay = Math.min(entry.delay * 2, RETRY_MAX_MS)
      return
    }
    active.delete(sessionID)
    if (!failed.has(sessionID)) failed.set(sessionID, failure.message)
    settle()
  }
  const attempt = (sessionID: string, entry: Entry): void => {
    entry.retry = Option.none()
    entry.again = false
    void Effect.runPromise(
      Effect.match(input.send(sessionID), {
        onSuccess: () => handed(sessionID, entry),
        onFailure: (failure) => refused(sessionID, entry, failure),
      }),
    )
  }

  const start = (sessionID: string) => {
    const fresh: Entry = {
      since: clock.now(),
      delay: RETRY_FIRST_MS,
      again: false,
      retry: Option.none(),
    }
    active.set(sessionID, fresh)
    attempt(sessionID, fresh)
  }

  return {
    hand: (sessionID) => {
      if (state.disposed) return
      // A retry already waiting carries it; a send on its way is followed by one more.
      Option.match(Option.fromUndefinedOr(active.get(sessionID)), {
        onNone: () => start(sessionID),
        onSome: (entry) => {
          entry.again = Option.isNone(entry.retry)
        },
      })
    },
    dispose: () => {
      state.disposed = true
      for (const entry of active.values()) Option.map(entry.retry, (cancel) => cancel())
      active.clear()
      Option.map(state.flush, (cancel) => cancel())
      state.flush = Option.none()
    },
  }
}
