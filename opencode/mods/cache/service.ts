// The contract the cache mod's server half needs from outside: the ledger file
// its lines go to. `laws.ts` states what every implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { LedgerLine } from "./request-log.ts"

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
  }
>()("dotfiles-opencode/cache/RequestLog") {}
