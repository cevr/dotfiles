// The Host's wakes read (tui/host.ts): the session's pending wakes over the
// wake mod's RPC, read again on every `changed` event for the session and
// every 2 seconds (so a time crossing midnight reads right), keeping the last
// reading when a read fails. The protocol's id and event name come from the
// wake mod's protocol file; the answer decodes with Prime's own narrow schema.
// Also the composer tabs' cancel, over the same RPC.
// A latch is a held subagent start, which the subagent rows show: the dock's
// wake item leaves it out.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { Cancelled, CHANGED, WAKES } from "@dotfiles/opencode-wake/wake"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { Wakes } from "../wakes.ts"

const Answer = Schema.Struct({
  now: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["alarm", "monitor", "latch"]),
      dueAt: Schema.Number,
      setAt: Schema.optional(Schema.Number),
      note: Schema.String,
      mode: Schema.Literals(["wake", "notify"]),
      everySeconds: Schema.optional(Schema.Number),
      command: Schema.optional(Schema.String),
      intervalSeconds: Schema.optional(Schema.Number),
      until: Schema.optional(Schema.String),
      last: Schema.optional(Schema.Struct({ at: Schema.Number, exitCode: Schema.Number, output: Schema.String })),
    }),
  ),
  notices: Schema.Array(Schema.Unknown),
})
const decodeAnswer = Schema.decodeUnknownOption(Answer)
const decodeCancelled = Schema.decodeUnknownOption(Cancelled)

/**
 * Cancels one of the session's alarms or monitors, as `wake_cancel` does: the
 * refusal's reason, or undefined once it went. The readers see it go on the
 * `changed` event that follows.
 */
export async function cancelWake(context: Plugin.Context, sessionID: string, id: string): Promise<string | undefined> {
  const answer = await context.client
    .rpc(WAKES)
    .cancel({ sessionID, id }, { location: context.location })
    .then(decodeCancelled, (error: unknown) => Option.some({ outcome: "refused" as const, reason: String(error) }))
  if (Option.isNone(answer)) return "the wake server's answer did not read"
  return answer.value.outcome === "refused" ? answer.value.reason : undefined
}
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
        setWakes({ now, entries: entries.filter((entry): entry is Wakes["entries"][number] => entry.kind !== "latch"), notices: notices.length })
      }
      if (again) {
        again = false
        return refresh()
      }
    }
    void refresh()
    const unpoll = TuiClock.every(POLL_MS, () => void refresh())
    const stop = context.data.listen((event) => {
      const changed = decodeChanged(event.details)
      if (Option.isSome(changed) && changed.value.data.sessionID === id) void refresh()
    })
    onCleanup(() => {
      abort.abort()
      unpoll()
      stop()
    })
  })
  return wakes
}
