// The runs over the status plugin's RPC (mods/status status.ts `STATUS`),
// which answers the runs of the repository its copy serves, each unit's state
// derived by the orchestrate skill's status script, as the /pool pane reads
// them. Only the runs are read, with this mod's own schema. No status plugin,
// a failure, a timeout or an answer that is not one is no runs.
import { Effect, Layer, Option, Schema } from "effect"
import { Runs } from "../service.ts"

/** The status plugin's `status` method, as the plugin's RPC client calls it. */
export type Status = () => Effect.Effect<unknown, unknown>

/** How long the status plugin has: it runs the status script once per run. */
const TIMEOUT = "20 seconds"

const Answer = Schema.Struct({
  runs: Schema.Array(Schema.Struct({ name: Schema.String, units: Schema.Array(Schema.Struct({ unit: Schema.String, state: Schema.String })) })),
})
const decode = Schema.decodeUnknownOption(Answer)

export const layer = (status: Status) =>
  Layer.succeed(Runs, {
    list: Effect.suspend(status).pipe(
      Effect.timeoutOption(TIMEOUT),
      Effect.map((answer) => Option.flatMap(answer, decode)),
      Effect.map((answer) =>
        Option.isNone(answer) ? [] : answer.value.runs.map((run) => ({ name: run.name, units: run.units.map(({ unit, state }) => ({ unit, state })) })),
      ),
      Effect.catchCause(() => Effect.succeed([])),
      Effect.withSpan("Runs.list"),
    ),
  })
