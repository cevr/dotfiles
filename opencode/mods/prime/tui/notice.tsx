// Session rows that are no call: a background worker's or shell's stop
// notice, drawn as a tool-call group (a header over a `├`/`└` tree of what it
// answered, notice.ts), and how a step ended badly. Workers that finish
// together read as one group (`● 3 agents finished`, a node per worker); the
// first notice of the burst draws it and the rest draw nothing. A step's end
// draws gent's session row: `↻` a retry, `■` an interrupt, `✗` an error, and
// nothing for a step that ended well (Prime closes a turn with no agent,
// model or duration line; step-end.ts).
import { createMemo, For, Show, type Accessor } from "solid-js"
import type { Detail } from "../detail.ts"
import type { Run } from "../group.ts"
import { noticeApart, noticeGroup, noticeLines, type NoticeLine } from "../notice.ts"
import { stepEndRow } from "../step-end.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { useSessionLink } from "./link.ts"
import { toneColor } from "./tone.ts"
import { GUTTER } from "./transcript.tsx"

export function Completion(props: { host: Host; sessionID: string; messageID: string; detail: Accessor<Detail> }) {
  const group = createMemo(() => noticeGroup(props.host.messages(props.sessionID), props.messageID))
  const apart = createMemo(
    () => props.detail() !== "overview" && noticeApart(props.host.messages(props.sessionID), props.messageID),
  )
  // One finished worker opens its session from its header; a burst's nodes each open their own.
  const link = useSessionLink(props.host, () => group()?.child)
  const theme = () => props.host.theme()
  return (
    <Show when={group()?.drawn ? group() : undefined}>
      {(shown) => (
        <box flexDirection="column" flexShrink={0} paddingTop={apart() ? 1 : 0}>
          <box paddingLeft={GUTTER} {...link.handlers}>
            <text wrapMode="none" truncate fg={theme().text.muted}>
              <span style={{ fg: toneColor(theme(), shown().glyph.tone) }}>{shown().glyph.char}</span>{" "}
              <NoticeRuns host={props.host} runs={shown().header} hover={link.hover()} />
            </text>
          </box>
          <For each={noticeLines(shown(), props.detail())}>{(line) => <NoticeTreeLine host={props.host} line={line} />}</For>
        </box>
      )}
    </Show>
  )
}

/** A notice's line in runs; hovered, its muted words brighten to the text colour, as a call row's do. */
function NoticeRuns(props: { host: Host; runs: ReadonlyArray<Run>; hover: boolean }) {
  return (
    <For each={[...props.runs]}>
      {(run) => (
        <span style={{ fg: props.hover && run.tone === "muted" ? props.host.theme().text.base : toneColor(props.host.theme(), run.tone) }}>
          {run.text}
        </span>
      )}
    </For>
  )
}

function NoticeTreeLine(props: { host: Host; line: NoticeLine }) {
  const link = useSessionLink(props.host, () => props.line.child)
  return (
    <box paddingLeft={GUTTER} {...link.handlers}>
      <text wrapMode="none" truncate fg={props.host.theme().text.muted}>
        {props.line.lead} <NoticeRuns host={props.host} runs={props.line.runs} hover={link.hover()} />
      </text>
    </box>
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
