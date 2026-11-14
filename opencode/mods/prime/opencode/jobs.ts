// The Host's jobs read (tui/host.ts): the session's jobs, running and
// recently ended, over the wake mod's `jobs` RPC, read as reading.ts says (on
// every `changed` event for the session and every 2 seconds, the last reading
// kept when a read fails). The answer decodes with Prime's own narrow schema.
// Also the Jobs tab's kill, over the `kill` RPC: the owner's stop, whose end
// letter still wakes the session.
import { Killed, WAKES } from "@dotfiles/opencode-wake/wake"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import type { Accessor } from "solid-js"
import type { Jobs } from "../jobs.ts"
import { readSession } from "./reading.ts"

const Answer = Schema.Struct({
  now: Schema.Number,
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      command: Schema.String,
      cwd: Schema.String,
      setAt: Schema.Number,
      state: Schema.Literals(["starting", "running", "exited", "killed", "timed out", "lost"]),
      exitCode: Schema.OptionFromOptionalKey(Schema.Number),
      startedAt: Schema.OptionFromOptionalKey(Schema.Number),
      endedAt: Schema.OptionFromOptionalKey(Schema.Number),
      logTail: Schema.String,
    }),
  ),
})

/** The `jobs` answer as Prime reads it; none when it does not read (an older wake server answers no such method). */
export const decodeJobs = Schema.decodeUnknownOption(Answer)
const decodeKilled = Schema.decodeUnknownOption(Killed)

export function readJobs(context: Plugin.Context, sessionID: Accessor<Option.Option<string>>): Accessor<Option.Option<Jobs>> {
  return readSession(context, sessionID, (id, signal) =>
    context.client
      .rpc(WAKES)
      .jobs({ sessionID: id }, { location: context.location, signal })
      .then((answer): Option.Option<Jobs> => decodeJobs(answer), () => Option.none<Jobs>()),
  )
}

type Refused = Extract<Killed, { readonly outcome: "refused" }>
const refused = (answer: Killed): answer is Refused => answer.outcome === "refused"

/** What a kill's answer (none when it did not read) says against it: the refusal's reason, or none for a stop. */
export const refusalOf: (answer: Option.Option<Killed>) => Option.Option<string> = Option.match({
  onNone: () => Option.some("the wake server's answer did not read"),
  onSome: (answer) => Option.map(Option.filter(Option.some(answer), refused), (each) => each.reason),
})

/** Stops one of the session's running jobs: the refusal's reason (a failed call's too), or none once it was asked to stop. */
export const killJob = (context: Plugin.Context, sessionID: string, id: string): Promise<Option.Option<string>> =>
  context.client
    .rpc(WAKES)
    .kill({ sessionID, id }, { location: context.location })
    .then(decodeKilled, (error) => Option.some<Killed>({ outcome: "refused", reason: String(error) }))
    .then(refusalOf)
