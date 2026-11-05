// The live subagent rows beneath the composer: one line per subagent of the
// route's family, as `@dotfiles/opencode-subagents` reads and formats it. A
// row opens its session on click and brightens under the pointer; inside a
// subagent the current one is marked. While the host shows the session's
// sidebar, the sidebar carries the agents and the rows step aside.
import type { Plugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { useNow } from "./clock"
import { useSessionLink } from "./link"
import { columns, format, spinner, type Columns, type Kind } from "@dotfiles/opencode-subagents/line"
import { read } from "@dotfiles/opencode-subagents/opencode/view"
import { subagents, visible, type Row as SubagentRow, type Tone } from "@dotfiles/opencode-subagents/subagent-row"
import { capped, moreLine, sidebarShown } from "./rows"

type Context = Plugin.Context

/** The rows for `sessionID`'s family; `child` when the route is one of the subagents, which is then marked. */
export function SubagentRows(props: { context: Context; sessionID: string; child: boolean }) {
  const all = createMemo(() => {
    const family = read(props.context.data, props.sessionID)
    return subagents(family, family.root)
  })
  const hidden = createMemo(() => sidebarShown(props.context.ui, props.sessionID))
  // The clock ticks while a row runs, waits or lingers in view, and settles once none does.
  const now = useNow(() => live())
  const live = createMemo(() => !hidden() && visible(all(), now()).length > 0)
  const current = () => (props.child ? { current: props.sessionID } : {})
  const shown = createMemo(() => capped(visible(all(), now(), current())))
  const cols = createMemo(() => columns(shown().rows))
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const width = createMemo(() => measured() ?? Math.max(0, terminal().width - 2))
  return (
    <Show when={!hidden() && shown().rows.length > 0}>
      <box
        flexDirection="column"
        flexShrink={0}
        onSizeChange={function (this: BoxRenderable) {
          const value = this.width
          queueMicrotask(() => setMeasured(value))
        }}
      >
        <For each={shown().rows}>
          {(row) => (
            <Row
              context={props.context}
              row={row}
              width={width()}
              columns={cols()}
              now={now}
              marked={props.child && row.id === props.sessionID}
              marking={props.child}
            />
          )}
        </For>
        <Show when={moreLine(shown().more, props.child)}>
          {(line) => (
            <text wrapMode="none" truncate fg={props.context.theme.text.faint}>
              {line()}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

function Row(props: {
  context: Context
  row: SubagentRow
  width: number
  columns: Columns
  now: Accessor<number>
  marked: boolean
  marking: boolean
}) {
  const theme = () => props.context.theme
  const link = useSessionLink(props.context, () => (props.marked ? undefined : props.row.id))
  const segments = createMemo(() =>
    format(props.row, props.width, {
      columns: props.columns,
      // One clock for every spinner, so the rows turn together.
      spinner: spinner(props.now()),
      ...(props.marking ? { mark: props.marked ? "marked" : "unmarked" } : {}),
    }),
  )
  const roleColor = (tone: Tone): RGBA => {
    if (tone === "planner") return theme().hue.interactive[300]
    if (tone === "implementor") return theme().hue.accent[300]
    if (tone === "verifier") return theme().text.feedback.info.base
    if (tone === "worker") return theme().text.feedback.success.base
    if (tone === "general") return theme().text.muted
    return theme().text.base
  }
  const leadColor = (): RGBA => {
    const state = props.row.state
    if (state === "running" || state === "done") return theme().text.feedback.success.base
    if (state === "failed") return theme().text.feedback.error.base
    if (state === "blocked" || state === "cancelled") return theme().text.feedback.warning.base
    return theme().text.muted
  }
  const bright = () => link.hover() || props.marked
  const color = (kind: Kind): RGBA => {
    if (kind === "lead") return leadColor()
    if (kind === "role") return roleColor(props.row.tone)
    if (kind === "spinner") return theme().hue.accent[300]
    if (kind === "mark") return theme().text.base
    if (kind === "faint") return theme().text.faint
    if (kind === "update" && props.row.state === "blocked") return theme().text.feedback.warning.base
    if (kind === "update" && props.row.state === "failed") return theme().text.feedback.error.base
    return bright() ? theme().text.base : theme().text.muted
  }
  return (
    <box height={1} flexShrink={0} {...link.handlers}>
      <text wrapMode="none" truncate>
        <For each={segments()}>{(segment) => <span style={{ fg: color(segment.kind) }}>{segment.text}</span>}</For>
      </text>
    </box>
  )
}
