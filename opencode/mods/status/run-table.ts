// The table the orchestrate skill's status script prints for a run: a
// Markdown table whose rows are `| unit | state | round | since | cause | verdict |`.
// Only the script derives a unit's state (from its files and git); a state
// column someone keeps by hand in plan.md is never read.
import { Array as Arr, Option } from "effect"
import type { Unit } from "./status.ts"

/** One orchestrate run's directory name, its path when known, and the table the status script printed for it. */
export interface RunTable {
  readonly name: string
  readonly dir?: string
  readonly table: string
}

const cellsOf = (line: string) => line.split("|").map((part) => part.trim())

/**
 * The units a table lists, skipping its header, its rule and any row with no unit or state. The verdict is the
 * column its header names `Verdict`, when it has one: an older table's other columns are never read as one.
 */
export const unitsOf = (table: string): ReadonlyArray<Unit> => {
  const lines = table.split("\n")
  const at = Option.filter(
    Option.flatMap(Arr.findFirst(lines.map(cellsOf), (cells) => cells[1] === "Unit"), (header) => Arr.findFirstIndex(header, (cell) => cell === "Verdict")),
    (index) => index > 0,
  )
  return lines.flatMap((line) => {
    const cells = cellsOf(line)
    const [, unit, state, round, since] = cells
    if (!unit || unit === "Unit" || unit.startsWith("-") || !state) return []
    const row: Unit = { unit, state, round: round ?? "", since: since ?? "" }
    const verdict = Option.filter(Option.flatMap(at, (index) => Arr.get(cells, index)), (cell) => cell !== "")
    return [Option.match(verdict, { onNone: () => row, onSome: (cell) => ({ ...row, verdict: cell }) })]
  })
}
