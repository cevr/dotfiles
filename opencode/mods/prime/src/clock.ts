// One clock for every running row: it ticks only while something reads it
// as running, so settled history never redraws.
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const TICK_MS = 250
const [now, setNow] = createSignal(Date.now())
let readers = 0
let timer: ReturnType<typeof setInterval> | undefined

/** The current time, ticking every 250 ms while `active` is true. */
export function useNow(active: Accessor<boolean>): Accessor<number> {
  createEffect(() => {
    if (!active()) return
    setNow(Date.now())
    if (readers++ === 0) timer = setInterval(() => setNow(Date.now()), TICK_MS)
    onCleanup(() => {
      if (--readers === 0) clearInterval(timer)
    })
  })
  return now
}
