// The live state of each subagent of a root session, by session id, as the
// board takes it, from the shared subagent rows (@dotfiles/opencode-subagents):
// `read` gives the family from the TUI's data, `subagents` its rows. Every row
// is kept, not only the ones the shared list would still show, because a queue
// item linked to a subagent keeps its state long after the shared list's
// linger. Read inside a Solid computation, every read here is reactive.
import type { Family } from "@dotfiles/opencode-subagents/family"
import { read, type Reads } from "@dotfiles/opencode-subagents/opencode/view"
import type { FamilyReader } from "@dotfiles/opencode-subagents/solid/reader"
import { subagents as rowsOf, type Row } from "@dotfiles/opencode-subagents/subagent-row"
import { worksNow, type Works } from "@dotfiles/opencode-subagents/works"
import { Option } from "effect"
import type { Live } from "../board.ts"

export type { Reads }

/** A shared row's state as the board's: a cancelled one failed; one whose end is unknown is done. */
const liveOf = (row: Row, work: Option.Option<Works>): Option.Option<Live> => {
  const since = row.ended === undefined ? {} : { since: row.ended }
  switch (row.state) {
    case "working":
      return Option.as(work, { state: "running" })
    case "waiting":
    case "latched":
      return Option.as(work, { state: "waiting" })
    case "blocked":
      return Option.as(work, { state: "blocked" })
    case "failed":
    case "cancelled":
      return Option.some({ state: "failed", ...since })
    case "done":
    case "idle":
      return Option.some({ state: "done", ...since })
    case "unknown":
      return Option.none()
  }
  return row.state satisfies never
}

/** The live state of every subagent of `family` under its root, by session id. */
export const fromFamily = (family: Family): ReadonlyMap<string, Live> => {
  const work = worksNow(family)
  const live = new Map<string, Live>()
  for (const row of rowsOf(family, family.root)) {
    const next = liveOf(row, Option.fromUndefinedOr(work(row.id)))
    if (Option.isSome(next)) live.set(row.id, next.value)
  }
  return live
}

/**
 * The live state of every subagent under `root`, read from the TUI's data
 * through `family` (a TUI passes its `familyReader()`), its running shells
 * from `location`'s registry.
 */
export const liveStates = <Location>(
  reads: Reads<Location>,
  root: string,
  location?: Location,
  family: FamilyReader = read,
): ReadonlyMap<string, Live> => fromFamily(family(reads, root, location))
