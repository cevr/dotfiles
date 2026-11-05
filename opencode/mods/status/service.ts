// The contracts the status model needs from outside, with their failures:
// orchestrate's call log and the runs' tables. What every implementation owes
// is in laws.ts.
import { Context, type Effect, Schema } from "effect"
import type { Event } from "./agent-calls.ts"
import type { RunTable } from "./run-table.ts"

/** The call log exists but could not be read. */
export class CallLogUnreadable extends Schema.TaggedError<CallLogUnreadable>()("CallLogUnreadable", {
  message: Schema.String,
}) {}

/**
 * Orchestrate's call log, as the subagent calls it records, in order. No log
 * yet is no calls; a line that is not a call or a return is skipped, and so
 * is a partial last line until the writer finishes it.
 */
export class CallLog extends Context.Service<
  CallLog,
  { readonly events: Effect.Effect<ReadonlyArray<Event>, CallLogUnreadable> }
>()("dotfiles-opencode/status/CallLog") {}

/** The runs directory could not be listed, or the status script failed on a run. */
export class RunsUnreadable extends Schema.TaggedError<RunsUnreadable>()("RunsUnreadable", {
  message: Schema.String,
}) {}

/**
 * The orchestrate runs of the repository holding `directory`
 * (`tmp/orchestrate/<run>` at its main checkout), each with the table the
 * orchestrate skill's status script derives from its units' logs. Outside a
 * repository, or with no runs directory, there are none.
 */
export class RunTables extends Context.Service<
  RunTables,
  { readonly list: (directory: string) => Effect.Effect<ReadonlyArray<RunTable>, RunsUnreadable> }
>()("dotfiles-opencode/status/RunTables") {}
