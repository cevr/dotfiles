// The runs over the status plugin's RPC (mods/status status.ts `STATUS`),
// which answers the runs of the repository its copy serves, each unit's state
// derived by the orchestrate skill's status script, as the /pool pane reads
// them, with the log.md time each unit entered its state (`since`, kept when
// it has one) and its batch cadence (`cadence`, kept when it has one), and
// each run's dir (`dir`, kept when given). Only the runs are read, with this mod's own schema. No status plugin,
// a failure, a timeout or an answer that is not one is no runs.
import { Effect, Layer, Option, Schema } from "effect"
import { Runs } from "../service.ts"

/** The status plugin's `status` method, as the plugin's RPC client calls it. */
export type Status = () => Effect.Effect<unknown, unknown>

/** How long the status plugin has: it runs the status script once per run. */
const TIMEOUT = "20 seconds"

const Answer = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      dir: Schema.optional(Schema.String),
      units: Schema.Array(
        Schema.Struct({ unit: Schema.String, state: Schema.String, since: Schema.optional(Schema.String), cadence: Schema.optional(Schema.String) }),
      ),
    }),
  ),
})

/** A unit as the runs keep it: `since` and `cadence` only when the status plugin gave them. */
const unitOf = ({ unit, state, since, cadence }: { unit: string; state: string; since?: string; cadence?: string }) => ({
  unit,
  state,
  ...(since === undefined || since === "" ? {} : { since }),
  ...(cadence === undefined || cadence === "" ? {} : { cadence }),
})
const decode = Schema.decodeUnknownOption(Answer)

export const layer = (status: Status) =>
  Layer.succeed(Runs, {
    list: Effect.suspend(status).pipe(
      Effect.timeoutOption(TIMEOUT),
      Effect.map((answer) => Option.flatMap(answer, decode)),
      Effect.map((answer) =>
        Option.isNone(answer)
          ? []
          : answer.value.runs.map((run) => ({ name: run.name, ...(run.dir === undefined || run.dir === "" ? {} : { dir: run.dir }), units: run.units.map(unitOf) })),
      ),
      Effect.catchCause(() => Effect.succeed([])),
      Effect.withSpan("Runs.list"),
    ),
  })
