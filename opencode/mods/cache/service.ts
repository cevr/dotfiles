// The contracts the cache mod's server half needs from outside: the ledger
// file its lines go to, and each session's newest judged request kept beside
// it; the keepalive's log, and the network its pings go out on. `laws.ts`
// states what every implementation of a log owes.
import { Context, type Effect, type Option, Schema } from "effect"
import type { Answer, Header, PingLine } from "./keepalive.ts"
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

/** The keepalive's log: one line per ping, beside the ledger, read by the dream's cache audit. */
export class PingLog extends Context.Service<
  PingLog,
  {
    /** Add a line after every line before it. */
    readonly append: (line: PingLine) => Effect.Effect<void, LedgerUnavailable>
    /** Every line that decodes, oldest first; a line that does not is skipped. */
    readonly read: Effect.Effect<ReadonlyArray<PingLine>, LedgerUnavailable>
  }
>()("dotfiles-opencode/cache/PingLog") {}

/** A ping got no answer: the network failed, or it was refused before it left. */
export class PingFailed extends Schema.TaggedError<PingFailed>()("PingFailed", {
  message: Schema.String,
}) {}

/** A ping as it goes out. */
export interface PingRequest {
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<Header>
  readonly body: string
}

/** A ping's answer, read whole and then dropped. */
export type PingAnswer = Answer

/** Sends a ping outside the session: no hook and no event sees it. Interrupting it aborts the request. */
export class Pinger extends Context.Service<
  Pinger,
  {
    readonly send: (request: PingRequest) => Effect.Effect<PingAnswer, PingFailed>
  }
>()("dotfiles-opencode/cache/Pinger") {}
