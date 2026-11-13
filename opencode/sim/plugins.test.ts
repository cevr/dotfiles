// The world's doubles of what a plugin keeps outside OpenCode keep the same
// laws as the adapters OpenCode runs: the status script's runs in the world's
// shell (`runTables`) the RunTables laws the process adapter keeps on disk
// (mods/status/process/run-tables.test.ts), and the step log read back from
// the call log's lines (`stepLogOf`) the StepLog laws the file's step log
// keeps (mods/orchestrate/filestore/step-log.test.ts).
import { stepLogLaws } from "@dotfiles/opencode-orchestrate/laws"
import { runTablesLaws } from "@dotfiles/opencode-status/laws"
import type { RunTable } from "@dotfiles/opencode-status/run-table"
import { Array as Arr, Effect, Option } from "effect"
import { runTables, stepLogOf } from "./plugins.ts"
import * as World from "./world.ts"

const SCRIPT = "/skills/orchestrate/scripts/status.ts"
const REPOSITORY = "/repo"

/** A world whose shell holds `runs` under the repository, read by the status script; `spoil` makes the script fail. */
runTablesLaws("the world's status script's RunTables", (runs: ReadonlyArray<RunTable>) =>
  Effect.sync(() => {
    const state = { spoiled: false }
    const root = `${REPOSITORY}/tmp/orchestrate`
    const processes = (command: string): World.Process => {
      if (command === `ls -1 ${root}` && runs.length > 0) return { exitCode: 0, stdout: runs.map((run) => `${run.name}\n`).join(""), ms: 1 }
      if (command.startsWith("ls -1 ")) return { exitCode: 2, stdout: "", ms: 1 }
      return Option.match(
        Arr.findFirst(runs, (each) => command === `bun ${SCRIPT} ${root}/${each.name}`),
        {
          onNone: () => World.PROCESSES(command),
          onSome: (run): World.Process => {
            if (state.spoiled) return { exitCode: 1, stdout: `cannot read ${root}/${run.name}\n`, ms: 1 }
            return { exitCode: 0, stdout: run.table, ms: 1 }
          },
        },
      )
    }
    const world = World.make({ seed: 1, script: () => World.say(""), processes })
    return {
      layer: runTables(world, SCRIPT),
      repository: REPOSITORY,
      outside: "/outside",
      spoil: Effect.sync(() => {
        state.spoiled = true
      }),
    }
  }),
)

stepLogLaws("the world's call log's StepLog", (steps) =>
  stepLogOf(
    Object.entries(steps).flatMap(([sessionID, units]) =>
      units.map((unit, index) => ({ kind: "call", at: "2026-11-04T15:00:00.000Z", sessionID, callID: `call-${index}`, agent: "planner", description: `planner ${unit} r1` })),
    ),
  ),
)
