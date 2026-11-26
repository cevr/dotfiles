import { Data, Effect, Schedule } from "effect"

/**
 * How long a test waits, in real time, for work it started in the background (a plugin's hook, a
 * watcher's tick). The event usually comes within milliseconds, so the bound only decides when a
 * wait that will never end gives up: well past what a machine at a load of 300 needs (a 1 s bound
 * failed there, batch av), and inside the minute a test gets in the scratch guard's child run, so
 * the wait's own message, not a test timeout, names what never came.
 *
 * The helpers return Promises: the plugins' test files resolve their own `effect`, whose types do
 * not match the root's, so each wraps a wait in its own `Effect.promise`, where a rejection is the
 * test's defect. Inside, the wait runs on this module's own runtime and its live clock, so a
 * caller's TestClock never holds it.
 */
export const WAIT_MS = 30_000

/** How long a wait sleeps between two looks. */
const LOOK_MS = 5

/** A wait whose condition never came, named. */
class WaitedInVain extends Data.TaggedError("WaitedInVain")<{ readonly message: string }> {}

/** A condition not met yet: the wait looks again. */
class NotYet extends Data.TaggedError("NotYet")<{}> {}

/** The deadline is independent of the number of looks the host got to make. */
const within = <E>(look: Effect.Effect<void, NotYet>, ms: number, orElse: () => Effect.Effect<void, E>): Promise<void> =>
  Effect.runPromise(look.pipe(
    Effect.retry({ schedule: Schedule.spaced(LOOK_MS), times: Math.ceil(ms / LOOK_MS) }),
    Effect.catchTag("NotYet", orElse),
    Effect.timeoutOrElse({ duration: ms, orElse }),
  ))

/** Waits, in real time, until `done` holds; past `ms` it rejects with `waited <ms> ms in vain for <what>`. */
export const waitUntil = (what: string, done: () => boolean, ms = WAIT_MS): Promise<void> =>
  within(
    Effect.sync(done).pipe(
      Effect.filterOrFail(
        (held) => held,
        () => new NotYet(),
      ),
      Effect.asVoid,
    ),
    ms,
    () => Effect.fail(new WaitedInVain({ message: `waited ${ms} ms in vain for ${what}` })),
  )

/**
 * Waits, in real time, until `check` (a block of `expect`s) passes; past `ms` it runs `check` once
 * more, so the wait rejects with that expectation's own error.
 */
export const eventuallyPasses = (check: () => void, ms = WAIT_MS): Promise<void> =>
  within(Effect.try({ try: check, catch: () => new NotYet() }), ms, () => Effect.sync(check))
