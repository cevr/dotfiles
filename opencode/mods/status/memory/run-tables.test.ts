import { Effect } from "effect"
import { runTablesLaws } from "../laws.ts"
import * as MemoryRunTables from "./run-tables.ts"

runTablesLaws("memory RunTables", (tables) =>
  Effect.sync(() => {
    const broken = new Map<string, string>()
    const runs: MemoryRunTables.MemoryRuns = { tables: new Map([["/repo", tables]]), broken }
    return {
      layer: MemoryRunTables.layer(runs),
      repository: "/repo",
      outside: "/elsewhere",
      spoil: (name) =>
        Effect.sync(() => {
          broken.set(name, `bun failed: no such run ${name}`)
        }),
    }
  }),
)
