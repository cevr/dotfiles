// The background-work panel (Down on an empty prompt) in the Prime look: its
// tab bar, each row of the host's Subagents, Shell and Terminals tabs, and
// its footer, drawn into the fork's `session.composer.panel.*` slots; the
// host keeps the panel's keys, scrolling and row highlight. The Wakes and
// Monitors tabs (composer.tsx) draw their rows with `PanelLine` too. The
// words and the columns are ../panel.ts.
import { keptMemo } from "@dotfiles/opencode-subagents/solid/kept"
import { spinner } from "@dotfiles/opencode-subagents/line"
import { live, subagents } from "@dotfiles/opencode-subagents/subagent-row"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Option } from "effect"
import { createEffect, createMemo, createSignal, Index, on, Show, type Accessor } from "solid-js"
import { wholeSecond } from "../clock.ts"
import {
  footer,
  layout,
  sameCells,
  shellLine,
  subagentLine,
  tabBar,
  terminalLine,
  widths,
  type Kind,
  type Line,
  type Widths,
} from "../panel.ts"
import { tabEntries } from "../wakes.ts"
import { useNow } from "./clock.ts"
import { useOthers } from "./family.ts"
import type { Host } from "./host.ts"
import { roleColor, toneColor } from "./tone.ts"

/** The tab bar's input: the panel's tabs, the active one, and what a click does. */
export type TabsInput = {
  readonly sessionID: string
  readonly open: boolean
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly active: string
  readonly select: (id: string) => void
  readonly dismiss: () => void
}

/** One row's input: which tab, which subject, the tab's subjects in order, and whether it is highlighted. */
export type RowInput = {
  readonly sessionID: string
  readonly tab: "subagents" | "shell" | "terminals"
  readonly id: string
  readonly ids: ReadonlyArray<string>
  readonly label: string
  readonly selected: boolean
  readonly current: boolean
}

/** The footer's input: the active tab's keys, and how many tabs ←/→ cycles. */
export type FooterInput = {
  readonly sessionID: string
  readonly hints: ReadonlyArray<{ readonly label: string; readonly shortcut: string }>
  readonly tabs: number
}

/** How often a Shell row reads its command's output again, while it runs. */
const OUTPUT_MS = 2000

/** A width read from the box that draws it, the terminal's less the panel's frame until the first layout. */
function useWidth() {
  const terminal = useTerminalDimensions()
  const [measured, setMeasured] = createSignal(0)
  return {
    width: () => measured() || Math.max(0, terminal().width - 8),
    measure: function (this: BoxRenderable) {
      const value = this.width
      queueMicrotask(() => setMeasured(value))
    },
  }
}

/**
 * The tab bar: each tab's name, the active one in the text colour, with how
 * many it lists beside it (subagents at work, shells running, wakes and
 * monitors pending), between faint dots; `esc` at the right. A click on a
 * name makes it active, on `esc` puts the panel away.
 */
export function PanelTabs(props: { readonly host: Host; readonly input: TabsInput }) {
  const theme = () => props.host.theme()
  const others = useOthers(props.host, () => Option.some(props.input.sessionID))
  // Read only while the panel shows: the tab bar stays mounted while it is put away.
  const wakes = props.host.wakes(() => Option.getOrUndefined(Option.liftPredicate(props.input.sessionID, () => props.input.open)))
  const counts = createMemo(
    () =>
      new Map([
        ["subagents", others()],
        ["shell", props.host.shells(props.input.sessionID)],
        ["wakes", tabEntries(wakes(), "alarm").length],
        ["monitors", tabEntries(wakes(), "monitor").length],
      ]),
  )
  const { width, measure } = useWidth()
  const cells = createMemo(() => tabBar(props.input.tabs, props.input.active, counts(), Math.max(0, width() - 4)))
  const color = (kind: string): RGBA => {
    if (kind === "active") return theme().text.base
    if (kind === "tab") return theme().text.muted
    return theme().text.faint
  }
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} height={1} onSizeChange={measure}>
      <box flexDirection="row" flexShrink={1} minWidth={0}>
        <Index each={cells()}>
          {(cell) => (
            <text
              wrapMode="none"
              fg={color(cell().kind)}
              onMouseUp={() => {
                if (cell().id !== "") props.input.select(cell().id)
              }}
            >
              {cell().text}
            </text>
          )}
        </Index>
      </box>
      <text wrapMode="none" flexShrink={0} fg={theme().text.faint} onMouseUp={() => props.input.dismiss()}>
        esc
      </text>
    </box>
  )
}

/** The footer, in Prime's hint words: each key in the muted colour, what it does faint, between faint dots. */
export function PanelFooter(props: { readonly host: Host; readonly input: FooterInput }) {
  const theme = () => props.host.theme()
  const cells = createMemo(() => footer(props.input.hints, props.input.tabs))
  return (
    <box flexDirection="row" paddingLeft={1} height={1} flexShrink={0}>
      <text wrapMode="none" truncate>
        <Index each={cells()}>
          {(cell) => <span style={{ fg: [theme().text.faint, theme().text.muted][Number(cell().kind === "key")] }}>{cell().text}</span>}
        </Index>
      </text>
    </box>
  )
}

/**
 * One laid-out row in its tab's columns, at the width of the box that holds
 * it. The highlighted row draws in the theme's highlighted text colour over
 * the band the host paints; the rest in Prime's colours: the diamond and the
 * state's word in the state's, the role in its role's, the name in the text
 * colour, what it last did muted, the model faint, a stale age in the warning
 * colour.
 */
export function PanelLine(props: { readonly host: Host; readonly line: Line; readonly widths: Widths; readonly selected: boolean }) {
  const theme = () => props.host.theme()
  const { width, measure } = useWidth()
  // A reading that draws the same words keeps the cells, so it requests no frame.
  const cells = keptMemo(() => layout(props.line, props.widths, width()), sameCells)
  const color = (kind: Kind): RGBA => {
    if (props.selected) return theme().text.action.primary.focused
    if (kind === "lead" || kind === "state") return toneColor(theme(), props.line.tone)
    if (kind === "role") return roleColor(theme(), props.line.roleTone)
    if (kind === "name" || kind === "time") return theme().text.base
    if (kind === "status") return theme().text.muted
    if (kind === "stale") return theme().text.feedback.warning.base
    return theme().text.faint
  }
  return (
    <box flexGrow={1} minWidth={0} height={1} onSizeChange={measure}>
      <text wrapMode="none" truncate>
        <Index each={cells()}>
          {(cell) => {
            // A cell whose words change keeps its colour, and sets no style again.
            const kind = createMemo(() => cell().kind)
            return <span style={{ fg: color(kind()) }}>{cell().text}</span>
          }}
        </Index>
      </text>
    </box>
  )
}

/** A row of the host's Subagents, Shell or Terminals tab. */
export function PanelRow(props: { readonly host: Host; readonly input: RowInput }) {
  if (props.input.tab === "subagents") return <SubagentRow host={props.host} input={props.input} />
  if (props.input.tab === "shell") return <ShellRow host={props.host} input={props.input} />
  const line = createMemo(() => terminalLine(props.input.label, props.input.current))
  return <PanelLine host={props.host} line={line()} widths={widths([line()])} selected={props.input.selected} />
}

/**
 * The clock in whole seconds, ticking while `active` holds: the times a row
 * shows and its spinner turn once a second. `active` is read through a signal
 * set after the caller's memos exist, as live.tsx does.
 */
export function useSeconds(active: Accessor<boolean>): Accessor<number> {
  const [running, setRunning] = createSignal(false)
  const ticks = useNow(running)
  createEffect(() => setRunning(active()))
  return createMemo(() => wholeSecond(ticks()))
}

function SubagentRow(props: { readonly host: Host; readonly input: RowInput }) {
  const all = createMemo(() => {
    const family = props.host.subagents(props.input.sessionID)
    return subagents(family, family.root)
  })
  const rows = createMemo(() => props.input.ids.flatMap((id) => all().filter((row) => row.id === id)))
  const now = useSeconds(() => rows().some((row) => live(row.state)))
  const lines = createMemo(() => rows().map((row) => subagentLine(row, now(), spinner(now()))))
  const line = createMemo(() => lines()[props.input.ids.indexOf(props.input.id)])
  // A session the family reader does not know yet reads as the host words it.
  const fallback = createMemo(() => terminalLine(props.input.label, false))
  return (
    <Show when={line()} fallback={<PanelLine host={props.host} line={fallback()} widths={widths([fallback()])} selected={props.input.selected} />}>
      {(shown) => <PanelLine host={props.host} line={shown()} widths={widths(lines())} selected={props.input.selected} />}
    </Show>
  )
}

function ShellRow(props: { readonly host: Host; readonly input: RowInput }) {
  const shells = createMemo(() => {
    const listed = props.host.shellList(props.input.sessionID)
    return props.input.ids.flatMap((id) => listed.filter((shell) => shell.id === id))
  })
  const shell = createMemo(() => shells().find((each) => each.id === props.input.id))
  const now = useSeconds(() => shell()?.status === "running")
  // The output's last line, read again every OUTPUT_MS of the row's clock while the command runs.
  const [output, setOutput] = createSignal("")
  createEffect(
    on(
      () => Math.floor(now() / OUTPUT_MS),
      () => {
        void props.host.shellTail(props.input.id).then(setOutput)
      },
    ),
  )
  const frame = () => spinner(now())
  const lines = createMemo(() => shells().map((each) => shellLine(each, now(), "", frame())))
  const line = createMemo(() => {
    const own = shell()
    return own && shellLine(own, now(), output(), frame())
  })
  const fallback = createMemo(() => terminalLine(props.input.label, false))
  return (
    <Show when={line()} fallback={<PanelLine host={props.host} line={fallback()} widths={widths([fallback()])} selected={props.input.selected} />}>
      {(shown) => <PanelLine host={props.host} line={shown()} widths={widths(lines())} selected={props.input.selected} />}
    </Show>
  )
}
