// What the pool needs from outside, with its failures: the provider's logins,
// its quota, the ledger the next process reads, the other hosts of the fleet,
// and where this host keeps what it knows of the fleet. laws.ts states what
// every implementation owes.
import { Context, type Effect, Schema, type Stream } from "effect"
import type { Event, LedgerState, PoolId } from "./account-pool.ts"
import type { StoreRefreshes } from "./alerts.ts"
import type { Event as FleetEvent, FleetState } from "./fleet.ts"
import type { LimitsReport, Tally, Use } from "./limits.ts"
import type { ClaimAnswer, QuotaReading } from "./quota.ts"
import type { LeaseAnswer, LeaseMessage } from "./lease.ts"
import type { Event as PushEvent, HostLoad, PushAnswer, PushRequest, PushState } from "./push.ts"
import type { Event as ResetsEvent, ResetsState } from "./resets.ts"
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
    /**
     * Ask the peer for an account's claim lease, or release one (lease.ts),
     * through its pool's `lease`: its answer. The caller bounds the wait.
     */
    readonly lease: (peer: string, message: LeaseMessage) => Effect.Effect<LeaseAnswer, PeerUnreachable>
    /** Hand a push request to the peer it is for (push.ts), through its pool's `push`: its answer. */
    readonly push: (peer: string, request: PushRequest) => Effect.Effect<PushAnswer, PeerUnreachable>
  }
>()("dotfiles-opencode/pool/Peers") {}

/**
 * Where this host keeps its pushes and the pool's questions about starting
 * one (push.ts), which every plugin instance on the host reads. A failed read
 * is none; a failed write is lost. Optional: a pool without it keeps them in
 * the process.
 */
export class PushStore extends Context.Service<
  PushStore,
  {
    readonly read: Effect.Effect<PushState>
    /** Write what `events` change; `state` is the state with them folded in. */
    readonly record: (events: ReadonlyArray<PushEvent>, state: PushState) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/PushStore") {}

/** One orchestrate run as the pool reads it: its name, the session that owns it, and each unit's state (the orchestrate status script's). */
export interface RunWork {
  readonly name: string
  /** The session that owns the run (the status RPC's, from orchestrate's call log: it started the latest step of one of its units); none when no step was started. */
  readonly session?: string
  readonly units: ReadonlyArray<{ readonly unit: string; readonly state: string }>
}

/**
 * What the host is doing, for a push's plan and the proactive question: its
 * CPU load against its cores, and the orchestrate runs of the directory this
 * plugin instance serves. None when unread. Optional: a pool without it plans
 * without them.
 */
export class Workload extends Context.Service<
  Workload,
  {
    readonly load: Effect.Effect<HostLoad | undefined>
    readonly runs: Effect.Effect<ReadonlyArray<RunWork>>
  }
>()("dotfiles-opencode/pool/Workload") {}

/**
 * Where this host keeps the Resets aggregate's state (resets.ts): each pool's
 * newest held start, each hold's reset and the claims made. Every plugin
 * instance on the host reads and records the same state, so a hold is worked
 * once. A failed read is empty; a failed write is lost.
 */
export class ResetsStore extends Context.Service<
  ResetsStore,
  {
    readonly read: Effect.Effect<ResetsState>
    /** Write what `events` change; `state` is the state with them folded in. */
    readonly record: (events: ReadonlyArray<ResetsEvent>, state: ResetsState) => Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/ResetsStore") {}

/**
 * The limit tally (limits.ts): the tokens each request a pool served used, the
 * readings, and the peers' reports, kept so a restart loses none of it. Every
 * plugin instance on the host records the same requests and readings; the
 * store keeps each request once. Optional: a pool without it tallies nothing.
 * A failed read starts empty; a failed write is lost.
 */
export class Limits extends Context.Service<
  Limits,
  {
    /** A request ended: its tokens count on its account, once per assistant message. */
    readonly use: (messageID: string, use: Use) => Effect.Effect<void>
    /** A reading of one account came in. */
    readonly observe: (pool: PoolId, credentialID: string, reading: QuotaReading) => Effect.Effect<void>
    /** What this host tells its peers of its tokens. */
    readonly report: Effect.Effect<LimitsReport>
    /** A peer's report of its tokens. */
    readonly takePeer: (peer: string, report: LimitsReport) => Effect.Effect<void>
    /** Count the open rows again, keep the tally where the next process and the CLI read it, and forget old requests. */
    readonly flush: Effect.Effect<void>
    /** The tally now. */
    readonly tally: Effect.Effect<Tally>
  }
>()("dotfiles-opencode/pool/Limits") {}

/** A question the pool asks the owner about one hold's reset. */
export interface OwnerQuestion {
  /** The session whose start waits; the question shows in its tree's root. */
  readonly sessionID: string
  /** The hold's key: the question is asked once under it. */
  readonly key: string
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly assume: string
}

/** One of the pool's questions as it stands: its key, and the owner's answer once given. */
export interface OwnerAnswer {
  readonly key: string
  readonly answer?: string
}

/**
 * The owner, asked through the background questions (the questions plugin),
 * in the root session of the start that waits. An answer waits on its
 * question until the pool reads it and withdraws it.
 */
export class Owner extends Context.Service<
  Owner,
  {
    /** Ask once under the key; false when the question could not be asked. */
    readonly ask: (question: OwnerQuestion) => Effect.Effect<boolean>
    /** The pool's questions as they stand, open and answered; none when they cannot be read. */
    readonly answers: Effect.Effect<ReadonlyArray<OwnerAnswer> | undefined>
    /** The question under `key` goes, open or answered. */
    readonly withdraw: (key: string) => Effect.Effect<void>
    /** A beat each time the questions change, until interrupted: the pool reads its answers then. */
    readonly changes: Stream.Stream<void>
    /** The root of a session's tree, where its questions show: the session itself when the host cannot say more. */
    readonly root: (sessionID: string) => Effect.Effect<string>
  }
>()("dotfiles-opencode/pool/Owner") {}

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
