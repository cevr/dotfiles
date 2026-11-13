// One clock for every running row: it ticks only while something reads it
// as running, so settled history never redraws.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { TICK_MS } from "../clock.ts"

const [now, setNow] = createSignal(TuiClock.now())
let readers = 0
let stopTick: (() => void) | undefined

/**
 * The current time, ticking every `TICK_MS` while `active` is true. While it
 * is false the read is the time at the read and tracks no clock, so a settled
 * row never recomputes on another row's tick.
 */
export function useNow(active: Accessor<boolean>): Accessor<number> {
  createEffect(() => {
    if (!active()) return
    setNow(TuiClock.now())
    if (readers++ === 0) stopTick = TuiClock.every(TICK_MS, () => setNow(TuiClock.now()))
    onCleanup(() => {
      if (--readers === 0) stopTick?.()
    })
  })
  return () => (active() ? now() : TuiClock.now())
}
