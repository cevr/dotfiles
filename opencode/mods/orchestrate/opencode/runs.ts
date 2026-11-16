// The runs over the status plugin's RPC (mods/status status.ts `STATUS`),
// which answers the runs of the repository its copy serves, each unit's state
// derived by the orchestrate skill's status script from its files and git, as
// the /pool pane reads them, with the log.md time each unit entered its state
// (`since`), its round (`round`) and its newest verdict (`verdict`), each kept
// when it has one, and each run's dir (`dir`, kept when given). Only the runs
// and the runs' error (`errors`' `Runs: …` line) are read, with this mod's own
// schema; a field it does not name (an older table's `cadence`) is passed over.
// No status plugin, a failure, a timeout or an answer that is not one is no
// runs, and says so as the read's error.
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
        Schema.Struct({
          unit: Schema.String,
          state: Schema.String,
          since: Schema.optional(Schema.String),
          round: Schema.optional(Schema.String),
          verdict: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.String)),
})

/** The optional fields a unit keeps only when the status plugin gave them, not empty. */
const OPTIONAL = ["since", "round", "verdict"] as const
type Optional = (typeof OPTIONAL)[number]

/** A unit as the runs keep it: `since`, `round` and `verdict` only when the status plugin gave them. */
const unitOf = (given: { unit: string; state: string } & { readonly [K in Optional]?: string }) => {
  const unit: { unit: string; state: string } & { [K in Optional]?: string } = { unit: given.unit, state: given.state }
  for (const key of OPTIONAL) Option.map(Option.filter(Option.fromUndefinedOr(given[key]), (value) => value !== ""), (value) => (unit[key] = value))
  return unit
}
const decode = Schema.decodeUnknownOption(Answer)

/** The status plugin's line for its runs half: `Runs: <why>`. */
const RUNS_ERROR = "Runs: "

export const layer = (status: Status) => {
  const read = Effect.suspend(status).pipe(
    Effect.timeoutOption(TIMEOUT),
    Effect.map((answer) =>
      Option.match(answer, {
        onNone: () => ({ runs: [], error: Option.some(`the status plugin did not answer within ${TIMEOUT}`) }),
        onSome: (given) =>
          Option.match(decode(given), {
            onNone: () => ({ runs: [], error: Option.some("the status plugin's answer did not read") }),
            onSome: (decoded) => ({
              runs: decoded.runs.map((run) => ({ name: run.name, ...(run.dir === undefined || run.dir === "" ? {} : { dir: run.dir }), units: run.units.map(unitOf) })),
              error: Option.map(
                Option.fromUndefinedOr((decoded.errors ?? []).find((line) => line.startsWith(RUNS_ERROR))),
                (line) => line.slice(RUNS_ERROR.length),
              ),
            }),
          }),
      }),
    ),
    Effect.catchCause(() => Effect.succeed({ runs: [], error: Option.some("the status plugin's RPC failed (not loaded, or it died)") })),
    Effect.withSpan("Runs.read"),
  )
  return Layer.succeed(Runs, { read, list: read.pipe(Effect.map((tables) => tables.runs)) })
}
