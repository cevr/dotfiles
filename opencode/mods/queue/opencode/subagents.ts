// The live state of each subagent of a root session, by session id, as the
// board takes it, from the shared subagent rows (@dotfiles/opencode-subagents):
// `read` gives the family from the TUI's data, `subagents` its rows. Every row
// is kept, not only the ones the shared list would still show, because a queue
// item linked to a subagent keeps its state long after the shared list's
// linger. Read inside a Solid computation, every read here is reactive.
import type { Family } from "@dotfiles/opencode-subagents/family"
import { read, type Reads } from "@dotfiles/opencode-subagents/opencode/view"
import { subagents as rowsOf, type Row } from "@dotfiles/opencode-subagents/subagent-row"
import type { Live } from "../board.ts"

export type { Reads }

/** A shared row's state as the board's: a cancelled one failed; one whose end is unknown is done. */
const liveOf = (row: Row): Live => {
  const since = row.ended === undefined ? {} : { since: row.ended }
  switch (row.state) {
    case "working":
      return { state: "running" }
    case "waiting":
    case "latched":
      return { state: "waiting" }
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

/** The live state of every subagent of `family` under its root, by session id. */
export const fromFamily = (family: Family): ReadonlyMap<string, Live> => new Map(rowsOf(family, family.root).map((row) => [row.id, liveOf(row)]))

/** The live state of every subagent under `root`, read from the TUI's data. */
export const liveStates = (reads: Reads, root: string): ReadonlyMap<string, Live> => fromFamily(read(reads, root))
