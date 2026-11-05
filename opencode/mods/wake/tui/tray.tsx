// The wakes' tray: one line above the composer while the session on screen
// has wakes pending or notices unread, `⏰ 2 wakes · next 14:30` (tray.ts).
// Thin: it reads the session's wakes over the wakes RPC, again on every
// `changed` event for it and every 2 seconds (so a time crossing midnight
// reads right), and keeps the last reading when a read fails.
// cmd/wake/tui.tsx registers it on `session.composer.top`.
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { Option, Schema } from "effect"
import { createSignal, onCleanup, Show } from "solid-js"
import { GLYPH, trayLine } from "../tray.ts"
import { CHANGED, Pending, WAKES } from "../wake.ts"

const decodePending = Schema.decodeUnknownOption(Pending)
const decodeChanged = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal(CHANGED), data: Schema.Struct({ sessionID: Schema.String }) }))

/** How often the wakes are read again. */
const POLL_MS = 2000
/** The sidebar's columns, when it shows beside the transcript. */
const SIDEBAR = 42
/** The transcript's inset on both sides, and the glyph and its space. */
const CHROME = 6

export function Tray(props: { ctx: Plugin.Context; sessionID: string }) {
  const ctx = props.ctx
  const dimensions = useTerminalDimensions()
  const [pending, setPending] = createSignal<Pending>()
  const abort = new AbortController()
  let reading = false
  let again = false
  let closed = false

  const refresh = async (): Promise<void> => {
    if (reading) {
      again = true
      return
    }
    reading = true
    const answer = await ctx.client
      .rpc(WAKES)
      .pending({ sessionIDs: [props.sessionID] }, { location: ctx.location, signal: abort.signal })
      .then(decodePending, () => Option.none<Pending>())
    reading = false
    if (closed) return
    if (Option.isSome(answer)) setPending(answer.value)
    if (again) {
      again = false
      return refresh()
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  const stop = ctx.data.listen((event) => {
    const changed = decodeChanged(event.details)
    if (Option.isSome(changed) && changed.value.data.sessionID === props.sessionID) void refresh()
  })
  onCleanup(() => {
    closed = true
    abort.abort()
    clearInterval(timer)
    stop()
  })

  const width = () => Math.max(20, dimensions().width - CHROME - (ctx.ui.sidebar.visible(props.sessionID) ? SIDEBAR : 0))
  const line = () => {
    const reading = pending()
    return reading === undefined ? undefined : trayLine(reading, width())
  }
  return (
    <Show when={line()}>
      {(shown) => (
        <box flexDirection="row" paddingLeft={2} paddingRight={2}>
          <text fg={ctx.theme.text.feedback.warning.base} wrapMode="none">
            {`${GLYPH} `}
          </text>
          <text fg={ctx.theme.text.muted} wrapMode="none">
            {shown()}
          </text>
        </box>
      )}
    </Show>
  )
}
