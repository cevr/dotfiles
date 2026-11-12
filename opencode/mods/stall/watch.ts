/**
 * The stall watchdog's rule. The server's main thread is measured by a drift
 * check: a tick sleeps `tickMs`, and the time it took past that is the lag the
 * event loop had (a stall ends before the late tick can run). A CPU profile is
 * always sampling, in windows of `windowMs` that are dropped while nothing
 * happens, so the window a stall falls in already holds the stall's frames.
 *
 * - A lag of `thresholdMs` or more starts a capture: the window keeps sampling
 *   `captureMs` more, then it is written with the lag and its time in the name.
 * - At most one capture per `cooldownMs`; a stall inside it is only logged.
 * - At most `keep` captures stay; the oldest go first.
 *
 * @module
 */
import { Array as Arr, Data, DateTime, Option, Order } from "effect"

/** The watchdog's knobs, in milliseconds but `keep`. */
export interface Settings {
  /** The lag that is a stall. */
  readonly thresholdMs: number
  /** How long a tick sleeps; the lag is measured once per tick. */
  readonly tickMs: number
  /** How long a profile window samples before it is dropped and started again, while no stall happens. */
  readonly windowMs: number
  /** How long a window keeps sampling after the stall that is captured. */
  readonly captureMs: number
  /** The least time between two captures. */
  readonly cooldownMs: number
  /** How many captures stay on disk. */
  readonly keep: number
}

export const DEFAULTS: Settings = {
  thresholdMs: 2_000,
  tickMs: 250,
  windowMs: 30_000,
  captureMs: 10_000,
  cooldownMs: 10 * 60_000,
  keep: 5,
}

/** A stall the watchdog saw: when its late tick ran (wall clock), how late, and the process's RSS on each side of it. */
export interface Stall {
  readonly at: number
  readonly lagMs: number
  readonly rssBefore: number
  readonly rssAfter: number
}

/** One tick: the monotonic time it ran at, the lag it measured, the RSS now and at the tick before. */
export interface Tick {
  readonly now: number
  readonly wall: number
  readonly lagMs: number
  readonly rss: number
  readonly rssBefore: number
}

/** Where the watchdog is: the current window's start, the capture it is taking, and when the last capture began (monotonic). */
export interface Watch {
  readonly window: number
  readonly capture: Option.Option<{ readonly stall: Stall; readonly until: number }>
  readonly last: Option.Option<number>
}

export const initial = (now: number): Watch => ({ window: now, capture: Option.none(), last: Option.none() })

/** What a tick asks of the profiler and the store. */
export type Step = Data.TaggedEnum<{
  /** Nothing to do. */
  Wait: {}
  /** The window is old and held no stall: drop it and sample a new one. */
  Rotate: {}
  /** A stall: keep sampling this window for the capture. */
  Begin: { readonly stall: Stall }
  /** A stall inside the cooldown: log it, capture nothing. `nextMs` is how long until a capture is allowed again. */
  Skip: { readonly lagMs: number; readonly nextMs: number }
  /** The capture's window is done: write it, then sample a new one. */
  Finish: { readonly stall: Stall }
}>
export const Step = Data.taggedEnum<Step>()

const capturing = (watch: Watch, tick: Tick): Option.Option<readonly [Watch, Step]> =>
  Option.map(watch.capture, (capture): readonly [Watch, Step] => {
    if (tick.now < capture.until) return [watch, Step.Wait()]
    return [{ ...watch, window: tick.now, capture: Option.none() }, Step.Finish({ stall: capture.stall })]
  })

const cooling = (watch: Watch, settings: Settings, now: number): Option.Option<number> =>
  Option.filter(
    Option.map(watch.last, (last) => last + settings.cooldownMs - now),
    (left) => left > 0,
  )

/** The tick's decision, and the watch after it. */
export const step = (watch: Watch, tick: Tick, settings: Settings): readonly [Watch, Step] =>
  Option.getOrElse(capturing(watch, tick), (): readonly [Watch, Step] => {
    if (tick.lagMs >= settings.thresholdMs) {
      return Option.match(cooling(watch, settings, tick.now), {
        onSome: (nextMs): readonly [Watch, Step] => [watch, Step.Skip({ lagMs: tick.lagMs, nextMs })],
        onNone: (): readonly [Watch, Step] => {
          const stall: Stall = { at: tick.wall, lagMs: tick.lagMs, rssBefore: tick.rssBefore, rssAfter: tick.rss }
          return [{ ...watch, capture: Option.some({ stall, until: tick.now + settings.captureMs }), last: Option.some(tick.now) }, Step.Begin({ stall })]
        },
      })
    }
    if (tick.now - watch.window >= settings.windowMs) return [{ ...watch, window: tick.now }, Step.Rotate()]
    return [watch, Step.Wait()]
  })

const PREFIX = "stall-"

/** A capture's file stem: `stall-<UTC time>-<lag>ms-<pid>`, so names sort by time. */
export const stem = (stall: Stall, pid: number): string =>
  `${PREFIX}${DateTime.formatIso(DateTime.makeUnsafe(stall.at)).replace(/[-:.]/g, "")}-${Math.round(stall.lagMs)}ms-${pid}`

/** The stem of a capture file's name, or none for a file that is not a capture. */
export const stemOf = (name: string): Option.Option<string> => {
  if (!name.startsWith(PREFIX)) return Option.none()
  const dot = name.indexOf(".")
  if (dot < 0) return Option.none()
  return Option.some(name.slice(0, dot))
}

/** The files to delete so that only the `keep` newest captures stay (each capture is all the files of its stem). */
export const expired = (names: ReadonlyArray<string>, keep: number): ReadonlyArray<string> => {
  const stems = Arr.sort(Arr.dedupe(Arr.flatMap(names, (name) => Option.toArray(stemOf(name)))), Order.flip(Order.String))
  const old = new Set(Arr.drop(stems, Math.max(keep, 0)))
  return Arr.filter(names, (name) => Option.match(stemOf(name), { onNone: () => false, onSome: (found) => old.has(found) }))
}
