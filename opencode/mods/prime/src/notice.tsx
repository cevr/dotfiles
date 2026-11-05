// A background worker's completion line. Workers that finish together read as
// one line (`↳ 3 workers finished · fix-a, fix-b, fix-c`); the first notice of
// the burst draws it and the rest draw nothing.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { completionWords, noticeBurst } from "./group"
import { useSessionLink } from "./link"
import { GUTTER } from "./transcript"

type Context = Plugin.Context

/** Where a completion line starts: under the text of a group's header. */
const UNDER = GUTTER + 2

export function Completion(props: { context: Context; sessionID: string; messageID: string }) {
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const message = createMemo(() => messages().find((item) => item.id === props.messageID))
  const metadata = createMemo(() => {
    const item = message()
    return item?.type === "synthetic" ? (item.metadata ?? {}) : {}
  })
  // A notice outside any burst (a failure, a shell) is its own burst of one.
  const burst = createMemo(() => {
    const folded = noticeBurst(messages(), props.messageID)
    if (folded.length > 0) return folded
    const item = message()
    return item ? [item] : []
  })
  const words = createMemo(() => {
    const own = completionWords(burst())
    if (burst().length > 1) return own
    const state = metadata().state
    const actor = metadata().source === "shell" ? "Shell" : own.heading.replace(/^↳ /, "").replace(/ finished$/, "")
    if (state === "error") return { ...own, heading: `! ${actor} failed` }
    if (state === "cancelled") return { ...own, heading: `! ${actor} cancelled` }
    return { ...own, heading: `↳ ${actor} finished` }
  })
  // One finished worker opens its session on click; a folded line names several.
  const child = createMemo(() => {
    const id = metadata().childID
    return burst().length === 1 && metadata().source === "subagent" && typeof id === "string" ? id : undefined
  })
  const link = useSessionLink(props.context, child)
  const color = createMemo(() => {
    const theme = props.context.theme
    if (metadata().state === "error") return theme.text.feedback.error.base
    if (metadata().state === "cancelled") return theme.text.feedback.warning.base
    if (link.hover()) return theme.text.base
    return theme.text.feedback.info.base
  })
  return (
    <Show when={burst()[0]?.id === props.messageID}>
      <box paddingLeft={UNDER} {...link.handlers}>
        <text wrapMode="none" truncate>
          <span style={{ fg: color() }}>{words().heading}</span>
          <Show when={words().suffix}>
            <span style={{ fg: props.context.theme.text.muted }}> · {words().suffix}</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}
