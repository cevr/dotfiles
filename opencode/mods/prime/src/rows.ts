// The live rows beneath the composer, without rendering: how many of the
// subagent rows (`@dotfiles/opencode-subagents`) the dock draws, and the line
// that counts the rest.

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
