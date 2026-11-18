// The composer panel's Queue tab (cmd/prime registers it with the host's
// `ui.composerTab` once a queue plugin answers): the root session's queue as
// a plan, the queue mod's `plan` (../../queue/plan.ts), one line each: every
// item a block with its outcomes, what waits on it nested under it. ↑/↓ move
// the highlight between items (↑ on the first closes the panel, as the host's
// tabs do); Enter (or a click) answers the item: it opens the host's question
// form with the item's whole block, the choices the agent gave it (or the
// queue mod's own: done, still needed) and a line to type one's own, and the
// submit goes to the agent as one message (../../queue/answer.ts). ctrl+o
// opens a linked subagent's session. The tab mounts only while it is the
// active one, so its keys bind only then.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { formOf } from "@dotfiles/opencode-queue/answer"
import type { Mark } from "@dotfiles/opencode-queue/board"
import { plan, planText, segments, type ItemLine, type Tone } from "@dotfiles/opencode-queue/plan"
import type { RGBA } from "@opentui/core"
import { Array as Arr, Option } from "effect"
import { createEffect, createMemo, createSignal, Index, Show } from "solid-js"
import type { Host } from "./host.ts"

/** The tab's id among the panel's. */
export const QUEUE_TAB = "queue"

/** The keys the tab binds, and the footer's hints for them. */
export const KEYS = { answer: "return", session: "ctrl+o" } as const
export const hints = [
  { label: "answer", shortcut: "enter" },
  { label: "session", shortcut: KEYS.session },
] as const

/** How many lines show before the plan scrolls. */
const LINES = 14

/** What an empty queue says. */
export const EMPTY = "Nothing queued."

export function QueueTab(props: { readonly host: Host; readonly sessionID: string; readonly close: () => void }) {
  const theme = () => props.host.theme()
  const reading = props.host.queue(() => Option.some(props.sessionID))
  const lines = createMemo(() => Option.match(reading(), { onNone: () => [], onSome: (shown) => plan(shown.items, shown.live, TuiClock.now()) }))
  // The highlight moves between items: the index of each item's own line.
  const items = createMemo(() => Arr.filter(Arr.map(lines(), (line, index) => [line.kind, index] as const), ([kind]) => kind === "item").map(([, index]) => index))
  const [selected, setSelected] = createSignal(0)
  createEffect(() => {
    if (selected() >= items().length) setSelected(Math.max(0, items().length - 1))
  })
  const at = () => Option.getOrElse(Arr.get(items(), selected()), () => -1)

  const highlighted = () => Option.filter(Arr.get(lines(), at()), (line): line is ItemLine => line.kind === "item")

  // The highlighted item's answer form, with its block whole; the panel steps aside for it.
  const answer = () =>
    Option.map(
      Option.flatMap(reading(), (shown) =>
        Option.map(
          Option.flatMap(highlighted(), (line) => Arr.findFirst(shown.items, (each) => each.id === line.key)),
          (item) => formOf(shown.root, item, detailOf(item.id)),
        ),
      ),
      (form) =>
        props.host.answerQueue(props.sessionID, form).then((opened) => {
          if (opened === "failed") return props.host.notify("The answer form did not open", "error")
          props.close()
        }),
    )
  /** An item's block whole, as the tab draws it. */
  const detailOf = (id: string) =>
    lines()
      .filter((each) => each.key === id)
      .map((each) => planText({ ...each, depth: 0 }).trim())
      .join("\n")

  // A linked item opens its subagent's session; another hands the key on.
  const session = () =>
    Option.match(
      Option.flatMap(highlighted(), (line) => line.session),
      {
        onNone: () => false as const,
        onSome: (id) => props.host.open(id),
      },
    )

  props.host.composerKeys(() => [
    {
      title: "Previous item",
      bind: "up",
      run: () => {
        if (selected() === 0) return props.close()
        setSelected((index) => index - 1)
      },
    },
    {
      title: "Next item",
      bind: "down",
      run: () => {
        const count = items().length
        if (count > 0) setSelected((index) => (index + 1) % count)
      },
    },
    { title: "Answer the item", bind: KEYS.answer, run: () => void answer() },
    { title: "Open the item's session", bind: KEYS.session, run: session },
  ])

  // The window of lines that holds the highlighted item's line.
  const first = createMemo(() => Math.min(Math.max(0, at() - LINES + 2), Math.max(0, lines().length - LINES)))
  const shown = createMemo(() => lines().slice(first(), first() + LINES))

  const color = (tone: Tone, highlighted: boolean): RGBA => {
    const text = theme().text
    if (highlighted && tone !== "guide") return text.action.primary.focused
    const marks: Readonly<Record<Mark, RGBA>> = {
      "needs-you": text.feedback.warning.base,
      blocked: text.feedback.warning.base,
      failed: text.feedback.error.base,
      running: text.feedback.info.base,
      next: text.base,
      scheduled: text.base,
      waiting: text.muted,
      done: text.muted,
    }
    if (tone === "text") return text.base
    if (tone === "arrow") return text.feedback.warning.base
    if (tone === "label" || tone === "muted") return text.muted
    if (tone === "guide" || tone === "faint") return text.faint
    return marks[tone]
  }

  return (
    <box flexDirection="column">
      <Show when={lines().length > 0} fallback={<text fg={theme().text.muted}> {EMPTY}</text>}>
        <Index each={shown()}>
          {(line, index) => {
            const highlighted = () => first() + index === at()
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                height={1}
                backgroundColor={[theme().background.action.primary.base, theme().background.action.primary.focused][Number(highlighted())]}
                onMouseMove={() => {
                  const item = items().indexOf(first() + index)
                  if (item >= 0) setSelected(item)
                }}
                onMouseUp={() => {
                  const item = items().indexOf(first() + index)
                  if (item < 0) return
                  setSelected(item)
                  void answer()
                }}
              >
                <text wrapMode="none" truncate>
                  <Index each={segments(line())}>{(segment) => <span style={{ fg: color(segment().tone, highlighted()) }}>{segment().text}</span>}</Index>
                </text>
              </box>
            )
          }}
        </Index>
      </Show>
    </box>
  )
}
