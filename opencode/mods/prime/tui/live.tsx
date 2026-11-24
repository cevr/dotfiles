// The live subagent rows beneath the composer: one line per subagent of the
// route's family, as `@dotfiles/opencode-subagents` reads and formats it. A
// row opens its session on click and brightens under the pointer; inside a
// subagent the current one is marked. They show whether or not the host shows
// the session's sidebar, which carries only the queue. A phone-sized terminal
// (rows.ts, `compact`) draws none, the count line above them still opening
// every one; resized back, they return. Past six rows the wheel over them
// scrolls them in place, the count line under them saying where they are.
import { columns, format, sameSegments, spinner, stateTone, type Columns, type Kind } from "@dotfiles/opencode-subagents/line"
import { keptMemo } from "@dotfiles/opencode-subagents/solid/kept"
import { subagents, visible, type Row as SubagentRow } from "@dotfiles/opencode-subagents/subagent-row"
import type { BoxRenderable, MouseEvent, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, on, Show, type Accessor } from "solid-js"
import { wholeSecond } from "../clock.ts"
import { compact, countLine, scrolled, windowed } from "../rows.ts"
import { useNow } from "./clock.ts"
import type { Host } from "./host.ts"
import { useSessionLink } from "./link.ts"
import { roleColor } from "./tone.ts"

/** The rows for `sessionID`'s family; `child` when the route is one of the subagents, which is then marked. */
export function SubagentRows(props: { host: Host; sessionID: string; child: boolean }) {
  const terminal = useTerminalDimensions()
  // Unmounted while compact, so no clock ticks for rows that are not drawn.
  return (
    <Show when={!compact(terminal())}>
      <Rows host={props.host} sessionID={props.sessionID} child={props.child} />
    </Show>
  )
}

function Rows(props: { host: Host; sessionID: string; child: boolean }) {
  const all = createMemo(() => {
    const family = props.host.subagents(props.sessionID)
    return subagents(family, family.root)
  })
  // The clock ticks while a row works, waits or lingers in view, and settles once none does.
  // Whether rows are live depends on the clock, so the clock follows a signal set after both
  // exist: Solid may run useNow's effect at once, before a later `const` is initialised.
  const [active, setActive] = createSignal(false)
  const ticks = useNow(active)
  // The rows read the clock in whole seconds, the unit their elapsed time shows: every row's
  // time and spinner turn on the same tick, once a second, and the ticks between draw nothing.
  const now = createMemo(() => wholeSecond(ticks()))
  const live = createMemo(() => visible(all(), now()).length > 0)
  createEffect(() => setActive(live()))
  const current = () => (props.child ? { current: props.sessionID } : {})
  const list = createMemo(() => visible(all(), now(), current()))
  // The strip mounts again when it was hidden (no rows) and comes back, so its scroll starts at the top then.
  return (
    <Show when={list().length > 0}>
      <Strip host={props.host} sessionID={props.sessionID} child={props.child} list={list} now={now} />
    </Show>
  )
}

/**
 * The rows in view and the count line. The wheel over them scrolls them a row
 * a step, in place: the strip keeps its height, and the transcript behind it
 * stays. The offset is a place in the list, so ticks and rows changing state
 * keep it, and a row leaving while scrolled clamps it (rows.ts, `windowed`).
 */
function Strip(props: { host: Host; sessionID: string; child: boolean; list: Accessor<ReadonlyArray<SubagentRow>>; now: Accessor<number> }) {
  const [offset, setOffset] = createSignal(0)
  const shown = createMemo(() => windowed(props.list(), offset()))
  // Kept clamped, so a step after rows left starts from the window drawn.
  createEffect(() => {
    const clamped = shown().offset
    if (clamped !== offset()) setOffset(clamped)
  })
  const cols = createMemo(() => columns(shown().rows))
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal<number>()
  const width = createMemo(() => measured() ?? Math.max(0, terminal().width - 2))
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      onSizeChange={function (this: BoxRenderable) {
        const value = this.width
        queueMicrotask(() => setMeasured(value))
      }}
      onMouseScroll={(event: MouseEvent) => {
        // The strip takes every wheel step over it, moved or not: none reaches the transcript.
        event.stopPropagation()
        setOffset((at) => scrolled(at, event.scroll?.direction ?? "", props.list().length))
      }}
    >
      {/* By place, not by object: a tick gives every live row a new object, and a row kept in place only redraws what changed. */}
      <Index each={shown().rows}>
        {(row) => (
          <Row
            host={props.host}
            row={row()}
            width={width()}
            columns={cols()}
            now={props.now}
            marked={props.child && row().id === props.sessionID}
            marking={props.child}
          />
        )}
      </Index>
      <Show when={countLine(shown(), props.child)}>
        {(line) => (
          <text wrapMode="none" truncate fg={props.host.theme().text.faint}>
            {line()}
          </text>
        )}
      </Show>
    </box>
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
  // Demand follows the rendered child, not the family, a timer tick, or a
  // streamed token. A fresh TUI must request the same history as a warm one.
  createEffect(on(() => props.row.id, (sessionID) => props.host.syncSubagentMessages(sessionID)))
  const theme = () => props.host.theme()
  const link = useSessionLink(props.host, () => (props.marked ? undefined : props.row.id))
  // A reading that draws the same words keeps the segments, so it requests no frame.
  const segments = keptMemo(
    () =>
      format(props.row, props.width, {
        columns: props.columns,
        // One clock for every spinner, so the rows turn together.
        spinner: spinner(props.now()),
        ...(props.marking ? { mark: props.marked ? "marked" : "unmarked" } : {}),
      }),
    sameSegments,
  )
  // The state shows only as the leading diamond, so its colour carries it (line.ts, `stateTone`).
  const stateColor = (): RGBA => {
    const tone = stateTone(props.row.state)
    if (tone === "success") return theme().text.feedback.success.base
    if (tone === "warning") return theme().text.feedback.warning.base
    if (tone === "error") return theme().text.feedback.error.base
    if (tone === "info") return theme().text.feedback.info.base
    return theme().text.muted
  }
  const bright = () => link.hover() || props.marked
  const color = (kind: Kind): RGBA => {
    if (kind === "lead") return stateColor()
    if (kind === "role") return roleColor(theme(), props.row.tone)
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
        <Index each={segments()}>
          {(segment) => {
            // A segment whose words change keeps its colour, and sets no style again.
            const kind = createMemo(() => segment().kind)
            return <span style={{ fg: color(kind()) }}>{segment().text}</span>
          }}
        </Index>
      </text>
    </box>
  )
}
