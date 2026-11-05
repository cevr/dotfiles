// Session rows that are no call: a background worker's completion line, and
// how a step ended badly. Workers that finish together read as one line
// (`↳ 3 agents finished · fix-a, fix-b, fix-c`); the first notice of the
// burst draws it and the rest draw nothing (notice.ts). A step's end draws
// gent's session row: `↻` a retry, `■` an interrupt, `✗` an error, and
// nothing for a step that ended well (Prime closes a turn with no agent,
// model or duration line; step-end.ts).
import { createMemo, Show, type Accessor } from "solid-js"
import type { Detail } from "../detail.ts"
import { completion } from "../notice.ts"
import { stepEndRow } from "../step-end.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { useSessionLink } from "./link.ts"
import { toneColor } from "./tone.ts"
import { GUTTER } from "./transcript.tsx"

/** Where a completion line starts: under the text of a group's header. */
const UNDER = GUTTER + 2

export function Completion(props: { host: Host; sessionID: string; messageID: string }) {
  const line = createMemo(() => completion(props.host.messages(props.sessionID), props.messageID))
  // One finished worker opens its session on click; a folded line names several.
  const link = useSessionLink(props.host, () => line()?.child)
  const color = createMemo(() => {
    const tone = line()?.tone ?? "info"
    if (tone === "info" && link.hover()) return props.host.theme().text.base
    return toneColor(props.host.theme(), tone)
  })
  return (
    <Show when={line()?.drawn ? line() : undefined}>
      {(shown) => (
        <box paddingLeft={UNDER} {...link.handlers}>
          <text wrapMode="none" truncate>
            <span style={{ fg: color() }}>{shown().heading}</span>
            <Show when={shown().suffix}>
              <span style={{ fg: props.host.theme().text.muted }}> · {shown().suffix}</span>
            </Show>
          </text>
        </box>
      )}
    </Show>
  )
}

/** Where a session row's glyph sits: the column a group's glyph sits in. */
const GLYPH = GUTTER

export function StepEnd(props: { host: Host; sessionID: string; messageID: string; detail: Accessor<Detail> }) {
  const message = createMemo(() => {
    const found = props.host.message(props.sessionID, props.messageID)
    return found?.type === "assistant" ? found : undefined
  })
  // A pending retry counts down; nothing else ticks.
  const now = useNow(() => message()?.retry !== undefined)
  const row = createMemo(() => {
    const found = message()
    return found ? stepEndRow({ error: found.error, retry: found.retry }, now(), props.detail()) : undefined
  })
  return (
    <Show when={row()}>
      {(shown) => (
        <box marginTop={1} paddingLeft={GLYPH} flexDirection="row" flexShrink={0}>
          <text width={2} flexShrink={0} fg={toneColor(props.host.theme(), shown().tone)}>
            {shown().glyph}
          </text>
          <text flexGrow={1} flexShrink={1} wrapMode="word" fg={toneColor(props.host.theme(), shown().tone)}>
            {shown().text}
          </text>
        </box>
      )}
    </Show>
  )
}
