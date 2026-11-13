/**
 * The time our TUI plugins read and the timers they set: `now()`, `once(ms,
 * run)` and `every(ms, run)`, each timer returning its cancel. A TUI plugin is
 * loaded by the host's own loader, so nothing can be handed to it; the clock is
 * process-wide instead: the system clock by default, and a simulated one once a
 * harness `install`s it (sim-tui/app.ts). Every read is of the clock installed
 * at that moment, so a plugin never keeps the system clock past an install.
 *
 * The folders our TUI plugins live in read no other clock and set no other
 * timer (`dotfiles/tui-clock-only`, lint/tui-clock.ts): this is the one place that
 * does.
 */
import { Clock as EffectClock, Effect, Fiber } from "effect"

export interface Clock {
  readonly now: () => number
  readonly once: (ms: number, run: () => void) => () => void
  readonly every: (ms: number, run: () => void) => () => void
}

/** Runs `effect` on its own fiber; the returned function interrupts it. */
const started = (effect: Effect.Effect<void>) => {
  const fiber = Effect.runFork(effect)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}

/** The system clock: Effect's own, as every Effect program reads it. */
export const system: Clock = {
  now: () => Effect.runSync(EffectClock.currentTimeMillis),
  once: (ms, run) => started(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(run)))),
  every: (ms, run) => started(Effect.sync(run).pipe(Effect.delay(ms), Effect.forever)),
}

const KEY = Symbol.for("dotfiles.tui-clock")
const registry: { [key: symbol]: Clock } = globalThis
// The first copy of this module in the process puts the system clock in.
registry[KEY] ??= system

/** The clock in force: the installed one, else the system's. */
export const current = (): Clock => registry[KEY]

/** Makes `clock` the clock every plugin reads from now on; the returned function puts the one before it back. */
export const install = (clock: Clock) => {
  const before = registry[KEY]
  registry[KEY] = clock
  return () => {
    registry[KEY] = before
  }
}

/** The time now, in milliseconds since the epoch, on the clock in force. */
export const now = () => current().now()
/** Runs `run` once, `ms` from now; the returned function cancels it. */
export const once = (ms: number, run: () => void) => current().once(ms, run)
/** Runs `run` every `ms`; the returned function stops it. */
export const every = (ms: number, run: () => void) => current().every(ms, run)
