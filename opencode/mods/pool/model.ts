// The pool model's handlers: each gathers what one moment of a request needs
// from the outside systems (the provider's logins, its quota, the ledger), has
// the AccountPool aggregate decide it, and writes what changed to the ledger.
// The aggregate is the one decision entry point, so the stories run exactly
// what these do. The plugin calls these and nothing else.
import { Clock, Context, Effect, Layer, Stream, SynchronizedRef } from "effect"
import { fold } from "@dotfiles/decider/decider"
import {
  AccountPool,
  ListLogins,
  PlaceRequest,
  PruneLedger,
  RecordStep,
  RefuseRequest,
  ReleaseRun,
  restored,
  TakeReading,
  type AccountPoolState,
  type Command,
  type Event,
  type PoolId,
} from "./account-pool.ts"
import { held, lastPlacedAt, placedOn, sessionAccount, shouldFailOver, status, type RequestKind, type Rules } from "./accounts.ts"
import { poolPace, UNPOOLED, type Pace } from "./pace.ts"
import type { QuotaReading } from "./quota.ts"
import { Ledger, Logins, Quota, type LoginsUnavailable } from "./service.ts"
import type {
  Alerts,
  LoginsQuery,
  LostLogin,
  PoolsStatus,
  RefreshOutage,
  SessionAnswer,
  SessionLogins,
  SessionQuery,
  StepLogin,
} from "./status.ts"
import { OUTAGE_AFTER_MS, outage } from "./alerts.ts"

/** The pool's settings, from the plugin's options: its rules (the cache life) and the providers it pools. */
export interface Config extends Rules {
  /** Each pooled provider, by id, to the pool (its integration) whose logins it uses. */
  readonly providers: Readonly<Record<string, PoolId>>
  /** How long every refresh from an outside store must fail before it is an outage; default `OUTAGE_AFTER_MS`. */
  readonly refreshOutageMs?: number
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
      /** How long the request's cache lives when its agent keeps its own lifetime (ms); else the provider's. */
      readonly cacheLifeMs?: number
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
    /** A step of a session ended with its price, in USD as the host reported it, writing the assistant message `messageID`. */
    readonly stepEnded: (sessionID: string, cost: number, messageID?: string) => Effect.Effect<void>
    /** Take in the readings each pool's auth plugin publishes, as they come, until interrupted. */
    readonly follow: Effect.Effect<void>
    /** Read every login's usage, and forget what has expired. */
    readonly sweep: Effect.Effect<void>
    /** Whether a new agent on the provider may start now. */
    readonly pace: (providerID: string) => Effect.Effect<Pace, LoginsUnavailable>
    /** Each pool's accounts, holds and readings, and its outside stores. */
    readonly status: Effect.Effect<PoolsStatus, LoginsUnavailable>
    /** The account a session is on, with its label, hold and reading; nothing when the pool has none to name. */
    readonly session: (query: SessionQuery) => Effect.Effect<SessionAnswer>
    /** Every pool's logins that need a sign-in again, and its outside stores whose refreshes are out. */
    readonly alerts: Effect.Effect<Alerts>
    /** The login each recorded step of a session went out on, oldest first. */
    readonly logins: (query: LoginsQuery) => Effect.Effect<SessionLogins>
  }
>()("dotfiles-opencode/pool/Pool") {}

export const layer = (config: Config) =>
  Layer.effect(
    Pool,
    Effect.gen(function* () {
      const logins = yield* Logins
      const quota = yield* Quota
      const ledger = yield* Ledger
      const rules: Rules = { cacheLifeMs: config.cacheLifeMs }
      const decider = AccountPool(rules)

      /**
       * Have the aggregate decide a command against the pool's state, fold
       * what it records in, and write that to the ledger. Commands on one pool
       * are decided one at a time.
       */
      const send = (pool: SynchronizedRef.SynchronizedRef<AccountPoolState>, id: PoolId, command: Command) =>
        SynchronizedRef.modifyEffect(pool, (state) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => decider.decide(state, command, now)),
            Effect.map((events): readonly [ReadonlyArray<Event>, AccountPoolState] => [events, fold(decider, events, state)]),
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
        readonly cacheLifeMs?: number
      }) {
        const where = pooled(input.providerID)
        if (where === undefined) return undefined
        yield* refresh(where, false).pipe(Effect.ignore)
        const command = PlaceRequest.make({
          sessionID: input.sessionID,
          kind: input.kind,
          ...(input.cacheLifeMs === undefined ? {} : { cacheLifeMs: input.cacheLifeMs }),
        })
        const events = yield* send(where.pool, where.id, command).pipe(
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

      /** The pool that placed the session's newest request, if any did. */
      const newest = Effect.fn(function* (sessionID: string) {
        let latest: { readonly where: Pooled; readonly at: number } | undefined
        for (const where of every) {
          const at = lastPlacedAt(yield* SynchronizedRef.get(where.pool), sessionID) ?? -1
          if (latest === undefined || at > latest.at) latest = { where, at }
        }
        return latest === undefined || latest.at < 0 ? undefined : latest.where
      })

      const stepEnded = Effect.fn("Pool.stepEnded")(function* (sessionID: string, cost: number, messageID?: string) {
        // The step's event names no model: it belongs to the pool that placed the session's newest request.
        const where = yield* newest(sessionID)
        if (where === undefined) return
        yield* apply(where.pool, where.id, RecordStep.make({ sessionID, cost, ...(messageID === undefined ? {} : { messageID }) }))
      })

      const sessionLogins = Effect.fn("Pool.logins")(function* (query: LoginsQuery) {
        const steps: Array<StepLogin & { readonly at: number }> = []
        for (const { id, pool } of every)
          for (const step of (yield* SynchronizedRef.get(pool)).steps)
            if (step.sessionID === query.sessionID && step.messageID !== undefined)
              steps.push({ pool: id, messageID: step.messageID, credentialID: step.credentialID, at: step.at })
        return {
          steps: steps.sort((left, right) => left.at - right.at).map(({ at: _at, ...step }) => step),
        } satisfies SessionLogins
      })

      const session = Effect.fn("Pool.session")(function* (query: SessionQuery) {
        const where = query.providerID === undefined ? yield* newest(query.sessionID) : pooled(query.providerID)
        if (where === undefined) return {}
        const found = sessionAccount(yield* SynchronizedRef.get(where.pool), query.sessionID, yield* Clock.currentTimeMillis, rules)
        if (found === undefined) return {}
        return { account: { pool: where.id, label: yield* logins.label(where.id, found.credentialID), ...found } }
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
        return poolPace(status(yield* SynchronizedRef.get(where.pool), now, rules), now)
      })

      const poolsStatus = Effect.gen(function* () {
        const answer: Record<string, PoolsStatus[string]> = {}
        for (const { id, pool } of every) {
          const accounts = status(yield* SynchronizedRef.get(pool), yield* Clock.currentTimeMillis, rules)
          const sources = yield* logins.sources(id)
          answer[id] = { accounts, ...(sources.length === 0 ? {} : { sources }) }
        }
        return answer
      }).pipe(Effect.withSpan("Pool.status"))

      const alerts = Effect.gen(function* () {
        const lost: Array<LostLogin> = []
        const outages: Array<RefreshOutage> = []
        for (const { id } of every) {
          const now = yield* Clock.currentTimeMillis
          for (const store of yield* logins.refreshes(id)) {
            lost.push(...store.lost.map((login) => ({ pool: id, ...login })))
            const out = outage(store.record, now, config.refreshOutageMs ?? OUTAGE_AFTER_MS)
            if (out !== undefined) outages.push({ pool: id, dir: store.dir, ...out })
          }
        }
        return { lost, outages }
      }).pipe(Effect.withSpan("Pool.alerts"))

      return { place, responded, retry, release, stepEnded, follow, sweep, pace, status: poolsStatus, session, alerts, logins: sessionLogins }
    }),
  )
