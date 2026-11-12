// A subagent row drawn as one line: segments of text, each with the kind
// that picks its colour, never wider than the room it is given.
//
//   ◆ worker opus 5.5  Fix money parsing  running bun test … · 12s
//   ◈ worker sol 6.1   closure-flake      flock gate.lock ./gate.sh · 37m · updated 26m ago
//   ◆ planner opus 5.5 Plan month padding  3 steps
//   ◇ verifier sol 6.1 Check the export    pace · opens 14:30 · 2m 10s
//
// No word names the state: the leading diamond does, by its fill and colour
// (`SYMBOLS`, `stateTone`). A working row's diamond turns (`spinner`). After the role comes the model
// by its short name (model.ts), then the unit, then what the row last said or
// did, how long it has been in its state and, when its last update is a
// while back and that time does not already say so, how long ago. As the
// width shrinks the parts drop from the right: the last update's age, then
// the model's version, then the update (cut, then dropped), then the cut
// falls where the width ends.
import { modelLabel } from "./model.ts"
import { live, type Row, type State } from "./subagent-row.ts"

/**
 * What a stretch of a drawn row is, for its colour. `lead` is the state's
 * diamond, `time` a live row's time in its state, `stale` its last update's age.
 */
export type Kind = "mark" | "lead" | "role" | "model" | "unit" | "update" | "time" | "stale" | "faint"
export type Segment = { readonly text: string; readonly kind: Kind }

/** Whether two drawings of a row are the same segments: a view keeps the old ones, and draws nothing. */
export const sameSegments = (a: ReadonlyArray<Segment>, b: ReadonlyArray<Segment>): boolean =>
  a.length === b.length && a.every((segment, index) => segment.text === b[index]?.text && segment.kind === b[index]?.kind)

/**
 * The frames a working row's diamond turns through, one each `SPIN_MS`: full,
 * then empty, a slow pulse. Each is one cell, from the Geometric Shapes block.
 */
export const SPINNER = "◆◇"

/**
 * How long each spinner frame holds: a 2 s pulse. A second, the unit a row's
 * time shows, so a row's diamond and time turn on the same tick, once a second.
 */
export const SPIN_MS = 1000

/**
 * The diamond each state leads with when it stands still, one cell wide,
 * from the Geometric Shapes block (never ⬖⬗⬘⬙ or ❖, which some fonts draw
 * wide or as emoji). Glyphs repeat across states; the colour (`stateTone`)
 * tells them apart: a working row turns through `SPINNER`.
 */
export const SYMBOLS: Readonly<Record<State, string>> = {
  working: "◈",
  waiting: "◈",
  blocked: "◆",
  latched: "◇",
  idle: "◇",
  cancelled: "◇",
  done: "◆",
  failed: "◆",
}

/** The colour a state's diamond draws in, from the theme's feedback colours. */
export type StateTone = "success" | "warning" | "error" | "info" | "muted"

/**
 * Working is the success colour; waiting, blocked and cancelled the warning
 * colour; failed the error colour; latched the info colour; idle and done
 * muted. Each glyph and colour pair names one state.
 */
export function stateTone(state: State): StateTone {
  if (state === "working") return "success"
  if (state === "latched") return "info"
  if (state === "failed") return "error"
  if (state === "waiting" || state === "blocked" || state === "cancelled") return "warning"
  return "muted"
}

/** The diamond a row leads with: its state's, or for a working row `frame` when given. */
export function glyph(state: State, frame?: string): string {
  return state === "working" && frame ? frame : SYMBOLS[state]
}

/** A live row's last update is stale this long after it, and named then. */
export const STALE_MS = 5 * 60_000

/** The spinner frame at `ms`: one frame each `SPIN_MS`. */
export function spinner(ms: number): string {
  return Array.from(SPINNER)[Math.floor(Math.max(0, ms) / SPIN_MS) % SPINNER.length] ?? ""
}

/** A span of time, as precise as it is worth: `12s`, `1m 05s` under ten minutes, `37m` under an hour, then `1h 08m`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/**
 * The age of a live row's last update, when it is worth saying: at least
 * `STALE_MS`, and not within a minute of the row's time in its state, which
 * already says it.
 */
export function stale(row: Row): string | undefined {
  if (!live(row.state) || row.quiet === undefined || row.quiet < STALE_MS) return undefined
  if (row.elapsed !== undefined && Math.abs(row.elapsed - row.quiet) < 60_000) return undefined
  return `updated ${duration(row.quiet)} ago`
}

const columnsOf = (text: string) => Array.from(text).length

/** `text` cut to `max` columns, an ellipsis standing for the rest. */
export function fit(text: string, max: number): string {
  if (max <= 0) return ""
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (!text.trim()) return chars.slice(0, max).join("")
  return max === 1 ? "…" : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}

/** The widest unit a list gives room to; a longer one is cut. */
export const UNIT_MAX = 28

/**
 * The column widths the rows of one list share, so roles, models and units
 * line up: the model with its version (`model`) and without (`name`).
 */
export type Columns = { readonly role: number; readonly model: number; readonly name: number; readonly unit: number }

export function columns(rows: ReadonlyArray<Row>): Columns {
  const widest = (texts: ReadonlyArray<string>) => Math.max(0, ...texts.map(columnsOf))
  return {
    role: widest(rows.map((row) => row.role)),
    model: widest(rows.map((row) => modelLabel(row.model))),
    name: widest(rows.map((row) => modelLabel(row.model, true))),
    unit: Math.min(UNIT_MAX, widest(rows.map((row) => row.unit))),
  }
}

export type FormatOptions = {
  /** The list's shared columns; the row's own widths when left out. */
  readonly columns?: Columns
  /** The spinner frame a working row shows; by default the frame at the row's `elapsed`. */
  readonly spinner?: string
  /**
   * A list that marks one row (the session the TUI shows) leads every row
   * with a mark column: `marked` for that row, `unmarked` for the rest.
   */
  readonly mark?: "marked" | "unmarked"
}

/** The least room an update is shown in; with less it drops. */
const UPDATE_MIN = 8
/** The least room an update keeps beside the update's age; with less the age drops first. */
const UPDATE_BESIDE_AGE = 24
/** The least room the parts after the unit keep before the model's version drops. */
const AFTER_UNIT_MIN = 20
const SEP = " · "

/**
 * One row as one line of at most `width` columns: the state's diamond (a
 * spinner frame while it works), the role, the model, the unit, then what it
 * last said or did, for a live row how long it has been in its state and,
 * when stale, how long since its last update. Parts drop from the right as
 * the width shrinks; past that the line is cut where the width ends.
 */
export function format(row: Row, width: number, options: FormatOptions = {}): Segment[] {
  const cols = options.columns ?? columns([row])
  const lead: Segment[] = []
  if (options.mark) lead.push({ text: options.mark === "marked" ? "› " : "  ", kind: "mark" })
  if (row.depth > 0) lead.push({ text: `${"  ".repeat(row.depth - 1)}↳ `, kind: "faint" })
  lead.push({ text: `${glyph(row.state, options.spinner ?? spinner(row.elapsed ?? 0))} `, kind: "lead" })
  const before = lead.reduce((sum, segment) => sum + columnsOf(segment.text), 0)
  // The version drops, for every row of the list alike, once it would squeeze the parts after the unit.
  const head = (model: number) => before + cols.role + (model > 0 ? 1 + model : 0) + 2 + cols.unit + 2
  const versioned = width - head(cols.model) >= AFTER_UNIT_MIN
  const modelWidth = versioned ? cols.model : cols.name
  const segments: Segment[] = [...lead, { text: row.role.padEnd(cols.role), kind: "role" }]
  if (modelWidth > 0) {
    segments.push({ text: " ", kind: "faint" })
    segments.push({ text: modelLabel(row.model, !versioned).padEnd(modelWidth), kind: "model" })
  }
  segments.push({ text: "  ", kind: "faint" })
  segments.push({ text: fit(row.unit, cols.unit).padEnd(cols.unit), kind: "unit" })
  segments.push({ text: "  ", kind: "faint" })
  const room = width - head(modelWidth)
  const time = live(row.state) && row.elapsed !== undefined ? duration(row.elapsed) : undefined
  const age = stale(row)
  const timeTail = time === undefined ? 0 : columnsOf(SEP) + columnsOf(time)
  const ageTail = age === undefined ? 0 : columnsOf(SEP) + columnsOf(age)
  const update = row.update
  let shown = false
  let keepAge = false
  if (update) {
    keepAge = age !== undefined && room - timeTail - ageTail >= Math.min(UPDATE_BESIDE_AGE, columnsOf(update))
    const space = room - timeTail - (keepAge ? ageTail : 0)
    if (space >= Math.min(UPDATE_MIN, columnsOf(update))) {
      segments.push({ text: fit(update, space), kind: "update" })
      shown = true
    } else keepAge = false
  } else keepAge = age !== undefined && room - timeTail - ageTail >= 0
  if (time !== undefined) {
    if (shown) segments.push({ text: SEP, kind: "faint" })
    segments.push({ text: time, kind: "time" })
  }
  if (keepAge && age !== undefined) {
    if (shown || time !== undefined) segments.push({ text: SEP, kind: "faint" })
    segments.push({ text: age, kind: "stale" })
  }
  // Even the fixed columns may not fit: cut the line where the width ends, and draw nothing after the cut.
  const drawn: Segment[] = []
  let left = width
  for (const segment of segments) {
    const text = fit(segment.text, left)
    if (text) drawn.push({ ...segment, text })
    if (text !== segment.text) break
    left -= columnsOf(text)
  }
  // A line that ends in padding (a stopped row with nothing more to say) ends at its last word.
  const last = drawn.at(-1)
  if (last && !last.text.trim()) drawn.pop()
  const end = drawn.at(-1)
  if (end && end.text !== end.text.trimEnd()) drawn[drawn.length - 1] = { ...end, text: end.text.trimEnd() }
  return drawn
}
