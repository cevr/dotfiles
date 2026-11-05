// The contract the reporter needs from outside: herdr, which takes our
// reports for one pane. It states its failures; `laws.ts` states what every
// implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { AgentParams, MetadataParams, ReleaseParams } from "./report.ts"

/** herdr could not be reached, closed before replying, or did not reply in time. */
export class HerdrUnreachable extends Schema.TaggedError<HerdrUnreachable>()("HerdrUnreachable", { message: Schema.String }) {}

/** herdr answered with an error. */
export class HerdrRefused extends Schema.TaggedError<HerdrRefused>()("HerdrRefused", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

export type HerdrFailure = HerdrUnreachable | HerdrRefused

/**
 * herdr's socket API, as far as a reporter uses it: one request per call,
 * answered before the call returns. Each fails `HerdrRefused` with herdr's
 * own code when herdr answers with an error.
 */
export class Herdr extends Context.Service<
  Herdr,
  {
    /** `pane.report_agent`: our state, session and resume command. */
    readonly report: (params: AgentParams) => Effect.Effect<void, HerdrFailure>
    /** `pane.report_metadata`: the title and state labels, presentation only. */
    readonly reportMetadata: (params: MetadataParams) => Effect.Effect<void, HerdrFailure>
    /** `pane.release_agent`: the pane is ours no more. */
    readonly release: (params: ReleaseParams) => Effect.Effect<void, HerdrFailure>
  }
>()("dotfiles-opencode/herdr/Herdr") {}
