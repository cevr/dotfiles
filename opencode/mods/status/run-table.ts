// The table the orchestrate skill's status script prints for a run: a
// Markdown table whose rows are `| unit | state | round | since | cause |
// cadence |`. Only the script derives a unit's state (from its log.md
// transitions) and its batch cadence (from its spec.md and the plan.md); a
// state column someone keeps by hand in plan.md is never read.
import type { Unit } from "./status.ts"

/** One orchestrate run's directory name, its path when known, and the table the status script printed for it. */
export interface RunTable {
  readonly name: string
  readonly dir?: string
  readonly table: string
}

/** The units a table lists, skipping its header, its rule and any row with no unit or state. A table with no cadence gives none. */
export const unitsOf = (table: string): ReadonlyArray<Unit> =>
  table.split("\n").flatMap((line) => {
    const [, unit, state, round, since, , cadence] = line.split("|").map((part) => part.trim())
    if (!unit || unit === "Unit" || unit.startsWith("-") || !state) return []
    const row = { unit, state, round: round ?? "", since: since ?? "" }
    return [cadence ? { ...row, cadence } : row]
  })

/**
 * The run's drift from the batch machine, as the status script prints it under the table
 * (`Drift: 35 after batch-n accepted (2026-11-12T03:40Z): 1 unfolded land ×6, …`): the text after
 * `Drift: `. None when the run has no drift line yet.
 */
export const driftOf = (table: string): string | undefined =>
  table
    .split("\n")
    .flatMap((line) => (line.startsWith("Drift: ") ? [line.slice("Drift: ".length).trim()] : []))
    .at(-1)
