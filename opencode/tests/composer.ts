// Where the composer sits in a Prime frame's rows, for tests that split a
// frame into the transcript above it and the composer itself. The composer is
// the last run of rail rows (` ┃`) above the dock's rule; the row right above
// it is Prime's hint line (navigation hints on the left, the update notice on
// the right, often empty), which no longer carries a standing text to find it
// by. A goal line, or a subagent's family rows, would sit between the two.

const RAIL = /^ ┃/
const RULE = /^ ─{10,}\s*$/

/** The index of the composer's first row, or -1 when the frame shows none. */
export function composerRow(lines: ReadonlyArray<string>): number {
  const rule = lines.findLastIndex((line) => RULE.test(line))
  const last = lines.findLastIndex((line, index) => (rule < 0 || index < rule) && RAIL.test(line))
  if (last < 0) return -1
  let first = last
  while (first > 0 && RAIL.test(lines[first - 1]!)) first--
  return first
}

/** The index of the row right above the composer (Prime's hint line), or -1 when the frame shows no composer. */
export function hintRow(lines: ReadonlyArray<string>): number {
  const row = composerRow(lines)
  return row < 0 ? -1 : row - 1
}
