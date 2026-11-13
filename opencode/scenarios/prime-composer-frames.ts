// What scenarios/prime-composer.ts waits for before it keeps each frame, and
// what tests/prime-composer.test.ts asserts on it, in one place: a frame is
// kept only once it shows all the test then asks of it. (A wait on the tab
// names alone kept the panel before the pending alarm and monitor reached its
// tab bar, `Wakes  ·  Monitors` without their counts, on a loaded host.)

/** A line as expected, as a pattern it matches whole or in part. */
export type Want = RegExp

/** The exact text `line`, as a pattern. */
const exact = (line: string) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)

/** Any line: a part of the frame the test does not assert. */
const ANY = /(?:)/

export const fits = (want: Want, line: string) => want.test(line)

const fitsAll = (wants: ReadonlyArray<Want>, lines: ReadonlyArray<string>) =>
  lines.length === wants.length && wants.every((want, at) => fits(want, lines[at] ?? ""))

/** The panel: its tab row, then its entries up to its hint line, without the rail. */
export function panel(frame: ReadonlyArray<string>) {
  const at = frame.findIndex((line) => line.includes("Subagents") && line.includes("Monitors"))
  const end = frame.findIndex((line, index) => index > at && line.includes("←/→ tabs"))
  const clean = (line = "") => line.replace(/^ ┃/, "").trim()
  return {
    open: at >= 0 && end > at,
    tabs: clean(frame[at]),
    rows: frame.slice(at + 1, Math.max(at + 1, end)).flatMap((line) => [clean(line)].filter(Boolean)),
    hints: clean(frame[end]),
  }
}

interface PanelWant {
  readonly tabs: Want
  readonly rows: ReadonlyArray<Want>
  readonly hints: Want
}

/** Each kept frame of the open panel: its tab bar, its rows and its hint line, where the test asserts them. */
export const PANEL = {
  // Prime's tab bar: the names between faint dots, with how many each lists; the alarm and the monitor are pending.
  panel: { tabs: /^Subagents {2}· {2}Shell {2}· {2}Terminals {2}· {2}Wakes 1 {2}· {2}Monitors 1 +esc$/, rows: [exact("No active subagents")], hints: ANY },
  wakes: {
    tabs: ANY,
    rows: [/^◇ ALPHA: check the deploy {2}wake · once +pending {2}in (9m \d\ds|10m)$/],
    hints: exact("Enter detail · Ctrl+D cancel · ←/→ tabs"),
  },
  cancelled: { tabs: ANY, rows: [exact("No pending wakes")], hints: ANY },
  monitors: { tabs: ANY, rows: [/^[◆◇] echo still-waiting {2}still-waiting +watching +\d+s {2}checked \d+s ago$/], hints: ANY },
} satisfies Record<string, PanelWant>

export type PanelFrame = keyof typeof PANEL

/** Whether the open panel in `frame` shows all `PANEL[name]` asserts. */
export function panelShows(name: PanelFrame, frame: ReadonlyArray<string>) {
  const shown = panel(frame)
  const want: PanelWant = PANEL[name]
  return shown.open && fitsAll(want.rows, shown.rows) && fits(want.tabs, shown.tabs) && fits(want.hints, shown.hints)
}

/** The alarm's whole entry, Enter on its row: its id, its repeat and its mode in words. */
export const DETAIL: ReadonlyArray<Want> = [/Wake w[0-9a-z]{6}/, /Repeat: once/, /Mode: wake: its fire starts a turn/]

export const detailShows = (frame: ReadonlyArray<string>) => DETAIL.every((want) => want.test(frame.join("\n")))

/** The dock's count line with the panel closed: the monitor and no wake. */
export const CLOSED = "◆ 0 subagents  ·  0 shells  ·  1 monitor"

export const closedDock = (frame: ReadonlyArray<string>) => (frame.find((line) => line.includes("subagents  ·")) ?? "").trim()

/** The dock's rule, the last one in the frame. */
const ruleOf = (frame: ReadonlyArray<string>) => frame.findLastIndex((line) => /^ ─{20,}$/.test(line))

/** Nothing active: no count anywhere, and under the rule only the gap row before the host's footer. */
export function noneShows(frame: ReadonlyArray<string>) {
  const counted = frame.some((line) => /◆ \d+ subagents?|\d+ shells?\b|\d+ (wake|monitor)s?\b/.test(line))
  return !counted && ruleOf(frame) > 0 && fitsAll([exact(""), /Server/], underRule(frame, 2))
}

/** A pending wake alone: the count line back right under the rule, counting it, then the gap row and the footer. */
export const ALARM: ReadonlyArray<Want> = [exact("◆ 0 subagents  ·  0 shells  ·  1 wake"), exact(""), /Server/]

export const underRule = (frame: ReadonlyArray<string>, rows: number) => {
  const rule = ruleOf(frame)
  return frame.slice(rule + 1, rule + 1 + rows).map((line) => line.trim())
}

export const alarmShows = (frame: ReadonlyArray<string>) => ruleOf(frame) > 0 && fitsAll(ALARM, underRule(frame, ALARM.length))
