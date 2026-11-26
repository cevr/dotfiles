import { Array as Arr, Option } from "effect"
import * as TuiClock from "../decider/tui-clock.ts"

/** A scoped clock for synchronous TUI timer callbacks; the test advances it after setup. */
export const manualTuiClock = () => {
  type Timer = { at: number; readonly ms: number; readonly run: () => void; readonly repeat: boolean }
  const timers = new Set<Timer>()
  let now = 0
  const add = (ms: number, run: () => void, repeat: boolean) => {
    const timer: Timer = { at: now + ms, ms, run, repeat }
    timers.add(timer)
    return () => { timers.delete(timer) }
  }
  const clock: TuiClock.Clock = {
    now: () => now,
    once: (ms, run) => add(ms, run, false),
    every(ms, run) {
      const stop = add(ms, run, true)
      run()
      return stop
    },
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const first = Arr.head([...timers].sort((a, b) => a.at - b.at))
      if (Option.isNone(first) || first.value.at > until) break
      const timer = first.value
      now = timer.at
      if (timer.repeat) timer.at += timer.ms
      else timers.delete(timer)
      timer.run()
    }
    now = until
  }
  return { advance, [Symbol.dispose]: TuiClock.install(clock) }
}
