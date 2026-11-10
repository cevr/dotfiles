// What the pool needs from outside, with its failures: the provider's logins,
// its quota, the ledger the next process reads, the other hosts of the fleet,
// and where this host keeps what it knows of the fleet. laws.ts states what
// every implementation owes.
import { Context, type Effect, Schema, type Stream } from "effect"
import type { Event, LedgerState, PoolId } from "./account-pool.ts"
import type { StoreRefreshes } from "./alerts.ts"
import type { Event as FleetEvent, FleetState } from "./fleet.ts"
import type { ClaimAnswer, QuotaReading } from "./quota.ts"
import type { Report, SourceStatus } from "./status.ts"

/**
 * Where a pool keeps what the next process needs: its holds, readings,
 * priced steps and the account each session's cache is on. A failed read
 * starts the pool empty; a failed write is lost.
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
    /**
     * What each outside store of the pool reports of its refreshes: the logins
     * whose refresh token the token endpoint refused and that their files still
     * hold, and its run of failed trades. Never a token.
     */
    readonly refreshes: (pool: PoolId) => Effect.Effect<ReadonlyArray<StoreRefreshes>>
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
    /**
     * Claim the reset `creditID` names on a login, under the idempotency key
     * `requestID`. Only the Resets decision calls it. Never fails: a failure
     * is its outcome.
     */
    readonly claim: (
      pool: PoolId,
      input: { readonly credentialID: string; readonly creditID: string; readonly requestID: string },
    ) => Effect.Effect<ClaimAnswer>
  }
>()("dotfiles-opencode/pool/Quota") {}

/** A peer host could not be read: no answer in time, a refusal, or an answer that is not a report. */
export class PeerUnreachable extends Schema.TaggedError<PeerUnreachable>()("PeerUnreachable", {
  peer: Schema.String,
  message: Schema.String,
}) {}

/**
 * The other hosts of the fleet, each by the name the config gives it, and
 * what each reports of itself now: the agents it admitted lately and its
 * readings. A report never carries a token.
 */
export class Peers extends Context.Service<
  Peers,
  {
    /** The peers, in the config's order. */
    readonly names: ReadonlyArray<string>
    readonly report: (peer: string) => Effect.Effect<Report, PeerUnreachable>
  }
>()("dotfiles-opencode/pool/Peers") {}

/**
 * Where this host keeps the Fleet aggregate's state: its own starts and what
 * it knows of each peer. Every plugin instance on the host (one per directory
 * OpenCode serves) reads and records the same state. A failed read is an
 * empty fleet; a failed write is lost.
 */
export class FleetStore extends Context.Service<
  FleetStore,
  {
    readonly read: Effect.Effect<FleetState>
    /** Write what `events` change; `state` is the fleet with them folded in. */
    readonly record: (events: ReadonlyArray<FleetEvent>, state: FleetState) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/FleetStore") {}
