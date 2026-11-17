// The live rows beneath the composer, without rendering: how many of the
// subagent rows (`@dotfiles/opencode-subagents`) the dock draws, and the line
// that counts the rest, and on which terminals it draws none.

/** The most rows drawn; the rest are counted. */
export const CAP = 6

/** The first `cap` rows, in order, and how many more there are. */
export function capped<T>(rows: ReadonlyArray<T>, cap = CAP): { readonly rows: T[]; readonly more: number } {
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) }
}

/** The line under the rows that counts the rest: where to see them all, when there is a way. */
export function moreLine(more: number, child: boolean): string {
  if (more <= 0) return ""
  return child ? `+${more} more` : `+${more} more · ↓ to see all`
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
