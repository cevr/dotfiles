// The runs held in memory: each repository directory's tables, or the reason
// they cannot be read, read again on every call. The plugin's seam tests
// change them.
import { Effect, Layer, Option } from "effect"
import type { RunTable } from "../run-table.ts"
import { RunTables, RunsUnreadable } from "../service.ts"

/**
 * Each repository directory's tables (a directory absent here is outside any
 * repository), why they cannot be listed (`failure`), and why one run cannot
 * be read, by its name (`broken`).
 */
export interface MemoryRuns {
  readonly tables: Map<string, ReadonlyArray<RunTable>>
  failure?: string
  readonly broken?: Map<string, string>
}

export const layer = (runs: MemoryRuns) =>
  Layer.succeed(RunTables, {
    list: (directory: string) =>
      Effect.suspend(() => {
        if (runs.failure !== undefined) return Effect.fail(new RunsUnreadable({ message: runs.failure }))
        const all = Option.getOrElse(Option.fromUndefinedOr(runs.tables.get(directory)), () => [])
        const why = (run: RunTable) => Option.flatMap(Option.fromUndefinedOr(runs.broken), (broken) => Option.fromUndefinedOr(broken.get(run.name)))
        return Effect.succeed({
          runs: all.filter((run) => Option.isNone(why(run))),
          unreadable: all.flatMap((run) => Option.toArray(Option.map(why(run), (message) => new RunsUnreadable({ message })))),
        })
      }),
  })
