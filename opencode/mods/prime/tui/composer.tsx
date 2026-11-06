// The composer panel's Wakes and Monitors tabs (cmd/prime registers them with
// the host's `ui.composerTab`): the session's pending alarms, or its monitors,
// one row each in the host's own tab style, soonest first. ↑/↓ move the
// highlight (↑ on the first row closes the panel, as the host's tabs do),
// Enter shows the highlighted entry whole, ctrl+d cancels it as `wake_cancel`
// does. The words are ../wakes.ts; the tab mounts only while it is the active
// one, so its keys bind only then.
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { EMPTY, tabEntries, wakeDetail, wakeRow, type WakeTab as Tab } from "../wakes.ts"
import type { Host } from "./host.ts"

/** The keys a tab binds, and the footer's hints for them. */
export const KEYS = { detail: "return", cancel: "ctrl+d" } as const
export const hints = [
  { label: "detail", shortcut: "enter" },
  { label: "cancel", shortcut: KEYS.cancel },
] as const

/** How many rows show before the list scrolls. */
const ROWS = 5

export function WakeTab(props: { readonly host: Host; readonly sessionID: string; readonly tab: Tab; readonly close: () => void }) {
  const reading = props.host.wakes(() => props.sessionID)
  const entries = createMemo(() => tabEntries(reading(), props.tab))
  const [selected, setSelected] = createSignal(0)
  const theme = () => props.host.theme()
  const current = () => entries()[selected()]

  // A cancelled row leaves; the highlight stays on the row that took its place.
  createEffect(() => {
    if (selected() >= entries().length) setSelected(Math.max(0, entries().length - 1))
  })

  const detail = () => {
    const entry = current()
    const now = reading()?.now ?? Date.now()
    if (entry) {
      const shown = wakeDetail(entry, now)
      props.host.showDetail(shown.title, shown.message)
    }
  }
  const cancel = () => {
    const entry = current()
    if (!entry) return
    void props.host.cancelWake(props.sessionID, entry.id).then((refused) => {
      if (refused !== undefined) props.host.notify(`Not cancelled: ${refused}`, "error")
    })
  }

  props.host.composerKeys(() => [
    {
      title: props.tab === "alarm" ? "Previous wake" : "Previous monitor",
      bind: "up",
      run: () => (selected() === 0 ? props.close() : setSelected((index) => index - 1)),
    },
    {
      title: props.tab === "alarm" ? "Next wake" : "Next monitor",
      bind: "down",
      run: () => {
        const count = entries().length
        if (count > 0) setSelected((index) => (index + 1) % count)
      },
    },
    { title: props.tab === "alarm" ? "Show the wake" : "Show the monitor", bind: KEYS.detail, run: detail },
    { title: props.tab === "alarm" ? "Cancel the wake" : "Cancel the monitor", bind: KEYS.cancel, run: cancel },
  ])

  // The window of rows that holds the highlight.
  const first = createMemo(() => Math.min(Math.max(0, selected() - ROWS + 1), Math.max(0, entries().length - ROWS)))
  const shown = createMemo(() => entries().slice(first(), first() + ROWS))

  return (
    <box flexDirection="column">
      <Show when={entries().length > 0} fallback={<text fg={theme().text.muted}> {EMPTY[props.tab]}</text>}>
        <For each={shown()}>
          {(entry, at) => {
            const active = () => first() + at() === selected()
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme().background.action.primary.focused : theme().background.action.primary.base}
                onMouseMove={() => setSelected(first() + at())}
                onMouseUp={() => {
                  setSelected(first() + at())
                  detail()
                }}
              >
                <text
                  fg={active() ? theme().text.action.primary.focused : theme().text.action.primary.base}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {wakeRow(entry, reading()?.now ?? Date.now())}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}
