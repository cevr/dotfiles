// The Queue section of the session sidebar. Thin: it reads the route's root
// session's queue over the queue RPC every 2 seconds (keeping the answer only
// when its revision moved), reads the live state of that root's subagents from
// the TUI's data for the items linked to one, and draws the rows board.ts
// projects from them, one line each. The subagents themselves are Prime's rows
// beneath the composer, not this section's. A failed or undecodable answer
// changes nothing; no rows draw nothing.
// cmd/queue/tui.tsx registers it on `sidebar.content`.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { board, line, type Mark } from "../board.ts"
import { liveStates } from "../opencode/subagents.ts"
import { QUEUE, Snapshot } from "../queue.ts"

const decode = Schema.decodeUnknownOption(Snapshot)

/** The sidebar's text width: its 42 columns less its padding and the scrollbar's. */
export const WIDTH = 37

/** How often the queue is read again. */
const POLL_MS = 2000

export function QueueSection(props: { ctx: Plugin.Context; sessionID: string }) {
  const ctx = props.ctx
  const root = createMemo(() => ctx.data.session.root(props.sessionID))
  const [queue, setQueue] = createSignal<{ readonly root: string; readonly snapshot: Snapshot }>()
  const [now, setNow] = createSignal(Date.now())
  const abort = new AbortController()
  let pending = false
  let closed = false
  const refresh = async () => {
    if (pending) return
    pending = true
    const sessionID = root()
    const answer = await ctx.client
      .rpc(QUEUE)
      .get({ sessionID }, { location: ctx.location, signal: abort.signal })
      .then(decode, () => Option.none<Snapshot>())
    pending = false
    if (closed) return
    setNow(Date.now())
    if (Option.isNone(answer)) return
    const current = queue()
    if (current?.root !== sessionID || current.snapshot.revision !== answer.value.revision) setQueue({ root: sessionID, snapshot: answer.value })
  }
  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => {
    closed = true
    abort.abort()
    clearInterval(timer)
  })
  const rows = createMemo(() => {
    const current = queue()
    const items = current?.root === root() ? current.snapshot.items : []
    return board(items, liveStates(ctx.data, root(), ctx.location), now())
  })
  const theme = () => ctx.theme
  const colour = (mark: Mark) => {
    const text = theme().text
    if (mark === "needs-you" || mark === "blocked") return text.feedback.warning.base
    if (mark === "failed") return text.feedback.error.base
    if (mark === "running") return text.feedback.info.base
    if (mark === "next" || mark === "scheduled") return text.base
    return text.muted
  }
  return (
    <Show when={rows().length > 0}>
      <box>
        <text fg={theme().text.base}>
          <b>Queue</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <text fg={colour(row.mark)} wrapMode="none">
              {line(row, WIDTH)}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
