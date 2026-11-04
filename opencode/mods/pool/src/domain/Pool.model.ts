// The pool model's handlers: each gathers what one moment of a request needs
// from the outside systems (the provider's logins, its quota, the ledger), has
// the AccountPool aggregate decide it, and writes what changed to the ledger.
// The aggregate is the one decision entry point, so the stories run exactly
// what these do. The plugin calls these and nothing else.
import { Clock, Context, Effect, Layer, Stream, SynchronizedRef } from "effect"
import { fold } from "../../../../lib/decider.ts"
import {
  AccountPool,
  restored,
  type AccountPoolState,
  type Command,
  type Event,
} from "./AccountPool/AccountPool.aggregate.ts"
import type { PoolId } from "./AccountPool/AccountPool.id.ts"
import { ListLogins } from "./AccountPool/ListLogins.command.ts"
import { Ledger } from "./AccountPool/Ledger.external.ts"
import { Logins, type LoginsUnavailable } from "./AccountPool/Logins.external.ts"
import { PlaceRequest } from "./AccountPool/PlaceRequest.command.ts"
import { PruneLedger } from "./AccountPool/PruneLedger.command.ts"
import { Quota } from "./AccountPool/Quota.external.ts"
import { RecordStep } from "./AccountPool/RecordStep.command.ts"
import { RefuseRequest } from "./AccountPool/RefuseRequest.command.ts"
import { ReleaseRun } from "./AccountPool/ReleaseRun.command.ts"
import { TakeReading } from "./AccountPool/TakeReading.command.ts"
import { held, lastPlacedAt, placedOn, shouldFailOver, status, type RequestKind } from "./Accounts.ts"
import { poolPace, UNPOOLED, type Pace } from "./Pace.ts"
import type { PoolsStatus } from "./PoolStatus.ts"
import type { QuotaReading } from "./Quota.ts"

/** The pool's settings, from the plugin's options. */
export interface Config {
  /** Each pooled provider, by id, to the pool (its integration) whose logins it uses. */
  readonly providers: Readonly<Record<string, PoolId>>
}

/** The pools a config names: each integration once, in the order the providers name them. */
export const poolsOf = (config: Config): ReadonlyArray<PoolId> => [...new Set(Object.values(config.providers))]

export class Pool extends Context.Service<
  Pool,
  {
    /** A model request goes out: the login it goes out on, or none when the provider is not pooled or lists no login. */
    readonly place: (input: {
      readonly providerID: string
      readonly sessionID: string
      readonly kind: RequestKind
    }) => Effect.Effect<string | undefined>
    /** A response came back. A refusal (401 or 429) holds the login it went out on. */
    readonly responded: (input: {
      readonly providerID: string
      readonly sessionID: string
      readonly kind: RequestKind
      readonly status: number
    }) => Effect.Effect<void>
    /** A primary request failed: whether it should go again at once, on another login. */
    readonly retry: (input: { readonly providerID: string; readonly sessionID: string }) => Effect.Effect<boolean>
    /** A session went idle: its run ends in every pool. */
    readonly release: (sessionID: string) => Effect.Effect<void>
    /** A step of a session ended with its price, in USD as the host reported it. */
    readonly stepEnded: (sessionID: string, cost: number) => Effect.Effect<void>
    /** Take in the readings each pool's auth plugin publishes, as they come, until interrupted. */
    readonly follow: Effect.Effect<void>
    /** Read every login's usage, and forget what has expired. */
    readonly sweep: Effect.Effect<void>
    /** Whether a new agent on the provider may start now. */
    readonly pace: (providerID: string) => Effect.Effect<Pace, LoginsUnavailable>
    /** Each pool's accounts, holds and readings, and its outside stores. */
    readonly status: Effect.Effect<PoolsStatus, LoginsUnavailable>
  }
>()("dotfiles-opencode/pool/Pool") {}

export const layer = (config: Config) =>
  Layer.effect(
    Pool,
    Effect.gen(function* () {
      const logins = yield* Logins
      const quota = yield* Quota
      const ledger = yield* Ledger

      /**
       * Have the aggregate decide a command against the pool's state, fold
       * what it records in, and write that to the ledger. Commands on one pool
       * are decided one at a time.
       */
      const send = (pool: SynchronizedRef.SynchronizedRef<AccountPoolState>, id: PoolId, command: Command) =>
        SynchronizedRef.modifyEffect(pool, (state) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => AccountPool.decide(state, command, now)),
            Effect.map((events): readonly [ReadonlyArray<Event>, AccountPoolState] => [events, fold(AccountPool, events, state)]),
          ),
        ).pipe(Effect.tap((events) => (events.length === 0 ? Effect.void : ledger.record(id, events))))

      /** `send`, for a command that declares no rejection: only PlaceRequest can be refused. */
      const apply = (pool: SynchronizedRef.SynchronizedRef<AccountPoolState>, id: PoolId, command: Exclude<Command, PlaceRequest>) =>
        send(pool, id, command).pipe(Effect.catchTag("NoAccount", Effect.die))

      const pools = new Map<PoolId, SynchronizedRef.SynchronizedRef<AccountPoolState>>()
      for (const id of poolsOf(config)) {
        const pool = yield* SynchronizedRef.make(restored(yield* ledger.restore(id)))
        yield* apply(pool, id, PruneLedger.make({}))
        pools.set(id, pool)
      }

      const pooled = (providerID: string) => {
        const id = config.providers[providerID]
        const pool = id === undefined ? undefined : pools.get(id)
        return id === undefined || pool === undefined ? undefined : { id, pool }
      }
      type Pooled = NonNullable<ReturnType<typeof pooled>>
      const every = [...pools].map(([id, pool]): Pooled => ({ id, pool }))

      /** The provider's logins, read again when the list is old (or `force`d). */
      const refresh = ({ id, pool }: Pooled, force: boolean) =>
        logins.list(id, force).pipe(Effect.flatMap((credentials) => apply(pool, id, ListLogins.make({ credentials }))))

      /** Take a reading in, and mark the login as needing a sign-in exactly when the reading says so. */
      const take = ({ id, pool }: Pooled, credentialID: string, reading: QuotaReading | undefined) =>
        reading === undefined
          ? Effect.void
          : apply(pool, id, TakeReading.make({ credentialID, reading })).pipe(
              Effect.andThen(logins.markSignIn(id, credentialID, reading.refusal?.kind === "signin")),
            )

      /** The provider's newest reading of one login, as its auth plugin holds it now. */
      const pull = (where: Pooled, credentialID: string) =>
        quota.reading(where.id, credentialID).pipe(Effect.flatMap((reading) => take(where, credentialID, reading)))

      const place = Effect.fn("Pool.place")(function* (input: {
        readonly providerID: string
        readonly sessionID: string
        readonly kind: RequestKind
      }) {
        const where = pooled(input.providerID)
        if (where === undefined) return undefined
        yield* refresh(where, false).pipe(Effect.ignore)
        const events = yield* send(where.pool, where.id, PlaceRequest.make({ sessionID: input.sessionID, kind: input.kind })).pipe(
          Effect.catchTag("NoAccount", () => Effect.succeed([])),
        )
        return events.flatMap((event) => (event._tag === "RequestPlaced" ? [event.credentialID] : []))[0]
      })

      const responded = Effect.fn("Pool.responded")(function* (input: {
        readonly providerID: string
        readonly sessionID: string
        readonly kind: RequestKind
        readonly status: number
      }) {
        if (input.status !== 401 && input.status !== 429) return
        const where = pooled(input.providerID)
        if (where === undefined) return
        const credentialID = placedOn(yield* SynchronizedRef.get(where.pool), input.sessionID, input.kind)
        if (credentialID === undefined) return
        // The reading says for how long; without one (or with one that holds
        // nothing) the refusal holds the login for the default time.
        yield* pull(where, credentialID)
        yield* apply(where.pool, where.id, RefuseRequest.make({ credentialID, status: input.status }))
      })

      const retry = Effect.fn("Pool.retry")(function* (input: { readonly providerID: string; readonly sessionID: string }) {
        const where = pooled(input.providerID)
        if (where === undefined) return false
        const credentialID = placedOn(yield* SynchronizedRef.get(where.pool), input.sessionID, "primary")
        if (credentialID === undefined) return false
        // A refusal that never reached a response (a sign-in that failed before
        // the request went out) is only in the provider's reading.
        if (!held(yield* SynchronizedRef.get(where.pool), credentialID, yield* Clock.currentTimeMillis))
          yield* pull(where, credentialID)
        return shouldFailOver(yield* SynchronizedRef.get(where.pool), input.sessionID, yield* Clock.currentTimeMillis)
      })

      const release = (sessionID: string) =>
        Effect.forEach(every, ({ id, pool }) => apply(pool, id, ReleaseRun.make({ sessionID })), { discard: true })

      const stepEnded = Effect.fn("Pool.stepEnded")(function* (sessionID: string, cost: number) {
        // The step's event names no model: it belongs to the pool that placed the session's newest request.
        let latest: { readonly where: Pooled; readonly at: number } | undefined
        for (const where of every) {
          const at = lastPlacedAt(yield* SynchronizedRef.get(where.pool), sessionID) ?? -1
          if (latest === undefined || at > latest.at) latest = { where, at }
        }
        if (latest === undefined || latest.at < 0) return
        yield* apply(latest.where.pool, latest.where.id, RecordStep.make({ sessionID, cost }))
      })

      const follow = Effect.forEach(
        every,
        (where) => quota.readings(where.id).pipe(Stream.runForEach(({ credentialID, reading }) => take(where, credentialID, reading))),
        { concurrency: "unbounded", discard: true },
      )

      const sweep = Effect.forEach(
        every,
        (where) =>
          Effect.gen(function* () {
            yield* refresh(where, true).pipe(Effect.ignore)
            for (const credentialID of (yield* SynchronizedRef.get(where.pool)).credentials)
              yield* take(where, credentialID, yield* quota.usage(where.id, credentialID))
            yield* apply(where.pool, where.id, PruneLedger.make({}))
          }),
        { discard: true },
      ).pipe(Effect.withSpan("Pool.sweep"))

      const pace = Effect.fn("Pool.pace")(function* (providerID: string) {
        const where = pooled(providerID)
        if (where === undefined) return UNPOOLED
        yield* refresh(where, false)
        for (const credentialID of (yield* SynchronizedRef.get(where.pool)).credentials) yield* pull(where, credentialID)
        const now = yield* Clock.currentTimeMillis
        return poolPace(status(yield* SynchronizedRef.get(where.pool), now), now)
      })

      const poolsStatus = Effect.gen(function* () {
        const answer: Record<string, PoolsStatus[string]> = {}
        for (const { id, pool } of every) {
          const accounts = status(yield* SynchronizedRef.get(pool), yield* Clock.currentTimeMillis)
          const sources = yield* logins.sources(id)
          answer[id] = { accounts, ...(sources.length === 0 ? {} : { sources }) }
        }
        return answer
      }).pipe(Effect.withSpan("Pool.status"))

      return { place, responded, retry, release, stepEnded, follow, sweep, pace, status: poolsStatus }
    }),
  )
