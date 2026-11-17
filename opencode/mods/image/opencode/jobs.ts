// Jobs over the wakes' `set` RPC (mods/wake wake.ts `WAKES`, its job
// variant): the runner's command for a request file runs as the session's job,
// outside the server, and its end letter wakes the session. No wakes plugin, a
// failure, a timeout or an answer that is not one refuses the start.
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { Armed, type SetAsk } from "@dotfiles/opencode-wake/wake"
import { JobRefused, Jobs } from "../service.ts"

/** The wakes' `set` method, as the plugin's RPC client calls it. */
export type Set = (ask: SetAsk) => Effect.Effect<unknown, unknown>

/** How long the wakes have to start the job. */
const TIMEOUT = "15 seconds"

/** How long a run may take before the wakes stop it: the paid API's ten images fit. */
export const TIMEOUT_SECONDS = 30 * 60

const decode = Schema.decodeUnknownOption(Armed)

const messageOf = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const answerOf = (answer: Option.Option<unknown>) =>
  Option.match(answer, {
    onNone: () => Effect.fail(new JobRefused({ reason: "the wakes did not answer in time" })),
    onSome: (raw) =>
      Option.match(decode(raw), {
        onNone: () => Effect.fail(new JobRefused({ reason: "the wakes' answer is not one" })),
        onSome: (armed) => {
          if (armed.outcome === "set") return Effect.succeed(armed.id)
          return Effect.fail(new JobRefused({ reason: armed.reason }))
        },
      }),
  })

/** Jobs that run `command(file)` through `set`. */
export const layer = (set: Set, command: (file: string) => string) =>
  Layer.succeed(
    Jobs,
    Jobs.of({
      start: (sessionID, job) =>
        Effect.suspend(() => set({ sessionID, job: { command: command(job.file), cwd: job.cwd, note: job.note, timeoutSeconds: TIMEOUT_SECONDS } })).pipe(
          Effect.timeoutOption(TIMEOUT),
          Effect.catchCause((cause) => Effect.fail(new JobRefused({ reason: `the wakes could not be asked: ${messageOf(Cause.squash(cause))}` }))),
          Effect.flatMap(answerOf),
        ),
    }),
  )
