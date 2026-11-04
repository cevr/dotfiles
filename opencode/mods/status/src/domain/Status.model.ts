// The status mod's one handler: read the call log and the runs, each on its
// own, and answer with what could be read and why the rest could not. Status
// decides nothing, so it has no aggregate: the call log folds into the
// AgentCalls view, and the runs' tables parse into units.
import { Context, Effect, Layer, Result } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { AgentCalls, live } from "./Agents/AgentCalls.view.ts"
import { CallLog } from "./Agents/CallLog.external.ts"
import { unitsOf } from "./RunTable.ts"
import { RunTables } from "./Runs/RunTables.external.ts"
import type { Snapshot } from "./Status.ts"

export class Status extends Context.Service<
  Status,
  {
    /** The live agents and the runs of the repository holding `directory`. A half that cannot be read is empty, and `errors` says why. */
    readonly snapshot: (directory: string) => Effect.Effect<Snapshot>
  }
>()("dotfiles-opencode/status/Status") {}

export const layer = Layer.effect(
  Status,
  Effect.gen(function* () {
    const callLog = yield* CallLog
    const runTables = yield* RunTables
    return {
      snapshot: Effect.fn("Status.snapshot")(function* (directory: string) {
        const [agents, runs] = yield* Effect.all(
          [
            callLog.events.pipe(Effect.map((events) => live(fold(AgentCalls, events))), Effect.result),
            runTables.list(directory).pipe(
              Effect.map((tables) => tables.map((run) => ({ name: run.name, units: unitsOf(run.table) }))),
              Effect.result,
            ),
          ],
          { concurrency: "unbounded" },
        )
        return {
          agents: Result.getOrElse(agents, () => []),
          runs: Result.getOrElse(runs, () => []),
          errors: [
            ...(Result.isFailure(agents) ? [`Agents: ${agents.failure.message}`] : []),
            ...(Result.isFailure(runs) ? [`Runs: ${runs.failure.message}`] : []),
          ],
        }
      }),
    }
  }),
)
