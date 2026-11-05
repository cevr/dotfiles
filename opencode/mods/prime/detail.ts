// How much of each tool call the transcript shows, and the blank rows
// between transcript rows at each level. Ctrl+O cycles the level.

/** How much of each tool call the transcript shows; Ctrl+O cycles it. */
export type Detail = "overview" | "details" | "all"

export const details: readonly Detail[] = ["overview", "details", "all"]

export function nextDetail(current: Detail): Detail {
  return details[(details.indexOf(current) + 1) % details.length] ?? "overview"
}

export function detailHint(detail: Detail) {
  if (detail === "overview") return "Collapsed mode (Ctrl+O to expand)"
  if (detail === "details") return "Details mode (Ctrl+O to expand)"
  return "Expanded mode (Ctrl+O to collapse)"
}

/** The kinds of transcript row the host lays out (the fork's `TranscriptRowKind`). */
export type RowKind = "user" | "text" | "reasoning" | "tool" | "group" | "footer" | "notice" | "other"

// Blank rows between transcript rows. Overview packs everything; Details
// and All keep a blank line around prose but stack calls tight: the host gives
// each call its own row, so a group's header adds the blank row between two
// steps' groups (tui/tools.tsx).
export function rowGap(detail: Detail, row: { readonly kind: RowKind; readonly previous?: RowKind | undefined }) {
  if (detail === "overview") return 0
  if (row.kind === "footer") return 0
  const call = (kind?: RowKind) => kind === "tool" || kind === "group"
  if (call(row.kind) && call(row.previous)) return 0
  // Notices stack like calls; a folded notice draws nothing, so it must add no gap either.
  if (row.kind === "notice" && row.previous === "notice") return 0
  // A turn that opens with a thought opens with the host's reasoning group,
  // which draws nothing below All: there it takes no gap, so the row after it
  // keeps the prompt's one blank row and no second one.
  if (row.kind === "group" && row.previous === "user") return detail === "all" ? 1 : 0
  // Below All a thought draws nothing (tui/transcript.tsx), so it takes no gap, and
  // a call after it stacks on the run it belongs to.
  if (detail !== "all" && row.kind === "reasoning") return 0
  if (detail !== "all" && row.previous === "reasoning" && call(row.kind)) return 0
  return 1
}
