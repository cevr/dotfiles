// The subagents of a root session, as the board takes them, from the shared
// subagent rows (@dotfiles/opencode-subagents): `read` gives the family from
// the TUI's data, `subagents` its rows (role, unit, state, one-sentence
// update), `visible` how long each running one has taken. Every row is kept,
// not only the ones the shared list would still show, because a queue item
// linked to a subagent keeps its state long after the shared list's linger.
// Read inside a Solid computation, every read here is reactive.
import type { Family } from "@dotfiles/opencode-subagents/family"
import { read, type Reads } from "@dotfiles/opencode-subagents/opencode/view"
import { subagents as rowsOf, visible, type Row } from "@dotfiles/opencode-subagents/subagent-row"
import type { Live, Subagent } from "../board.ts"

export type { Reads }

/** A shared row's state as the board's: a cancelled one failed; one whose end is unknown is done. */
const liveOf = (row: Row): Live => {
  const since = row.ended === undefined ? {} : { since: row.ended }
  switch (row.state) {
    case "running":
      return { state: "running" }
    case "blocked":
      return { state: "blocked" }
    case "failed":
    case "cancelled":
      return { state: "failed", ...since }
    case "done":
    case "idle":
      return { state: "done", ...since }
  }
}

/** Every subagent of `family` under its root at `now`, as the board takes them. */
export const fromFamily = (family: Family, now: number): ReadonlyArray<Subagent> => {
  const all = rowsOf(family, family.root)
  const timed = new Map(visible(all, now, { linger: Infinity }).map((row) => [row.id, row.elapsed]))
  return all.map((row) => {
    const elapsed = timed.get(row.id)
    return {
      session: row.id,
      description: row.unit,
      live: liveOf(row),
      role: row.role,
      update: row.update,
      ...(elapsed === undefined ? {} : { elapsed }),
    }
  })
}

/** Every subagent under `root`, read from the TUI's data. */
export const subagents = (reads: Reads, root: string, now: number): ReadonlyArray<Subagent> => fromFamily(read(reads, root), now)
