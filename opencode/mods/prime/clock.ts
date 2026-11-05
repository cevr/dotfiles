// Time as the running rows read it, without a timer: how often the shared
// clock ticks, the blink of a running group's glyph and elapsed time in words.

/** How often the shared clock ticks while something runs (tui/clock.ts). */
export const TICK_MS = 250

/** Whether a running group's glyph shows hollow (`○`) at `now`: it blinks every half second. */
export function blink(now: number) {
  return Math.floor(now / 500) % 2 === 1
}

/** Whole seconds under a minute, then `1m 05s`. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}
