// Session rows that are no call: a background worker's or shell's stop
// notice, drawn as a tool-call group (a header over a `├`/`└` tree of what it
// answered, notice.ts), and how a step ended badly. Workers that finish
// together read as one group (`● 3 agents finished`, a node per worker); the
// first notice of the burst draws it and the rest draw nothing. A worker that
// finished well is its header alone below All; a click opens its whole answer
// in place, and the next closes it (the Subagents picker opens its session). A step's end
// draws its session row: `↻` a retry, `■` an interrupt, `✗` an error, and
// nothing for a step that ended well (Prime closes a turn with no agent,
// model or duration line; step-end.ts).
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import type { Detail } from "../detail.ts"
import type { Run } from "../group.ts"
import { noticeApart, noticeGroup, noticeLines } from "../notice.ts"
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
  // A failed or cancelled worker opens its session from its header.
  const link = useSessionLink(props.host, () => group()?.child)
  // Workers that finished well open their whole answer in place on a click, and close it on the next.
  const fold = useFold(props.host, () => group()?.folds === true)
  const theme = () => props.host.theme()
  const hover = () => link.hover() || fold.hover()
  // A notice either folds or has a session to open (notice.ts), so the header runs both: one of them acts.
  const header = {
    onMouseOver: () => {
      link.handlers.onMouseOver()
      fold.handlers.onMouseOver()
    },
    onMouseOut: () => {
      link.handlers.onMouseOut()
      fold.handlers.onMouseOut()
    },
    onMouseUp: () => {
      link.handlers.onMouseUp()
      fold.handlers.onMouseUp()
    },
  }
  return (
    <Show when={group()?.drawn ? group() : undefined}>
      {(shown) => (
        <box flexDirection="column" flexShrink={0} paddingTop={apart() ? 1 : 0}>
          <box paddingLeft={GUTTER} {...header}>
            <text wrapMode="none" truncate fg={theme().text.muted}>
              <span style={{ fg: toneColor(theme(), shown().glyph.tone) }}>{shown().glyph.char}</span>{" "}
              <NoticeRuns host={props.host} runs={shown().header} hover={hover()} />
            </text>
          </box>
          <For each={noticeLines(shown(), props.detail(), fold.opened())}>
            {(line) => (
              <box paddingLeft={GUTTER} {...fold.handlers}>
                <text wrapMode="none" truncate fg={theme().text.muted}>
                  {line.lead} <NoticeRuns host={props.host} runs={line.runs} hover={fold.hover()} />
                </text>
              </box>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}

/**
 * Pointer handlers that open and close a notice's answer on click (when it
 * `folds`), and whether the pointer is over it. A drag that selected text is
 * a copy, not a click.
 */
function useFold(host: Host, folds: Accessor<boolean>) {
  const [opened, setOpened] = createSignal(false)
  const [over, setOver] = createSignal(false)
  return {
    opened,
    hover: () => over() && folds(),
    handlers: {
      onMouseOver: () => setOver(true),
      onMouseOut: () => setOver(false),
      onMouseUp: () => {
        if (host.selecting() || !folds()) return
        setOpened((open) => !open)
      },
    },
  }
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
