import { Effect } from "effect"
import { runTablesLaws } from "../laws.ts"
import * as MemoryRunTables from "./run-tables.ts"

runTablesLaws("memory RunTables", (tables) =>
  Effect.sync(() => {
    const runs: MemoryRunTables.MemoryRuns = { tables: new Map([["/repo", tables]]) }
    return {
      layer: MemoryRunTables.layer(runs),
      repository: "/repo",
      outside: "/elsewhere",
      spoil: Effect.sync(() => {
        runs.failure = "bun failed: no such run"
      }),
    }
  }),
)
