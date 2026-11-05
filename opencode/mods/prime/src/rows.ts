// The live rows beneath the composer, without rendering: how many of the
// subagent rows (`@dotfiles/opencode-subagents`) the dock draws, the line
// that counts the rest, and whether the sidebar shows instead.

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

/** The part of a plugin's `ui` that says whether a session's sidebar shows; a host without it leaves `sidebar` out. */
interface SidebarHost {
  readonly sidebar?: { visible(sessionID: string): boolean }
}

/**
 * Whether the host shows `sessionID`'s sidebar now, through the fork's
 * `ui.sidebar.visible`. A host without it never says so, and the rows always
 * show. `ui` is a plugin's `context.ui`, taken as any object so this compiles
 * against a host whose `UI` has no `sidebar` at all.
 */
export function sidebarShown(ui: object, sessionID: string): boolean {
  const host: SidebarHost = ui
  return host.sidebar?.visible(sessionID) ?? false
}
