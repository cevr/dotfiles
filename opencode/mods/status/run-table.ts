// The table the orchestrate skill's status script prints for a run: a
// Markdown table whose rows are `| unit | state | round | since |`. Only the
// script derives a unit's state (from its log.md transitions); a state column
// someone keeps by hand in plan.md is never read.
import type { Unit } from "./status.ts"

/** One orchestrate run's directory name and the table the status script printed for it. */
export interface RunTable {
  readonly name: string
  readonly table: string
}

/** The units a table lists, skipping its header, its rule and any row with no unit or state. */
export const unitsOf = (table: string): ReadonlyArray<Unit> =>
  table.split("\n").flatMap((line) => {
    const [, unit, state, round, since] = line.split("|").map((part) => part.trim())
    if (!unit || unit === "Unit" || unit.startsWith("-") || !state) return []
    return [{ unit, state, round: round ?? "", since: since ?? "" }]
  })
