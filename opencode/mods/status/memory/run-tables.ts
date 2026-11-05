// The runs held in memory: each repository directory's tables, or the reason
// they cannot be read, read again on every call. The plugin's seam tests
// change them.
import { Effect, Layer } from "effect"
import type { RunTable } from "../run-table.ts"
import { RunTables, RunsUnreadable } from "../service.ts"

/** Each repository directory's tables (a directory absent here is outside any repository), or why they cannot be read. */
export interface MemoryRuns {
  readonly tables: Map<string, ReadonlyArray<RunTable>>
  failure?: string
}

export const layer = (runs: MemoryRuns) =>
  Layer.succeed(RunTables, {
    list: (directory: string) =>
      Effect.suspend(() =>
        runs.failure === undefined
          ? Effect.succeed(runs.tables.get(directory) ?? [])
          : Effect.fail(new RunsUnreadable({ message: runs.failure })),
      ),
  })
