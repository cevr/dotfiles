// How fast an account spends each window now: its use per hour, measured
// over its recent readings, for the reset rule's forecast (claim-rule.ts).
// The readings are kept in memory (model.ts): a restart forgets them, and a
// window's burn falls back to its period's average until two readings far
// enough apart are in hand again. A spent window burns no more, so its
// burn is the average that spent it: the rate the work would spend a reset
// at.
import { Array as Arr, Match, Option } from "effect"
import { windowMs } from "./limits.ts"
import type { QuotaReading, QuotaWindow } from "./quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Readings are kept this long for the burn. */
export const BURN_MS = 2 * HOUR
/** Two readings at least this far apart measure a burn; closer, the period's average stands. */
export const MIN_SPAN_MS = 20 * MINUTE
/** Two readings of one window period: its reset moved by no more than this. */
const SAME_PERIOD_MS = MINUTE

/** One account's reading at a time, as the burn keeps it. */
export interface Sample {
  readonly at: number
  readonly windows: ReadonlyArray<QuotaWindow>
}

/** The samples kept once `reading` is added at `now`: newer than the last one only, none older than BURN_MS. */
export const remember = (samples: ReadonlyArray<Sample>, reading: Option.Option<QuotaReading>, now: number): ReadonlyArray<Sample> => {
  const fresh = Option.match(reading, {
    onNone: () => samples,
    onSome: (read) =>
      Option.match(Arr.last(samples), {
        onNone: () => [{ at: read.at, windows: read.windows }],
        onSome: (last) =>
          Match.value(read.at > last.at).pipe(
            Match.when(true, () => [...samples, { at: read.at, windows: read.windows }]),
            Match.orElse(() => samples),
          ),
      }),
  })
  return fresh.filter((sample) => sample.at > now - BURN_MS)
}

/** A window's use per hour averaged over its period so far (at least five minutes of it). */
export const periodBurn = (window: QuotaWindow, now: number): number =>
  Option.match(Option.all({ length: Option.fromUndefinedOr(windowMs(window.name)), resetAt: Option.fromUndefinedOr(window.resetAt) }), {
    onNone: () => 0,
    onSome: ({ length, resetAt }) => (window.utilization / Math.max(length - (resetAt - now), HOUR / 12)) * HOUR,
  })

const samePeriod = (left: QuotaWindow, right: QuotaWindow) =>
  Option.exists(Option.all([Option.fromUndefinedOr(left.resetAt), Option.fromUndefinedOr(right.resetAt)]), ([one, other]) => Math.abs(one - other) <= SAME_PERIOD_MS)

/**
 * One window's burn over the samples: from the oldest one in the same period
 * with no drop in use since (a claim or a reset starts over) to the newest.
 * None when those span less than MIN_SPAN_MS.
 */
const measured = (samples: ReadonlyArray<Sample>, newest: QuotaWindow, newestAt: number): Option.Option<number> => {
  const run = Arr.takeWhile(
    Arr.reverse(samples.flatMap((sample) => Option.toArray(Option.map(Arr.findFirst(sample.windows, (window) => window.name === newest.name), (window) => ({ at: sample.at, window }))))),
    ({ window }) => samePeriod(window, newest),
  )
  const steady = Arr.takeWhile(run, (item, index) => item.window.utilization <= (run[index - 1]?.window.utilization ?? Number.POSITIVE_INFINITY))
  return Option.map(
    Option.filter(Arr.last(steady), (oldest) => newestAt - oldest.at >= MIN_SPAN_MS),
    (oldest) => (Math.max(0, newest.utilization - oldest.window.utilization) / (newestAt - oldest.at)) * HOUR,
  )
}

/**
 * The windows still open on an account whose burn is its period's average
 * because its samples do not measure one: none far enough apart since a
 * restart or since use last dropped. A spent window's average is by design,
 * not a missing measure, and is left out.
 */
export const averagedOf = (samples: ReadonlyArray<Sample>): ReadonlyArray<string> =>
  Option.match(Arr.last(samples), {
    onNone: () => [],
    onSome: (newest) =>
      newest.windows.filter((window) => window.utilization < 1 && Option.isNone(measured(samples, window, newest.at))).map((window) => window.name),
  })

/** Each window's burn on an account now, by name: measured over its samples, else (or when spent) its period's average. */
export const burnsOf = (samples: ReadonlyArray<Sample>, now: number): Readonly<Record<string, number>> =>
  Option.match(Arr.last(samples), {
    onNone: () => ({}),
    onSome: (newest) =>
      Object.fromEntries(
        newest.windows.map((window) => [
          window.name,
          Option.getOrElse(
            Option.flatMap(Option.liftPredicate(window, (open) => open.utilization < 1), (open) => measured(samples, open, newest.at)),
            () => periodBurn(window, now),
          ),
        ]),
      ),
  })
