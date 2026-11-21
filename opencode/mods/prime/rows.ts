// The live rows beneath the composer, without rendering: how many of the
// subagent rows (`@dotfiles/opencode-subagents`) the dock draws, which of them
// the wheel has scrolled into view, the line that says where they are, and on
// which terminals it draws none.

/** The most rows drawn at once; the wheel scrolls the rest through them. */
export const CAP = 6

/** The rows in view: `cap` of them from `offset`, in order, and how many lie above and below. */
export interface Window<T> {
  readonly rows: T[]
  /** The offset the window shows, clamped: an offset past the end (rows left while scrolled) keeps the window full. */
  readonly offset: number
  readonly above: number
  readonly below: number
  readonly total: number
}

/** The offset clamped to the rows: from 0 to the last full window. */
const clamp = (offset: number, total: number, cap: number) => Math.min(Math.max(0, offset), Math.max(0, total - cap))

/** The `cap` rows from `offset` (clamped), in order. */
export function windowed<T>(rows: ReadonlyArray<T>, offset: number, cap = CAP): Window<T> {
  const total = rows.length
  const at = clamp(offset, total, cap)
  const shown = rows.slice(at, at + cap)
  return { rows: shown, offset: at, above: at, below: total - at - shown.length, total }
}

/** The offset after one wheel step `direction` from `offset`: a row up or down, stopping at either end; sideways leaves it. */
export function scrolled(offset: number, direction: string, total: number, cap = CAP): number {
  const step = direction === "down" ? 1 : direction === "up" ? -1 : 0
  return clamp(clamp(offset, total, cap) + step, total, cap)
}

/**
 * The line under the rows. At the top it counts the rest, as it always did;
 * scrolled, it says which rows show and how many lie above and below. From the
 * parent it ends with the way to see them all.
 */
export function countLine(window: Window<unknown>, child: boolean): string {
  if (window.above + window.below === 0) return ""
  const tail = child ? "" : " · ↓ to see all"
  if (window.above === 0) return `+${window.below} more${tail}`
  const range = `${window.offset + 1}–${window.offset + window.rows.length} of ${window.total}`
  const around = window.below > 0 ? `${window.above} above, ${window.below} below` : `${window.above} above`
  return `${range} · ${around}${tail}`
}

/**
 * A terminal narrower than this draws no rows. A portrait phone measures
 * about 40 to 55 columns, where each row would truncate to its role and unit.
 */
export const COMPACT_WIDTH = 60
/**
 * A terminal shorter than this draws no rows. A phone with its keyboard up, or
 * turned on its side, measures about 20 to 28 rows, where up to seven rows of
 * subagents would take a quarter of the screen from the transcript. A split
 * pane on the Mac measures 35 rows and keeps them.
 */
export const COMPACT_HEIGHT = 30

/**
 * Whether a terminal this size is too small for the rows: the count line
 * above them stays, and Down or a click on it lists every subagent.
 */
export function compact(size: { readonly width: number; readonly height: number }): boolean {
  return size.width < COMPACT_WIDTH || size.height < COMPACT_HEIGHT
}
