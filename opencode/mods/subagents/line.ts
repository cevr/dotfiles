// A subagent row drawn as one line: segments of text, each with the kind
// that picks its colour, never wider than the room it is given.
import type { Row, State } from "./subagent-row.ts"

/** What a stretch of a drawn row is, for its colour. */
export type Kind = "mark" | "lead" | "role" | "unit" | "spinner" | "update" | "faint"
export type Segment = { readonly text: string; readonly kind: Kind }

/** The glyph a row leads with, by state. */
export function glyph(state: State): string {
  if (state === "done") return "✓"
  if (state === "failed") return "✗"
  if (state === "cancelled" || state === "blocked") return "!"
  if (state === "idle") return "○"
  return "◆"
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

/** The spinner frame at `ms`: one frame each 100 ms. */
export function spinner(ms: number): string {
  return Array.from(SPINNER)[Math.floor(Math.max(0, ms) / 100) % 10] ?? ""
}

/** Whole seconds under a minute, then `1m 05s`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
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

/** The column widths the rows of one list share, so roles and units line up. */
export type Columns = { readonly role: number; readonly unit: number }

export function columns(rows: ReadonlyArray<Row>): Columns {
  return {
    role: Math.max(0, ...rows.map((row) => columnsOf(row.role))),
    unit: Math.min(UNIT_MAX, Math.max(0, ...rows.map((row) => columnsOf(row.unit)))),
  }
}

export type FormatOptions = {
  /** The list's shared columns; the row's own widths when left out. */
  readonly columns?: Columns
  /** The spinner frame a running row shows; by default the frame at the row's `elapsed`. */
  readonly spinner?: string
  /**
   * A list that marks one row (the session the TUI shows) leads every row
   * with a mark column: `marked` for that row, `unmarked` for the rest.
   */
  readonly mark?: "marked" | "unmarked"
}

/**
 * One row as one line of at most `width` columns: the state glyph, the role,
 * the unit, then the update (behind a spinner frame while it runs) and how
 * long it has run. The update gives way first; past that the line is cut
 * where the width ends.
 */
export function format(row: Row, width: number, options: FormatOptions = {}): Segment[] {
  const cols = options.columns ?? columns([row])
  const segments: Segment[] = []
  if (options.mark) segments.push({ text: options.mark === "marked" ? "› " : "  ", kind: "mark" })
  if (row.depth > 0) segments.push({ text: `${"  ".repeat(row.depth - 1)}↳ `, kind: "faint" })
  segments.push({ text: `${glyph(row.state)} `, kind: "lead" })
  segments.push({ text: row.role.padEnd(cols.role), kind: "role" })
  segments.push({ text: "  ", kind: "faint" })
  segments.push({ text: fit(row.unit, cols.unit).padEnd(cols.unit), kind: "unit" })
  segments.push({ text: "  ", kind: "faint" })
  const time = row.elapsed === undefined ? "" : ` · ${elapsed(row.elapsed)}`
  const spin = row.state === "running" ? `${options.spinner ?? spinner(row.elapsed ?? 0)} ` : ""
  const used = segments.reduce((sum, segment) => sum + columnsOf(segment.text), 0)
  const update = fit(row.update, width - used - columnsOf(spin) - columnsOf(time))
  if (update) {
    if (spin) segments.push({ text: spin, kind: "spinner" })
    segments.push({ text: update, kind: "update" })
    if (time) segments.push({ text: time, kind: "faint" })
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
  return drawn
}
