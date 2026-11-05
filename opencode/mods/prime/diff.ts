// An edit's diff as Prime's bands read it, without rendering: the rows of a
// unified diff, numbered, with gaps between hunks.

export type DiffRow = { kind: "context" | "added" | "removed"; line: number; text: string } | { kind: "gap" }

/**
 * Unified-diff rows numbered the way Prime numbers them: a removed row by
 * its old line, every other row by its new line. `context` is how many
 * unchanged rows to keep around each change; Infinity keeps the whole hunk.
 */
export function diffRows(patch: string, context: number): DiffRow[] {
  const hunks: DiffRow[][] = []
  let oldLine = 0
  let newLine = 0
  let current: DiffRow[] | undefined
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current || raw.startsWith("\\")) continue
    if (raw.startsWith("-") && !raw.startsWith("---"))
      current.push({ kind: "removed", line: oldLine++, text: raw.slice(1) })
    else if (raw.startsWith("+") && !raw.startsWith("+++"))
      current.push({ kind: "added", line: newLine++, text: raw.slice(1) })
    else if (raw.startsWith(" ") || raw === "") {
      current.push({ kind: "context", line: newLine, text: raw.slice(1) })
      oldLine++
      newLine++
    }
  }
  const blank = (row: DiffRow | undefined) => row?.kind === "context" && row.text === ""
  const trimmed = hunks.map((rows) => {
    // Drop the trailing empty context row a final newline leaves behind.
    while (blank(rows.at(-1))) rows.pop()
    if (context === Infinity) return rows
    const changed = rows.flatMap((row, index) => (row.kind === "context" ? [] : [index]))
    return rows.filter((_, index) => changed.some((at) => Math.abs(at - index) <= context))
  })
  const gap: DiffRow = { kind: "gap" }
  return trimmed.flatMap((rows, index) => (index === 0 ? rows : [gap, ...rows]))
}

/** The columns a band's line numbers take: the widest number, at least two. */
export function numberWidth(rows: ReadonlyArray<DiffRow>) {
  return Math.max(2, ...rows.map((row) => (row.kind === "gap" ? 0 : String(row.line).length)))
}

/** The sign a band's row shows after its number. */
export function diffSign(kind: "context" | "added" | "removed") {
  return kind === "added" ? "+" : kind === "removed" ? "-" : " "
}
