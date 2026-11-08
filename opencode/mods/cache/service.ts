// The contract the cache mod's server half needs from outside: the ledger file
// its lines go to, and each session's newest judged request kept beside it.
// `laws.ts` states what every implementation owes.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Kept, LedgerLine } from "./request-log.ts"

/** The ledger could not be written or read. */
export class LedgerUnavailable extends Schema.TaggedError<LedgerUnavailable>()("LedgerUnavailable", {
  message: Schema.String,
}) {}

/** The ledger of judged requests: appended to as each request settles, read by the report. */
export class RequestLog extends Context.Service<
  RequestLog,
  {
    /** Add a line after every line before it. */
    readonly append: (line: LedgerLine) => Effect.Effect<void, LedgerUnavailable>
    /** Every line that decodes, oldest first; a line that does not is skipped. */
    readonly read: Effect.Effect<ReadonlyArray<LedgerLine>, LedgerUnavailable>
    /** Keep the session's newest judged request, in place of the one kept before. */
    readonly keep: (sessionID: string, kept: Kept) => Effect.Effect<void, LedgerUnavailable>
    /** The session's newest judged request as any process kept it; none when none was, or it does not decode. */
    readonly last: (sessionID: string) => Effect.Effect<Option.Option<Kept>, LedgerUnavailable>
  }
>()("dotfiles-opencode/cache/RequestLog") {}
