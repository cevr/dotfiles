// A session's reading from the wake mod's RPC (its wakes, its jobs): read at
// once, again on every `changed` event for the session and every 2 seconds
// (so a time crossing midnight, or a job's start, reads right), keeping the
// last reading when a read fails. A read asked while one runs goes once after
// it. The reading resets when the session changes.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { CHANGED } from "@dotfiles/opencode-wake/wake"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const decodeChanged = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }),
)

/** How often a reading is taken again. */
export const POLL_MS = 2000

export function readSession<A>(
  context: Plugin.Context,
  sessionID: Accessor<Option.Option<string>>,
  read: (sessionID: string, signal: AbortSignal) => Promise<Option.Option<A>>,
): Accessor<Option.Option<A>> {
  const [reading, setReading] = createSignal<Option.Option<A>>(Option.none())
  createEffect(() => {
    const id = sessionID()
    setReading(Option.none<A>())
    if (Option.isNone(id)) return
    const abort = new AbortController()
    const state = { busy: false, again: false }
    const refresh = (): void => {
      if (state.busy) {
        state.again = true
        return
      }
      state.busy = true
      void read(id.value, abort.signal)
        .catch(() => Option.none<A>())
        .then((answer) => {
          state.busy = false
          if (abort.signal.aborted) return
          if (Option.isSome(answer)) setReading(answer)
          if (!state.again) return
          state.again = false
          refresh()
        })
    }
    refresh()
    const unpoll = TuiClock.every(POLL_MS, refresh)
    const stop = context.data.listen((event) => {
      const changed = decodeChanged(event.details)
      if (Option.isSome(changed) && changed.value.data.sessionID === id.value) refresh()
    })
    onCleanup(() => {
      abort.abort()
      unpoll()
      stop()
    })
  })
  return reading
}
