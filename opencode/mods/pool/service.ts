// What the pool needs from outside, with its failures: the provider's logins,
// its quota, and the ledger the next process reads. laws.ts states what every
// implementation owes.
import { Context, type Effect, Schema, type Stream } from "effect"
import type { Event, LedgerState, PoolId } from "./account-pool.ts"
import type { QuotaReading } from "./quota.ts"
import type { SourceStatus } from "./status.ts"

/**
 * Where a pool keeps what the next process needs: its holds, readings and
 * priced steps. A failed read starts the pool empty; a failed write is lost.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly restore: (pool: PoolId) => Effect.Effect<LedgerState>
    /** Write what `events` change in the ledger. */
    readonly record: (pool: PoolId, events: ReadonlyArray<Event>) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/Ledger") {}

/** The provider's logins could not be read: its integration (with no outside store beside it), or an outside store. */
export class LoginsUnavailable extends Schema.TaggedError<LoginsUnavailable>()("LoginsUnavailable", {
  pool: Schema.String,
  message: Schema.String,
}) {}

/**
 * The provider's subscription logins: its integration's OAuth logins in
 * order, then each outside store's (gent's). The list is read again at most
 * every so often unless `force` asks for it now.
 */
export class Logins extends Context.Service<
  Logins,
  {
    readonly list: (pool: PoolId, force: boolean) => Effect.Effect<ReadonlyArray<string>, LoginsUnavailable>
    /**
     * Mark a login of the integration as needing a sign-in (`needed`), or
     * clear the mark. Only a change reaches the host, and only for a login
     * the integration lists.
     */
    readonly markSignIn: (pool: PoolId, credentialID: string, needed: boolean) => Effect.Effect<void>
    /** The outside stores whose logins join the pool, as they list them now. */
    readonly sources: (pool: PoolId) => Effect.Effect<ReadonlyArray<SourceStatus>, LoginsUnavailable>
    /**
     * A login's name as its store lists it, never a secret: an integration
     * login's label, an outside store's own label. A login it cannot name
     * (one not listed yet) is named by its id.
     */
    readonly label: (pool: PoolId, credentialID: string) => Effect.Effect<string>
  }
>()("dotfiles-opencode/pool/Logins") {}

/** A reading the auth plugin published of one login. */
export interface PublishedReading {
  readonly credentialID: string
  readonly reading: QuotaReading
}

/**
 * The provider's quota, from its auth plugin. A failure, a timeout or a
 * malformed answer is no reading: the pool goes on without it.
 */
export class Quota extends Context.Service<
  Quota,
  {
    /** The newest reading the auth plugin holds of a login. */
    readonly reading: (pool: PoolId, credentialID: string) => Effect.Effect<QuotaReading | undefined>
    /** A fresh reading of a login's usage endpoint. */
    readonly usage: (pool: PoolId, credentialID: string) => Effect.Effect<QuotaReading | undefined>
    /** Readings the auth plugin publishes as they come. */
    readonly readings: (pool: PoolId) => Stream.Stream<PublishedReading>
  }
>()("dotfiles-opencode/pool/Quota") {}
