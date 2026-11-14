// The composer panel's Jobs tab (cmd/prime registers it with the host's
// `ui.composerTab`): the session's jobs, running first and then those that
// ended lately, one row each in the panel's columns (tui/panel.tsx), the time
// live, and under them the highlighted job's log tail. ↑/↓ move the highlight
// (↑ on the first row closes the panel, as the host's tabs do), Enter shows
// the whole job, ctrl+d kills a running one, as the Shell tab kills a shell.
// The words are ../jobs.ts; the tab mounts only while it is the active one,
// so its keys bind only then.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import { spinner } from "@dotfiles/opencode-subagents/line"
import { Option } from "effect"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { jobDetail, jobsOf, logLines, NO_JOBS, runs } from "../jobs.ts"
import { jobLine, widths } from "../panel.ts"
import type { Host } from "./host.ts"
import { PanelLine, useSeconds } from "./panel.tsx"

/** The keys the tab binds, and the footer's hints for them. */
export const KEYS = { detail: "return", kill: "ctrl+d" } as const
export const hints = [
  { label: "detail", shortcut: "enter" },
  { label: "kill", shortcut: KEYS.kill },
] as const

/** How many rows show before the list scrolls. */
const ROWS = 5

export function JobTab(props: { readonly host: Host; readonly sessionID: string; readonly close: () => void }) {
  const reading = props.host.jobs(() => Option.some(props.sessionID))
  const entries = createMemo(() => jobsOf(reading()))
  const [selected, setSelected] = createSignal(0)
  const theme = () => props.host.theme()
  const current = createMemo(() => Option.fromNullishOr(entries()[selected()]))

  // A job that left the board takes the highlight to the row in its place.
  createEffect(() => {
    if (selected() >= entries().length) setSelected(Math.max(0, entries().length - 1))
  })

  const detail = () =>
    Option.map(current(), (job) => {
      const shown = jobDetail(job, Option.match(reading(), { onNone: TuiClock.now, onSome: (read) => read.now }))
      props.host.showDetail(shown.title, shown.message)
    })
  const kill = () =>
    Option.map(Option.filter(current(), runs), (job) =>
      props.host.killJob(props.sessionID, job.id).then(Option.map((refused) => props.host.notify(`Not killed: ${refused}`, "error"))),
    )
  const previous = () => {
    if (selected() === 0) return props.close()
    setSelected((index) => index - 1)
  }
  const next = () => {
    const count = entries().length
    if (count > 0) setSelected((index) => (index + 1) % count)
  }

  props.host.composerKeys(() => [
    { title: "Previous job", bind: "up", run: previous },
    { title: "Next job", bind: "down", run: next },
    { title: "Show the job", bind: KEYS.detail, run: () => void detail() },
    { title: "Kill the job", bind: KEYS.kill, run: () => void kill() },
  ])

  // The window of rows that holds the highlight.
  const first = createMemo(() => Math.min(Math.max(0, selected() - ROWS + 1), Math.max(0, entries().length - ROWS)))
  const shown = createMemo(() => entries().slice(first(), first() + ROWS))
  // The times turn once a second while a job runs, in columns the tab's rows share.
  const now = useSeconds(() => entries().some(runs))
  const lines = createMemo(() => entries().map((job) => jobLine(job, now(), spinner(now()))))
  const cols = createMemo(() => widths(lines()))
  const tail = createMemo(() => logLines(Option.match(current(), { onNone: () => "", onSome: (job) => job.logTail })))
  const quiet = createMemo(() => Option.match(current(), { onNone: () => "", onSome: (job) => `${job.id} · no output yet` }))

  return (
    <box flexDirection="column">
      <Show when={entries().length > 0} fallback={<text fg={theme().text.muted}> {NO_JOBS}</text>}>
        <For each={shown()}>
          {(_job, at) => {
            const active = () => first() + at() === selected()
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={[theme().background.action.primary.base, theme().background.action.primary.focused][Number(active())]}
                onMouseMove={() => setSelected(first() + at())}
                onMouseUp={() => {
                  setSelected(first() + at())
                  detail()
                }}
              >
                <Show when={lines()[first() + at()]}>
                  {(line) => <PanelLine host={props.host} line={line()} widths={cols()} selected={active()} />}
                </Show>
              </box>
            )
          }}
        </For>
        <box flexDirection="column" paddingLeft={3} paddingRight={1}>
          <Show when={tail().length > 0} fallback={<text fg={theme().text.faint}>{quiet()}</text>}>
            <For each={tail()}>
              {(line) => (
                <text wrapMode="none" truncate fg={theme().text.faint}>
                  {line}
                </text>
              )}
            </For>
          </Show>
        </box>
      </Show>
    </box>
  )
}
