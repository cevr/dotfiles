import { Clock, Duration, Effect, Layer, Option } from "effect"
import { iso } from "./gate.ts"
import { Heartbeat, Log, Resident, type UpdateFailed } from "./service.ts"

/** How many intervals with no check make the updater stalled. */
export const STALLED_AFTER = 2

/**
 * How long after a copy of the plugin loads it asks the service for the resident location: the
 * service that loads it may be one of several a TUI's `service ensure` started at once, and the
 * ones that lose the port end before then.
 */
export const RESIDENT_DELAY = Duration.seconds(10)

/**
 * How long no check has run, counted from the last check or from `since` (when the watching
 * began), whichever is later; none while that is no more than `STALLED_AFTER` intervals.
 */
export const stalledFor = (now: number, last: Option.Option<number>, since: number, every: Duration.Duration): Option.Option<Duration.Duration> => {
  const quiet = now - Math.max(since, Option.getOrElse(last, () => since))
  return Option.liftPredicate(Duration.millis(quiet), () => quiet > STALLED_AFTER * Duration.toMillis(every))
}

/** What the update's `status` RPC answers: the last check, and whether the checks stalled. */
export interface Status {
  /** The last check's instant (ISO); absent before the first. */
  readonly lastCheck?: string
  /** No check for more than `STALLED_AFTER` intervals. */
  readonly stalled: boolean
}

/** The status at `now`, for a copy that began at `since`. */
export const statusOf = (now: number, last: Option.Option<number>, since: number, every: Duration.Duration): Status => ({
  ...Option.match(last, { onNone: () => ({}), onSome: (at) => ({ lastCheck: iso(at) }) }),
  stalled: Option.isSome(stalledFor(now, last, since, every)),
})

/** The status now, from the last check's stamp as `last` reads it. */
export const status = (last: Effect.Effect<Option.Option<number>>, since: number, every: Duration.Duration): Effect.Effect<Status> =>
  Effect.gen(function* () {
    return statusOf(yield* Clock.currentTimeMillis, yield* last, since, every)
  })

/** The watchdog as a layer, for the copy's scope: it runs as long as the copy does. */
export const watchdog = (every: Duration.Duration) => Layer.effectDiscard(Effect.forkScoped(watch(every)))

/**
 * The watchdog of a copy outside the resident location. A service a TUI started never loads the
 * resident location by itself, so no copy updates: this one asks the service for it, once after it
 * loads (`RESIDENT_DELAY`) and again whenever no check ran for more than `STALLED_AFTER` intervals,
 * which it logs. It never ends and never fails.
 */
export const watch = (every: Duration.Duration): Effect.Effect<never, never, Resident | Heartbeat | Log> =>
  Effect.gen(function* () {
    const resident = yield* Resident
    const heartbeat = yield* Heartbeat
    const log = yield* Log
    const since = yield* Clock.currentTimeMillis
    const ask = resident.load.pipe(
      Effect.catchTag("UpdateFailed", (failed: UpdateFailed) => log.line(`watchdog: asking the service for its resident location failed at ${failed.step}: ${failed.message}`)),
    )
    yield* Effect.sleep(RESIDENT_DELAY)
    yield* ask
    for (;;) {
      yield* Effect.sleep(every)
      const quiet = stalledFor(yield* Clock.currentTimeMillis, yield* heartbeat.last, since, every)
      if (Option.isNone(quiet)) continue
      yield* log.line(`watchdog: no update check for ${Duration.format(quiet.value)} (more than ${STALLED_AFTER} intervals); asking the service for its resident location`)
      yield* ask
    }
  })
