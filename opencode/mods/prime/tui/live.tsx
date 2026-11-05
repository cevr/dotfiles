// The live subagent rows beneath the composer: one line per subagent of the
// route's family, as `@dotfiles/opencode-subagents` reads and formats it. A
// row opens its session on click and brightens under the pointer; inside a
// subagent the current one is marked. They show whether or not the host shows
// the session's sidebar, which carries only the queue.
import { columns, format, spinner, stateTone, type Columns, type Kind } from "@dotfiles/opencode-subagents/line"
import { subagents, visible, type Row as SubagentRow, type Tone } from "@dotfiles/opencode-subagents/subagent-row"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { capped, moreLine } from "../rows.ts"
import { working as familyWorking } from "../subagent.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { useSessionLink } from "./link.ts"

/**
 * Which sessions of `sessionID`'s family work now: the host runs them, or
 * their subagent row is live (subagent.ts).
 */
export function working(host: Host, sessionID: string): (id: string) => boolean {
  return familyWorking(host.subagents(sessionID), (id) => host.status(id) === "running")
}

/** The rows for `sessionID`'s family; `child` when the route is one of the subagents, which is then marked. */
export function SubagentRows(props: { host: Host; sessionID: string; child: boolean }) {
  const all = createMemo(() => {
    const family = props.host.subagents(props.sessionID)
    return subagents(family, family.root)
  })
  // The clock ticks while a row works, waits or lingers in view, and settles once none does.
  // Whether rows are live depends on the clock, so the clock follows a signal set after both
  // exist: Solid may run useNow's effect at once, before a later `const` is initialised.
  const [active, setActive] = createSignal(false)
  const now = useNow(active)
  const live = createMemo(() => visible(all(), now()).length > 0)
  createEffect(() => setActive(live()))
  const current = () => (props.child ? { current: props.sessionID } : {})
  const shown = createMemo(() => capped(visible(all(), now(), current())))
  const cols = createMemo(() => columns(shown().rows))
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const width = createMemo(() => measured() ?? Math.max(0, terminal().width - 2))
  return (
    <Show when={shown().rows.length > 0}>
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
              host={props.host}
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
            <text wrapMode="none" truncate fg={props.host.theme().text.faint}>
              {line()}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

function Row(props: {
  host: Host
  row: SubagentRow
  width: number
  columns: Columns
  now: Accessor<number>
  marked: boolean
  marking: boolean
}) {
  const theme = () => props.host.theme()
  const link = useSessionLink(props.host, () => (props.marked ? undefined : props.row.id))
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
  // The state shows only as the leading diamond, so its colour carries it (line.ts, `stateTone`).
  const stateColor = (): RGBA => {
    const tone = stateTone(props.row.state)
    if (tone === "success") return theme().text.feedback.success.base
    if (tone === "warning") return theme().text.feedback.warning.base
    if (tone === "error") return theme().text.feedback.error.base
    return theme().text.muted
  }
  const bright = () => link.hover() || props.marked
  const color = (kind: Kind): RGBA => {
    if (kind === "lead") return stateColor()
    if (kind === "role") return roleColor(props.row.tone)
    if (kind === "mark") return theme().text.base
    if (kind === "faint" || kind === "model") return theme().text.faint
    if (kind === "stale") return theme().text.feedback.warning.base
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
