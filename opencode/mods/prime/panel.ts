// The background-work panel (Down on an empty prompt) in the Prime look, as
// plain values: its tab bar, its footer, and one line per row in every tab,
// each in the same columns, as Prime Agent's agents view lays a session out.
//
//   ◈ implementor opus 5.5  Corpus HP   editing src/corpus.ts   working   3h 40m  updated 13m ago
//   ◈                       bun test    ok 12 passed            running   1m 05s
//   ◇                       Check CI    wake · once             pending  in 4m 12s
//
// A row says who (a subagent's role and model), its name, what it last said
// or did, its state in a word, how long it has been at it (live) and, where
// the data says, how long since it was last heard from. The diamond leads in
// the state's colour (@dotfiles/opencode-subagents/line), and every row of a
// tab shares its columns, so the times line up at the right. As the width
// shrinks the parts drop in turn: the last-heard age, the model's version,
// the model, the state's word, then what it last did; the name is cut next,
// then the role drops, and the name and the time go last.
import { duration, fit, glyph, stale, stateTone, type StateTone } from "@dotfiles/opencode-subagents/line"
import { modelLabel } from "@dotfiles/opencode-subagents/model"
import { live, visible, type Row as SubagentRow, type Tone as RoleTone } from "@dotfiles/opencode-subagents/subagent-row"
import { Option } from "effect"
import { keyLabel } from "./pending.ts"
import { lastLine, shellState, shellTitle, type ShellEntry } from "./shells.ts"
import { lastOutput, repeat, type WakeEntry } from "./wakes.ts"

/** One row of a tab, its words before they are laid out. An empty string is a part the row has not. */
export type Line = {
  /** The leading diamond, a working row's spinner frame. */
  readonly glyph: string
  /** The colour the diamond and the state's word draw in. */
  readonly tone: StateTone
  /** A subagent's depth under the session's root: 0 for a child of it. */
  readonly depth: number
  /** A subagent's role (`implementor`), in its role's colour. */
  readonly role: string
  readonly roleTone: RoleTone
  /** A subagent's model with its version (`opus 5.5`), and without (`opus`). */
  readonly model: string
  readonly modelShort: string
  readonly name: string
  /** What it last said or did: a subagent's update, a shell's last output line. */
  readonly status: string
  /** The state in a word: `working`, `running`, `pending`. */
  readonly state: string
  /** How long it has been at it (`3h 40m`), or until it is due (`in 4m 12s`). */
  readonly time: string
  /** How long since it was last heard from: `updated 13m ago`, `checked 30s ago`. */
  readonly stale: string
}

/** What a stretch of a laid-out row is, for its colour. */
export type Kind = "lead" | "role" | "model" | "name" | "status" | "state" | "time" | "stale" | "faint"
export type Cell = { readonly text: string; readonly kind: Kind }

/** The widest a name column grows; a longer name is cut. */
export const NAME_MAX = 32
/** The least a name is cut to before the role drops. */
const NAME_MIN = 8
/** The least room what a row last did is shown in; with less it drops. */
const STATUS_MIN = 12
const GAP = "  "

const cells = (text: string) => Array.from(text).length
const widest = (texts: ReadonlyArray<string>) => Math.max(0, ...texts.map(cells))
const indent = (depth: number) => "  ".repeat(Math.max(0, depth))

/** The column widths every row of one tab shares. */
export type Widths = {
  readonly lead: number
  readonly role: number
  readonly model: number
  readonly modelShort: number
  readonly name: number
  readonly state: number
  readonly time: number
  readonly stale: number
}

export function widths(lines: ReadonlyArray<Line>): Widths {
  return {
    lead: widest(lines.map((line) => `${indent(line.depth)}${line.glyph} `)),
    role: widest(lines.map((line) => line.role)),
    model: widest(lines.map((line) => line.model)),
    modelShort: widest(lines.map((line) => line.modelShort)),
    name: Math.min(NAME_MAX, widest(lines.map((line) => line.name))),
    state: widest(lines.map((line) => line.state)),
    time: widest(lines.map((line) => line.time)),
    stale: widest(lines.map((line) => line.stale)),
  }
}

/** Which parts a tab's rows show at one width, and how wide the name is. */
type Plan = {
  readonly stale: boolean
  readonly version: boolean
  readonly model: boolean
  readonly state: boolean
  readonly status: boolean
  readonly role: boolean
  readonly name: number
}

const column = (shown: boolean, width: number) => Number(shown && width > 0) * (GAP.length + width)
const modelWidth = (plan: Plan, w: Widths) => Number(plan.model) * Math.max(Number(plan.version) * w.model, w.modelShort)
const who = (plan: Plan, w: Widths) => {
  const role = Number(plan.role) * w.role
  const model = modelWidth(plan, w)
  return role + model + Number(role > 0 && model > 0) + Number(role + model > 0) * GAP.length
}

/** The cells every part but what it last did takes. */
const fixed = (plan: Plan, w: Widths) =>
  w.lead + who(plan, w) + plan.name + column(plan.state, w.state) + column(true, w.time) + column(plan.stale, w.stale)

/** The parts that drop, in turn, while what a row last did has too little room. */
const DROPS: ReadonlyArray<(plan: Plan) => Plan> = [
  (plan) => ({ ...plan, stale: false }),
  (plan) => ({ ...plan, version: false }),
  (plan) => ({ ...plan, model: false }),
  (plan) => ({ ...plan, state: false }),
]

/** What a tab's rows show at `width`: as much as fits, dropping in the order the head comment gives. */
export function plan(w: Widths, width: number): Plan {
  const room = (each: Plan) => width - fixed(each, w) - GAP.length
  const full: Plan = { stale: true, version: true, model: true, state: true, status: true, role: true, name: w.name }
  let kept = full
  for (const drop of DROPS) if (room(kept) < STATUS_MIN) kept = drop(kept)
  if (room(kept) >= STATUS_MIN) return kept
  const bare: Plan = { ...kept, status: false }
  const nameRoom = (each: Plan) => width - (fixed(each, w) - each.name)
  const cut: Plan = { ...bare, name: Math.max(Math.min(w.name, NAME_MIN), Math.min(w.name, nameRoom(bare))) }
  if (fixed(cut, w) <= width) return cut
  const roleless: Plan = { ...cut, role: false }
  return { ...roleless, name: Math.max(0, Math.min(w.name, nameRoom(roleless))) }
}

/** `text` in exactly `width` cells: cut with an ellipsis, or padded at the end (`start` pads at the start). */
const pad = (text: string, width: number, start = false) => {
  const cut = fit(text, width)
  const fill = " ".repeat(Math.max(0, width - cells(cut)))
  if (start) return `${fill}${cut}`
  return `${cut}${fill}`
}

/** The cells of the parts before the name: the lead, then the role and the model. */
function head(line: Line, p: Plan, w: Widths): Cell[] {
  const lead = `${indent(line.depth)}${line.glyph}`
  const out: Cell[] = [
    { text: lead, kind: "lead" },
    { text: " ".repeat(Math.max(0, w.lead - cells(lead))), kind: "faint" },
  ]
  const role = Number(p.role) * w.role
  const model = modelWidth(p, w)
  if (role > 0) out.push({ text: pad(line.role, role), kind: "role" })
  if (role > 0 && model > 0) out.push({ text: " ", kind: "faint" })
  let label = line.modelShort
  if (p.version) label = line.model
  if (model > 0) out.push({ text: pad(label, model), kind: "model" })
  if (role + model > 0) out.push({ text: GAP, kind: "faint" })
  return out
}

/** One row laid out in its tab's columns in at most `width` cells; the line ends at its last word. */
export function layout(line: Line, w: Widths, width: number): Cell[] {
  const p = plan(w, width)
  const out = head(line, p, w)
  out.push({ text: pad(line.name, p.name), kind: "name" })
  const tail: Cell[] = []
  if (p.state && w.state > 0) tail.push({ text: GAP, kind: "faint" }, { text: pad(line.state, w.state), kind: "state" })
  if (w.time > 0) tail.push({ text: GAP, kind: "faint" }, { text: pad(line.time, w.time, true), kind: "time" })
  if (p.stale && w.stale > 0) tail.push({ text: GAP, kind: "faint" }, { text: pad(line.stale, w.stale), kind: "stale" })
  const used = [...out, ...tail].reduce((sum, cell) => sum + cells(cell.text), 0)
  if (p.status) out.push({ text: GAP, kind: "faint" }, { text: pad(line.status, width - used - GAP.length), kind: "status" })
  return trim(cut([...out, ...tail], width))
}

/** The cells up to `width`, nothing drawn after the cut. */
function cut<C extends { readonly text: string }>(all: ReadonlyArray<C>, width: number): C[] {
  const drawn: C[] = []
  let left = width
  for (const cell of all) {
    const text = fit(cell.text, left)
    if (text) drawn.push({ ...cell, text })
    if (text !== cell.text) break
    left -= cells(text)
  }
  return drawn
}

/** The cells without the blanks after the last word. */
function trim(all: ReadonlyArray<Cell>): Cell[] {
  const end = all.findLastIndex((cell) => cell.text.trim() !== "")
  const kept = all.slice(0, end + 1)
  const last = kept.at(-1)
  if (last) kept[kept.length - 1] = { ...last, text: last.text.trimEnd() }
  return kept
}

/** Whether two layouts draw the same: a row keeps its old cells, and draws nothing. */
export const sameCells = (a: ReadonlyArray<Cell>, b: ReadonlyArray<Cell>) =>
  a.length === b.length && a.every((cell, at) => cell.text === b[at]?.text && cell.kind === b[at]?.kind)

// ── The rows of each tab ──

const blank = { depth: 0, role: "", roleTone: "other", model: "", modelShort: "", status: "", state: "", time: "", stale: "" } satisfies Partial<Line>

/** A subagent's row at `now`, its diamond turning through `frame` while it works. */
export function subagentLine(row: SubagentRow, now: number, frame: string): Line {
  const shown = visible([row], now, { current: row.id })[0] ?? row
  const time = Option.fromNullishOr(shown.elapsed).pipe(
    Option.filter(() => live(shown.state)),
    Option.match({ onNone: () => "", onSome: duration }),
  )
  const ended = Option.fromNullishOr(shown.ended).pipe(
    Option.filter(() => !live(shown.state)),
    Option.match({ onNone: () => "", onSome: (at) => `ended ${duration(now - at)} ago` }),
  )
  return {
    glyph: glyph(shown.state, frame),
    tone: stateTone(shown.state),
    depth: shown.depth,
    role: shown.role,
    roleTone: shown.tone,
    model: modelLabel(shown.model),
    modelShort: modelLabel(shown.model, true),
    name: shown.unit,
    status: shown.update,
    state: shown.state,
    time,
    stale: stale(shown) ?? ended,
  }
}

/** A shell command's row: its description or command, its last output line, how long it has run. */
export function shellLine(shell: ShellEntry, now: number, output: string, frame: string): Line {
  let lead = glyph("done")
  let tone: StateTone = "muted"
  if (shell.status !== "exited" || shell.exit !== 0) tone = "error"
  if (shell.status === "running") {
    lead = frame
    tone = "success"
  }
  return {
    ...blank,
    glyph: lead,
    tone,
    name: shellTitle(shell),
    status: lastLine(output) ?? "no output yet",
    state: shellState(shell),
    time: duration((shell.time.completed ?? now) - shell.time.started),
  }
}

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? ""

/** An alarm's row: its note, its mode and repeat, and how long until it is due. */
export function alarmLine(entry: WakeEntry, now: number): Line {
  const alarm = { ...blank, glyph: "◇", name: firstLine(entry.note), status: `${entry.mode} · ${repeat(entry)}` }
  if (entry.dueAt <= now) return { ...alarm, tone: "warning", state: "due", time: "now" }
  return { ...alarm, tone: "info", state: "pending", time: `in ${duration(entry.dueAt - now)}` }
}

/** A monitor's row: its command, its newest output line, how long it has watched and when it last checked. */
export function monitorLine(entry: WakeEntry, now: number, frame: string): Line {
  return {
    ...blank,
    glyph: frame,
    tone: "info",
    name: firstLine(entry.command ?? ""),
    status: lastOutput(entry.last),
    state: "watching",
    time: Option.fromNullishOr(entry.setAt).pipe(Option.match({ onNone: () => "", onSome: (at) => duration(now - at) })),
    stale: Option.fromNullishOr(entry.last).pipe(
      Option.match({ onNone: () => "", onSome: (last) => `checked ${duration(now - last.at)} ago` }),
    ),
  }
}

/** A pending wake's row: an alarm's or a monitor's. */
export function wakeLine(entry: WakeEntry, now: number, frame: string): Line {
  if (entry.kind === "alarm") return alarmLine(entry, now)
  return monitorLine(entry, now, frame)
}

/** A terminal as the host's Terminals tab knows it (its persistent PTY record). */
export type Terminal = {
  readonly title: string
  readonly command: string
  readonly status: "running" | "exited"
  readonly exitCode?: number
  /** The process in front, while one other than its shell runs. */
  readonly foregroundProcess?: string
}

/**
 * A terminal's row: its title, what runs in it (the process in front, else its
 * command), and its state in the words a shell's row uses (`running`,
 * `exited 1`). No time: the PTY service keeps no start time for a terminal.
 */
export function terminalLine(terminal: Terminal): Line {
  const row: Line = { ...blank, glyph: "$", tone: "success", name: terminal.title, status: terminal.foregroundProcess || terminal.command, state: "running" }
  if (terminal.status === "running") return row
  const code = terminal.exitCode ?? "?"
  const exited: Line = { ...row, tone: "error", status: terminal.command, state: `exited ${code}` }
  if (code === 0) return { ...exited, tone: "muted" }
  return exited
}

/** A row the host words and the panel knows nothing more of: the Terminals tab's `+ New terminal`, a row whose subject is not read yet. */
export function labelLine(label: string): Line {
  return { ...blank, glyph: "$", tone: "muted", name: label }
}

// ── The tab bar and the footer ──

export type TabCell = { readonly text: string; readonly kind: "active" | "tab" | "count" | "faint"; readonly id: string }

const TAB_SEP = "  ·  "

const tabKind = (active: boolean): TabCell["kind"] => {
  if (active) return "active"
  return "tab"
}

/**
 * The tab bar in at most `width` cells: each tab's name, the active one
 * bright, with how many it lists beside it when that is known (`counts`),
 * between faint dots. Narrower, the counts drop, then the dots, then the bar
 * is cut.
 */
export function tabBar(
  tabs: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  active: string,
  counts: ReadonlyMap<string, number>,
  width: number,
): TabCell[] {
  const draw = (counted: boolean, sep: string) =>
    tabs.flatMap((tab, at): TabCell[] => {
      const count = counts.get(tab.id) ?? 0
      return [
        ...[{ text: sep, kind: "faint" as const, id: "" }].filter(() => at > 0),
        { text: tab.label, kind: tabKind(tab.id === active), id: tab.id },
        ...[{ text: ` ${count}`, kind: "count" as const, id: tab.id }].filter(() => counted && count > 0),
      ]
    })
  const size = (all: ReadonlyArray<TabCell>) => all.reduce((sum, cell) => sum + cells(cell.text), 0)
  const fits = [draw(true, TAB_SEP), draw(false, TAB_SEP)].find((all) => size(all) <= width)
  return fits ?? cut(draw(false, GAP), width)
}

export type HintCell = { readonly text: string; readonly kind: "key" | "label" | "faint" }

/** The footer, as Prime's hint line words a key: `Ctrl+D interrupt · Ctrl+A show inactive · ←/→ tabs`. */
export function footer(hints: ReadonlyArray<{ readonly label: string; readonly shortcut: string }>, tabs: number): HintCell[] {
  const all = [
    ...hints.flatMap((hint) => [{ key: keyLabel(hint.shortcut), label: hint.label }].filter(() => hint.shortcut !== "")),
    ...[{ key: "←/→", label: "tabs" }].filter(() => tabs > 1),
  ]
  return all.flatMap((hint, at): HintCell[] => [
    ...[{ text: " · ", kind: "faint" as const }].filter(() => at > 0),
    { text: hint.key, kind: "key" },
    { text: ` ${hint.label}`, kind: "label" },
  ])
}
