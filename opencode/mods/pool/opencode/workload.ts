// What the host is doing, as the pool plugin reads it: its 1-minute load
// average against its cores (node:os), and the orchestrate runs of the
// directory this instance serves over the status plugin's RPC
// (`dotfiles-opencode.status`, its `status` method: each run's units with the
// state the orchestrate status script derives), read with the pool's own
// schema. No status plugin, a failure, a timeout or an answer that is not one
// is no runs.
import { cpus, loadavg } from "node:os"
import { Effect, Layer, Option, Schema } from "effect"
import type { HostLoad } from "../push.ts"
import { Workload } from "../service.ts"

/** The status plugin's `status` method, as the plugin's RPC client calls it. */
export type Status = () => Effect.Effect<unknown, unknown>

/** How long the status plugin has: it runs the status script once per run. */
const TIMEOUT = "20 seconds"

const Answer = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      units: Schema.Array(Schema.Struct({ unit: Schema.String, state: Schema.String })),
    }),
  ),
})
const decode = Schema.decodeUnknownOption(Answer)

/** This host's load now. */
export const osLoad = (): HostLoad => ({ load: loadavg()[0] ?? 0, cores: cpus().length })

export const layer = (status: Status, load: () => HostLoad = osLoad) =>
  Layer.succeed(Workload, {
    load: Effect.try({ try: load, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined)),
    runs: Effect.suspend(status).pipe(
      Effect.timeoutOption(TIMEOUT),
      Effect.map((answer) => Option.flatMap(answer, decode)),
      Effect.map((answer) =>
        Option.isNone(answer) ? [] : answer.value.runs.map((run) => ({ name: run.name, units: run.units.map(({ unit, state }) => ({ unit, state })) })),
      ),
      Effect.catchCause(() => Effect.succeed([])),
      Effect.withSpan("Workload.runs"),
    ),
  })
