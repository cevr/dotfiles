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
export interface Clock {
  readonly now: () => number
  readonly once: (ms: number, run: () => void) => () => void
  readonly every: (ms: number, run: () => void) => () => void
}

/** The system clock. */
export const system: Clock = {
  now: () => Date.now(),
  once: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
  every: (ms, run) => {
    const timer = setInterval(run, ms)
    return () => clearInterval(timer)
  },
}

const KEY = Symbol.for("dotfiles.tui-clock")
const registry: { [key: symbol]: Clock | undefined } = globalThis

/** The clock in force: the installed one, else the system's. */
export const current = (): Clock => registry[KEY] ?? system

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
