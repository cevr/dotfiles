import { Context, type Effect, Schema } from "effect"
import type { Event } from "./AgentCalls.view.ts"

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
