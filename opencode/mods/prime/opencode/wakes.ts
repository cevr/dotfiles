// The Host's wakes read (tui/host.ts): the session's pending wakes over the
// wake mod's RPC, read again on every `changed` event for the session and
// every 2 seconds (so a time crossing midnight reads right), keeping the last
// reading when a read fails. The protocol's id and event name come from the
// wake mod's protocol file; the answer decodes with Prime's own narrow schema.
import { CHANGED, WAKES } from "@dotfiles/opencode-wake/wake"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { Wakes } from "../wakes.ts"

const Answer = Schema.Struct({
  now: Schema.Number,
  entries: Schema.Array(Schema.Struct({ kind: Schema.Literals(["alarm", "monitor"]), dueAt: Schema.Number })),
  notices: Schema.Array(Schema.Unknown),
})
const decodeAnswer = Schema.decodeUnknownOption(Answer)
const decodeChanged = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }),
)

/** How often the wakes are read again. */
const POLL_MS = 2000

export function readWakes(context: Plugin.Context, sessionID: Accessor<string | undefined>): Accessor<Wakes | undefined> {
  const [wakes, setWakes] = createSignal<Wakes>()
  createEffect(() => {
    const id = sessionID()
    setWakes(undefined)
    if (id === undefined) return
    const abort = new AbortController()
    let reading = false
    let again = false
    const refresh = async (): Promise<void> => {
      if (reading) {
        again = true
        return
      }
      reading = true
      const answer = await context.client
        .rpc(WAKES)
        .pending({ sessionIDs: [id] }, { location: context.location, signal: abort.signal })
        .then(decodeAnswer, () => Option.none<typeof Answer.Type>())
      reading = false
      if (abort.signal.aborted) return
      if (Option.isSome(answer)) {
        const { now, entries, notices } = answer.value
        setWakes({ now, entries, notices: notices.length })
      }
      if (again) {
        again = false
        return refresh()
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const stop = context.data.listen((event) => {
      const changed = decodeChanged(event.details)
      if (Option.isSome(changed) && changed.value.data.sessionID === id) void refresh()
    })
    onCleanup(() => {
      abort.abort()
      clearInterval(timer)
      stop()
    })
  })
  return wakes
}
