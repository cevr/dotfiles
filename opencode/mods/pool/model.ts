// The pool model's handlers: each gathers what one moment of a request needs
// from the outside systems (the provider's logins, its quota, the ledger), has
// the AccountPool aggregate decide it, and writes what changed to the ledger.
// The Fleet aggregate (fleet.ts) keeps this host's starts and its peers'
// reports, which the pace counts, in the FleetStore every instance of the
// plugin on the host shares.
// The aggregate is the one decision entry point, so the stories run exactly
// what these do. The plugin calls these and nothing else.
import { Array as Arr, Clock, Context, Effect, Layer, Match, Option, Predicate, Ref, Scope, Semaphore, Stream, SynchronizedRef } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import {
  AccountPool,
  AccountsHeld,
  ClearHold,
  ListLogins,
  PlaceRequest,
  PruneLedger,
  RecordStep,
  RefuseRequest,
  ReleaseRun,
  ReserveRecovery,
  restored,
  TakeReading,
  type AccountPoolState,
  type Command,
  PoolId,
} from "./account-pool.ts"
import { answeredOn, held, lastPlacedAt, placedOn, sessionAccount, status, type RequestKind, type Rules } from "./accounts.ts"
import * as Burn from "./burn.ts"
import * as FleetModel from "./fleet.ts"
import { dispatchPace, evidenceGap, needsSignIn, nextRetryAt, poolPace, refreshEvidence, RequestHeld, requiredScopes, storeHeld, UNPOOLED, UNREAD_RETRY_MS, type DispatchPolicy, type Pace } from "./pace.ts"
import { type Hold, holdRecheckAt, type RecoveryAttempt, UNREADABLE_HOLD_MS } from "./hold.ts"
import { limitsLine, weeklyRatios, type Tally, type Tokens } from "./limits.ts"
import type { AccountStatus } from "./status.ts"
import { USAGE_TIMEOUT_MS, type ClaimAnswer, type QuotaReading, type QuotaWindow } from "./quota.ts"
import * as Lease from "./lease.ts"
import type { LeaseAnswer, LeaseMessage } from "./lease.ts"
import * as ResetsModel from "./resets.ts"
import type { ResetProvider } from "./resets.ts"
import { FleetStore, Ledger, Limits, Logins, Owner, Peers, PushStore, Quota, ResetsStore, Workload, type LoginsUnavailable } from "./service.ts"
import * as PushModel from "./push.ts"
import { used as usedOf } from "./usage-text.ts"
import type { PushAnswer, PushRequest } from "./push.ts"

/** A failure's type, as OpenCode names it, and the refusal's status it stands for. */
const REFUSED_STATUS = new Map([
  ["Authentication", 401],
  ["RateLimit", 429],
  ["QuotaExceeded", 429],
])
import type {
  Alerts,
  FleetStatus,
  Report,
  SharedReading,
  LoginsQuery,
  LostLogin,
  PoolsStatus,
  RefreshOutage,
  ResetsStatus,
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
  /**
   * Providers whose pace a pool measures without placing their requests: the
   * provider's own login chooses the account (OpenAI's ChatGPT login), and the
   * pool only reads its quota. A provider in `providers` is placed as well.
   */
  readonly paced?: Readonly<Record<string, PoolId>>
  /** This host in the fleet, and what an admitted agent costs the pace until it settles; default `DEFAULT_FLEET`. */
  readonly fleet?: FleetConfig
  /**
   * The pools whose rate-limit resets the pool works, by pool, and whose they
   * are: a Claude pool's grants are asked about, a Codex pool's credits
   * claimed (resets.ts). A pool not named has its resets left alone.
   */
  readonly resets?: Readonly<Record<string, ResetProvider>>
  /** Whether resets are claimed with no one asked (resets.ts `Review.auto`); default true. False: only on the owner's yes. */
  readonly autoClaims?: boolean
  /** What one queued orchestrate unit is taken to cost, as a share of one account's week, for a push plan's need; default push.ts `UNIT_COST`. */
  readonly unitCost?: number
}

export interface FleetConfig {
  /** This host's name in its reports. */
  readonly host: string
  /** How long an admitted agent counts on the pace before its spend shows in a reading (ms). */
  readonly settleMs: number
  /** What it counts meanwhile: a share of one account's week, 0 to 1. */
  readonly startCost: number
  /** How often the host reads each peer (ms): the plugin's instances on the host share the reads. */
  readonly pollMs: number
  /** How long a claim's lease holds without a release (ms; lease.ts `LEASE_MS`). */
  readonly leaseMs?: number
  /** How long a host waits for a peer's lease answer before it passes the peer over (ms; lease.ts `LEASE_WAIT_MS`). */
  readonly leaseWaitMs?: number
}

/**
 * Ten minutes covers a reading's lag: the auth plugin reads after each
 * response and the sweep every ten minutes. Half a percentage point of one
 * account's week is about an agent's first ten minutes: the orchestrate
 * skill's Codex budget measures 0.4 to 0.6 %/h per role.
 */
export const DEFAULT_FLEET: FleetConfig = { host: "this host", settleMs: 10 * 60_000, startCost: 0.005, pollMs: 30_000 }

/** The pool whose quota paces a provider: the one it is placed through, else the one it is only measured through. */
const measuredBy = (config: Config, providerID: string): PoolId | undefined =>
  Object.hasOwn(config.providers, providerID)
    ? config.providers[providerID]
    : config.paced !== undefined && Object.hasOwn(config.paced, providerID)
      ? config.paced[providerID]
      : undefined

/** Where a request goes out, and the lifetime its cache is written for when its agent keeps its own (ms). */
export interface Placed {
  readonly credentialID: string
  readonly cacheLifeMs?: number
}

/**
 * What a step used, for the limit tally: its model, its tokens, and, for a
 * provider only paced (never placed), the login the host sent it on.
 */
export interface StepUsage {
  readonly providerID: string
  readonly model: string
  readonly tokens: Tokens
  readonly credentialID?: string
}

/** The limits method's answer: the tally and its line, when the pool keeps one. */
export interface LimitsAnswer {
  readonly tally?: Tally
  readonly line?: string
}

/** The pools a config names: each integration once, in the order the providers name them, then the paced ones. */
export const poolsOf = (config: Config): ReadonlyArray<PoolId> => [
  ...new Set([...Object.values(config.providers), ...Object.values(config.paced ?? {})]),
]

export interface PlaceInput {
  readonly providerID: string
  readonly sessionID: string
  readonly kind: RequestKind
  readonly model?: string
  readonly cacheLifeMs?: number
  readonly cacheOf?: string
  /** An already signed ping cannot move to a different login. */
  readonly keepalive?: boolean
}

export class Pool extends Context.Service<
  Pool,
  {
    /**
     * A model request goes out: the login it goes out on, and the lifetime its
     * cache is written for when its agent keeps its own (the provider's once
     * the session has outlived it); none when the provider is not pooled or
     * lists no login. Every account held refuses it: `AccountsHeld`, with when the first opens. A request the
     * pace holds for its model (the one rule a start's pace answers, at this dispatch, every retry, follow-up,
     * continued run and auxiliary request alike) goes out on none: `RequestHeld`, with why and when to ask again.
     * Admitted, it goes out on an account eligible for its model, the run's pin and its cache's only when eligible.
     */
    readonly place: (input: {
      readonly providerID: string
      readonly sessionID: string
      readonly kind: RequestKind
      /** The model the request asks for: a window of its own (`7d:Fable`) holds it too. */
      readonly model?: string
      /** How long its agent keeps the request's cache when it keeps its own lifetime (ms); else the provider's. */
      readonly cacheLifeMs?: number
      /** The session whose cache the request reads when the session has none of its own: a fork's source. */
      readonly cacheOf?: string
    }) => Effect.Effect<Placed | undefined, AccountsHeld | RequestHeld>
    /** Confirm a prepared login from this activation against the current hold store. */
    readonly confirmed: (input: PlaceInput, candidate: string, onAdmission?: Effect.Effect<void>) => Effect.Effect<boolean, RequestHeld>
    /** Admit the actual login of a provider whose credential the host selects. */
    readonly admitActive: (input: PlaceInput, candidate: string, phase: "known-hold" | "send" | "signed-out", onAdmission?: Effect.Effect<void>) => Effect.Effect<void, RequestHeld>
    /** A response came back. A refusal (401 or 429) holds the login it went out on. */
    readonly responded: (input: {
      readonly providerID: string
      readonly sessionID: string
      readonly kind: RequestKind
      readonly status: number
      readonly credentialID?: string
    }) => Effect.Effect<void>
    /**
     * A primary request failed: whether it should go again at once, on another login. `error` is the failure's type
     * as OpenCode names it (`Authentication`, `RateLimit`, `QuotaExceeded`, ...).
     */
    readonly retry: (input: { readonly providerID: string; readonly sessionID: string; readonly error?: string }) => Effect.Effect<boolean>
    /** A session went idle: its run ends in every pool. */
    readonly release: (sessionID: string) => Effect.Effect<void>
    /**
     * A step of a session ended with its price, in USD as the host reported it,
     * writing the assistant message `messageID`; with `usage`, its tokens count
     * in the limit tally on the account the step went out on.
     */
    readonly stepEnded: (sessionID: string, cost: number, messageID?: string, usage?: StepUsage) => Effect.Effect<void>
    /** The limit tally (limits.ts) and its line; none when the pool keeps no tally. */
    readonly limits: Effect.Effect<LimitsAnswer>
    /** Take in the readings each pool's auth plugin publishes, as they come, until interrupted. */
    readonly follow: Effect.Effect<void>
    /** Read every login's usage, and forget what has expired. */
    readonly sweep: Effect.Effect<void>
    /**
     * Whether a new agent on the provider may start now; of `model`, when
     * named, so a window of that model's own (`7d:Fable`) can hold it too. With `dispatch`, the pace of a
     * request about to go out (`place`): the fleet's unsettled starts are not counted again.
     */
    readonly pace: (providerID: string, model?: string, sessionID?: string, dispatch?: boolean) => Effect.Effect<Pace, LoginsUnavailable>
    /** Each pool's accounts, holds and readings, and its outside stores. */
    readonly status: Effect.Effect<PoolsStatus, LoginsUnavailable>
    /** The account a session is on, with its label, hold and reading; nothing when the pool has none to name. */
    readonly session: (query: SessionQuery) => Effect.Effect<SessionAnswer>
    /** Every pool's logins that need a sign-in again, and its outside stores whose refreshes are out. */
    readonly alerts: Effect.Effect<Alerts>
    /** The login each recorded step of a session went out on, oldest first. */
    readonly logins: (query: LoginsQuery) => Effect.Effect<SessionLogins>
    /** A new agent was admitted on the provider: it counts on the pace, here and on the peers, until it settles. */
    readonly started: (providerID: string) => Effect.Effect<void>
    /** A step of a session started on the provider: the session is busy, an agent running, until it goes idle (`release`). */
    readonly stepStarted: (sessionID: string, providerID: string) => Effect.Effect<void>
    /** What this host tells a peer: its starts that still count, its busy sessions' providers and its readings. */
    readonly report: Effect.Effect<Report>
    /**
     * Read every peer not read in the last half `pollMs` by any instance on
     * the host. One that cannot be read is logged when it stops answering, and
     * the pace goes on without it.
     */
    readonly poll: Effect.Effect<void>
    /** This host's starts and each peer, for the pane. */
    readonly fleet: Effect.Effect<FleetStatus>
    /**
     * Work the resets: clear the notices the owner read (and any older
     * question under the pool), then have the Resets aggregate review every
     * pool, and carry out what it decides: it claims a due reset by itself
     * (unless `autoClaims` is false), asking nothing, and notes or withdraws
     * its notices. The sweep and a held pace run it.
     */
    readonly reviewResets: Effect.Effect<void>
    /** Read the owner's answers each time the questions change, until interrupted. */
    readonly followAnswers: Effect.Effect<void>
    /** The resets being worked and the claims made, for the pane. */
    readonly resets: Effect.Effect<ResetsStatus>
    /** Answer a peer's lease message (lease.ts): grant or refuse an account's claim lease, or take its release. */
    readonly lease: (message: LeaseMessage) => Effect.Effect<LeaseAnswer>
    /**
     * The owner's session starts, ends, reads or plans a push (push.ts
     * `PushRequest`); one for a peer goes to that peer. The answer says what
     * it did, with the plan measured from the pool.
     */
    readonly push: (request: PushRequest) => Effect.Effect<PushAnswer>
    /**
     * Work the pushes: end those past their end or whose run closed. It asks
     * nothing; a push starts only when the owner's session asks for one
     * (`push`). The sweep runs it.
     */
    readonly reviewPushes: Effect.Effect<void>
  }
>()("dotfiles-opencode/pool/Pool") {}

/** The pushes in this process alone, for a pool built without a PushStore. */
const processPushes = Effect.gen(function* () {
  const ref = yield* Ref.make(PushModel.empty)
  return { read: Ref.get(ref), record: (_events: ReadonlyArray<PushModel.Event>, state: PushModel.PushState) => Ref.set(ref, state) }
})

/** How long after a start held for lack of quota in a push's scope the pace asks to be asked again: the push's claim takes seconds. */
export const PUSH_RETRY_MS = 60_000

/** A busy session not heard of (no step started) for this long lost its idle event: it no longer counts as running. */
export const BUSY_MS = 60 * 60_000
/** The whole provider evidence round, not a timeout paid once per stale login. */
const DISPATCH_EVIDENCE_MS = 20_000
const QUOTE_EVIDENCE_MS = 2_000

export const layer = (config: Config) =>
  Layer.effect(
    Pool,
    Effect.gen(function* () {
      const logins = yield* Logins
      const quota = yield* Quota
      const ledger = yield* Ledger
      const peers = yield* Peers
      const fleetStore = yield* FleetStore
      const rules: Rules = { cacheLifeMs: config.cacheLifeMs }
      const decider = AccountPool(rules)
      const fleetConfig = config.fleet ?? DEFAULT_FLEET
      // The fleet is decided one command at a time in this instance; another instance's write between a read and a record loses nothing, a start being a key of its own.
      const fleetLock = yield* Semaphore.make(1)
      const resetsStore = yield* ResetsStore
      const owner = yield* Owner
      // The limit tally is optional: a pool built without it tallies nothing.
      const limits = Option.getOrUndefined(yield* Effect.serviceOption(Limits))
      const scope = yield* Scope.Scope
      // The host's leases and locks are shared by all its directory instances.
      const leases = Option.getOrElse(yield* Effect.serviceOption(Lease.Leases), () => Lease.HOST)
      // One request of this instance at a time is admitted and placed, so two never read the same room before either reserves it.
      const dispatchLock = yield* Semaphore.make(1)
      let spendSeq = 0
      // One review at a time: a review carries out claims, which take seconds.
      const reviewing = yield* Semaphore.make(1)
      // The pushes are the host's when it keeps them (every instance reads the same), else this process's.
      const pushStore = Option.getOrUndefined(yield* Effect.serviceOption(PushStore)) ?? (yield* processPushes)
      const pushLock = yield* Semaphore.make(1)
      // What the host is doing: optional, a plan goes without its load and runs.
      const workload = Option.getOrUndefined(yield* Effect.serviceOption(Workload))

      /**
       * Have the aggregate decide a command against the pool's state, fold
       * what it records in, and write that to the ledger. Commands on one pool
       * are decided one at a time.
       */
      const send = (pool: SynchronizedRef.SynchronizedRef<AccountPoolState>, id: PoolId, command: Command) => {
        const changesHolds = Predicate.isTagged(command, "TakeReading") || Predicate.isTagged(command, "RefuseRequest") ||
          Predicate.isTagged(command, "PruneLedger") || Predicate.isTagged(command, "ClearHold") || Predicate.isTagged(command, "ReserveRecovery")
        const applyCommand = SynchronizedRef.modifyEffect(pool, (state) =>
          Effect.gen(function* () {
            let current = state
            let shared = Option.none<"unknown">()
            if (changesHolds) {
              const known = yield* Effect.option(ledger.holds(id))
              if (Option.isSome(known)) current = { ...state, holds: known.value }
              else {
                if (Predicate.isTagged(command, "ReserveRecovery")) return [{ events: [], shared }, state] as const
                shared = Option.some("unknown")
              }
            }
            const events = yield* decider.decide(current, command, yield* Clock.currentTimeMillis)
            return [{ events, shared }, fold(decider, events, current)] as const
          }),
        ).pipe(
          Effect.tap(({ events, shared }) => Option.match(shared, {
            onNone: () => events.length === 0 ? Effect.void : ledger.record(id, events),
            onSome: (unread) => ledger.record(id, events, unread),
          })),
          Effect.map(({ events }) => events),
        )
        if (changesHolds) return ledger.withHolds(applyCommand)
        return applyCommand
      }

      /** `send`, for a command that declares no rejection: only PlaceRequest can be refused. */
      const apply = (pool: SynchronizedRef.SynchronizedRef<AccountPoolState>, id: PoolId, command: Exclude<Command, PlaceRequest>) =>
        send(pool, id, command).pipe(Effect.catchTags({ NoAccount: Effect.die, AccountsHeld: Effect.die }))

      const pools = new Map<PoolId, SynchronizedRef.SynchronizedRef<AccountPoolState>>()
      for (const id of poolsOf(config)) {
        const pool = yield* SynchronizedRef.make(restored(yield* ledger.restore(id)))
        yield* apply(pool, id, PruneLedger.make({}))
        pools.set(id, pool)
      }

      const poolOf = (id: PoolId | undefined) => {
        const pool = id === undefined ? undefined : pools.get(id)
        return id === undefined || pool === undefined ? undefined : { id, pool }
      }
      /** The pool a provider's requests are placed through, if it has one. */
      const pooled = (providerID: string) => poolOf(Object.hasOwn(config.providers, providerID) ? config.providers[providerID] : undefined)
      type Pooled = NonNullable<ReturnType<typeof poolOf>>
      const every = [...pools].map(([id, pool]): Pooled => ({ id, pool }))
      const inventoried = new Set<PoolId>()

      /** The provider's logins, read again when the list is old (or `force`d). */
      const refresh = ({ id, pool }: Pooled, force: boolean) =>
        logins.list(id, force).pipe(Effect.flatMap((credentials) => Effect.gen(function* () {
          const previous = yield* SynchronizedRef.get(pool)
          yield* apply(pool, id, ListLogins.make({ credentials }))
          if (!inventoried.has(id) || previous.credentials.length !== credentials.length || previous.credentials.some((known) => !credentials.includes(known))) {
            yield* apply(pool, id, PruneLedger.make({ listed: credentials }))
            inventoried.add(id)
          }
        })))

      /** Take a reading in, and mark the login as needing a sign-in exactly when the reading says so. */
      const take = ({ id, pool }: Pooled, credentialID: string, reading: QuotaReading | undefined, freshUsage = false, recovery?: RecoveryAttempt) =>
        reading === undefined
          ? Effect.void
          : apply(pool, id, TakeReading.make({ credentialID, reading, freshUsage,
              ...Option.match(Option.fromUndefinedOr(recovery), { onNone: () => ({}), onSome: (recovery) => ({ recovery }) }),
            })).pipe(
              Effect.andThen(logins.markSignIn(id, credentialID, reading.refusal?.kind === "signin")),
              Effect.andThen(limits?.observe(id, credentialID, reading) ?? Effect.void),
              Effect.andThen(observeClaim(id, credentialID, reading)),
            )

      const readUsage = (where: Pooled, credentialID: string, recovery: boolean, signIn = Option.none<true>()) => {
        if (!recovery) return quota.usage(where.id, credentialID).pipe(Effect.flatMap((reading) => take(where, credentialID, reading, true)))
        return Effect.gen(function* () {
          // Reserve the appointment in the shared ledger before leaving its lock for provider I/O.
          const input = Option.match(signIn, { onNone: () => ({ credentialID }), onSome: (signIn) => ({ credentialID, signIn }) })
          const events = yield* apply(where.pool, where.id, ReserveRecovery.make(input))
          const reserved = Arr.findFirst(events, (event) => Predicate.isTagged(event, "RecoveryScheduled"))
          if (Option.isNone(reserved)) return
          const at = yield* Clock.currentTimeMillis
          const usage = yield* quota.usage(where.id, credentialID).pipe(Effect.timeoutOption(UNREADABLE_HOLD_MS))
          if (Option.isSome(usage)) yield* take(where, credentialID, usage.value, true, { at, until: holdRecheckAt(reserved.value.hold) })
        })
      }

      const placedPools = new Set(Object.values(config.providers))
      const measureFirst = (where: Pooled, credentialID: string) => Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(where.pool)
        if (Object.hasOwn(current.readings, credentialID)) return
        const measure = Effect.gen(function* () {
          const sampled = yield* quota.usage(where.id, credentialID).pipe(Effect.timeoutOption(USAGE_TIMEOUT_MS))
          const fresh = Option.flatMap(sampled, Option.fromUndefinedOr)
          if (Option.isSome(fresh)) yield* take(where, credentialID, fresh.value, true)
          return fresh
        })
        const reading = yield* ledger.firstReading(where.id, credentialID, measure)
        if (Option.isSome(reading)) yield* SynchronizedRef.update(where.pool, (state) => {
          if (Object.hasOwn(state.readings, credentialID)) return state
          return { ...state, readings: { ...state.readings, [credentialID]: reading.value } }
        })
      })

      /** Any directory can offer a reading to the pending claim on the shared host ledger. */
      const resetProvider = (pool: string) =>
        Option.flatMap(Option.fromUndefinedOr(config.resets), (pools) => Option.fromUndefinedOr(pools[pool]))
      const observeClaim = (pool: PoolId, credentialID: string, reading: QuotaReading) =>
        Option.match(resetProvider(pool), {
          onNone: () => Effect.void,
          onSome: (provider) => {
            // A carried week or a week still at its maximum cannot show a refund.
            if (!reading.windows.some((window) => window.name === "7d" && window.utilization < 1 && Option.isNone(Option.fromUndefinedOr(window.at)))) return Effect.void
            return sendResets(ResetsModel.ObserveClaim.make({ pool, provider, credentialID, windows: reading.windows, at: reading.at })).pipe(Effect.asVoid)
          },
        })

      /** The provider's newest reading of one login, as its auth plugin holds it now. */
      const pull = (where: Pooled, credentialID: string) =>
        quota.reading(where.id, credentialID).pipe(Effect.flatMap((reading) => take(where, credentialID, reading)))

      const admission = Effect.fn("Pool.admission")(function* (input: PlaceInput) {
        // The request's admission, at its dispatch: the pace a request of its model gets on the readings now (`dispatchPace`).
        // Held, it goes out on no login; the review has heard of the held work.
        const auxiliary = Option.filter(Option.some(input.kind), (kind) => kind !== "primary" && kind !== "compaction")
        const policy = Option.match(auxiliary, { onNone: () => ({}), onSome: (kind) => ({ auxiliary: kind }) })
        const asked = yield* Effect.option(pace(input.providerID, input.model, input.sessionID, true, policy, "existing-request"))
        const now = yield* Clock.currentTimeMillis
        if (Option.isNone(asked))
          return yield* new RequestHeld({
            sessionID: input.sessionID,
            reason: "the pool's logins could not be listed",
            reasonCode: "logins-unavailable",
            retryAt: now + UNREAD_RETRY_MS,
          })
        const answer = asked.value
        if (!answer.ok) {
          const retryAt = Option.getOrElse(Option.filter(Option.some(answer.retryAt), () => answer.reasonCode === "record-unreadable"),
            () => nextRetryAt(now, [answer.retryAt]))
          const signIn = Option.fromUndefinedOr(answer.signIn)
          if (Option.isSome(signIn)) return yield* new AccountsHeld({ sessionID: input.sessionID, kind: input.kind, retryAt, signIn: signIn.value })
          return yield* new RequestHeld({ sessionID: input.sessionID, reason: answer.reason, reasonCode: answer.reasonCode, retryAt })
        }
        return answer
      })

      const place = Effect.fn("Pool.place")(function* (input: PlaceInput) {
        const where = pooled(input.providerID)
        if (where === undefined) return undefined
        const answer = yield* admission(input)
        const now = yield* Clock.currentTimeMillis
        const command = PlaceRequest.make({
          sessionID: input.sessionID,
          kind: input.kind,
          ...(input.cacheLifeMs === undefined ? {} : { cacheLifeMs: input.cacheLifeMs }),
          ...(input.cacheOf === undefined ? {} : { cacheOf: input.cacheOf }),
          eligible: Option.getOrElse(Option.fromUndefinedOr(answer.eligible), () => []),
        })
        const events = yield* send(where.pool, where.id, command).pipe(
          Effect.catchTag("NoAccount", () => Effect.succeed([])),
        )
        const placed = Arr.findFirst(
          events.flatMap((event): ReadonlyArray<Placed> =>
            event._tag === "RequestPlaced"
              ? [{ credentialID: event.credentialID, ...(event.cacheLifeMs === undefined ? {} : { cacheLifeMs: event.cacheLifeMs }) }]
              : [],
          ),
          () => true,
        )
        // On a claim's room, the request reserves its share on the account it goes out on before it goes.
        if (Option.isNone(placed)) return yield* new RequestHeld({
          sessionID: input.sessionID,
          reason: "no login that passed the dispatch check is still available",
          reasonCode: "placement-changed",
          retryAt: now + UNREAD_RETRY_MS,
        })
        if (answer.admission === "backed") yield* reserve(where, placed.value.credentialID, input.sessionID)
        return Option.getOrUndefined(placed)
      }, (effect) => dispatchLock.withPermits(1)(effect))

      const currentHolds = ({ id, pool }: Pooled) =>
        ledger.holds(id).pipe(Effect.flatMap((holds) => SynchronizedRef.updateAndGet(pool, (state) => ({ ...state, holds }))))

      const checkSend = <A>(input: PlaceInput, view: ReturnType<typeof currentHolds>, decide: (state: AccountPoolState, now: number) => Effect.Effect<A>) =>
        ledger.withHolds(Effect.gen(function* () {
          const current = yield* view.pipe(Effect.catch((failure) => Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            return yield* new RequestHeld({ sessionID: input.sessionID, ...storeHeld(failure.retryAt, now) })
          })))
          return yield* decide(current, yield* Clock.currentTimeMillis)
        }).pipe(Effect.withSpan("Pool.checkSend.read"))).pipe(Effect.withSpan("Pool.checkSend"))

      const confirmed = Effect.fn("Pool.confirmed")(function* (input: PlaceInput, candidate: string, onAdmission: Effect.Effect<void> = Effect.void) {
        const where = Option.fromUndefinedOr(pooled(input.providerID))
        if (Option.isNone(where)) return false
        return yield* checkSend(input, currentHolds(where.value), (current, now) => {
          const allowed = (input.keepalive === true || placedOn(current, input.sessionID, input.kind) === candidate) &&
            !held(current, candidate, now) &&
            status(current, now, rules).some((account) => account.credentialID === candidate && !needsSignIn(account))
          if (!allowed) return Effect.succeed(false)
          return Effect.as(onAdmission, true)
        })
      })

      const rejectActive = (input: PlaceInput, hold: Option.Option<Hold>, now: number, ends: ReadonlyArray<number>) =>
        RequestHeld.make({
          sessionID: input.sessionID,
          reason: Option.match(hold, { onNone: () => "the active login has a spent window", onSome: ({ kind }) => `the active login is held (${kind})` }),
          reasonCode: Option.getOrElse(Option.map(Option.filter(hold, ({ kind }) => kind === "record-unreadable"), () => "record-unreadable" as const), () => "account-held"),
          retryAt: nextRetryAt(now, ends),
        })

      // The wire gate uses durable holds and recorded readings, not a new
      // launch/placement quote. Provider I/O is only for a due appointment,
      // outside the shared hold lock. Admission retires the previous send
      // record inside that lock, never before the final decision.
      const admitActive = Effect.fn("Pool.admitActive")(function* (input: PlaceInput, candidate: string, phase: "known-hold" | "send" | "signed-out", onAdmission: Effect.Effect<void> = Effect.void) {
        const binding = Option.fromUndefinedOr(poolOf(measuredBy(config, input.providerID)))
        if (Option.isNone(binding)) return yield* ledger.withHolds(onAdmission)
        const where = binding.value
        if (phase === "send" && !placedPools.has(where.id)) yield* measureFirst(where, candidate)
        const exact = ledger.holds(where.id, candidate).pipe(
          Effect.flatMap((holds) => SynchronizedRef.get(where.pool).pipe(Effect.map((state) => ({ ...state, holds })))),
        )
        const check = (allowRefresh: boolean) => checkSend(input, exact, (current, now) => {
          const hold = Option.filter(Option.fromUndefinedOr(current.holds[candidate]), () => held(current, candidate, now))
          const reading = Option.filter(Option.fromUndefinedOr(current.readings[candidate]), () => phase === "send")
          const spent = Option.match(reading, { onNone: () => [], onSome: ({ windows }) => windows.flatMap((window) => {
            if (window.utilization < 1 || (window.name !== "5h" && window.name !== "7d" && window.name !== `7d:${input.model}`)) return []
            return Option.toArray(Option.filter(Option.fromUndefinedOr(window.resetAt), (at) => at > now))
          }) })
          const due = Option.filter(hold, (row) => allowRefresh && phase === "send" && row.until <= now)
          const blocking = Option.filter(hold, (row) => {
            if (phase === "signed-out") return row.kind === "signin"
            return phase === "send" || row.until > now
          })
          const decision = { now, due, blocking, spent }
          if (Option.isSome(due) || Option.isSome(blocking) || spent.length > 0) return Effect.succeed(decision)
          return Effect.as(onAdmission, decision)
        })
        const view = yield* Effect.result(check(true))
        if (view._tag === "Failure") {
          if (phase === "send") return yield* view.failure
          return yield* ledger.withHolds(onAdmission)
        }
        let checked = view.success
        // Ordinary refusals expire. Sign-in and damaged rows instead make
        // appointments; reserve them durably before provider I/O.
        if (Option.isSome(checked.due)) {
          const forceSignIn = Option.filter(Option.some(true as const), () => Option.exists(checked.due, ({ kind }) => kind === "signin"))
          yield* readUsage(where, candidate, true, forceSignIn)
          checked = yield* check(false)
        }
        const hold = checked.blocking
        if (Option.isSome(hold) || checked.spent.length > 0) {
          const ends = [...Option.toArray(Option.map(hold, holdRecheckAt)), ...checked.spent]
          return yield* rejectActive(input, hold, checked.now, ends)
        }
      })

      /**
       * Reserve one request's share (`fleet.startCost`) of the room the account's claim gave back (resets.ts `Spend`),
       * then read every reservation on it back: a share that does not fit beside the others, this instance's or another's
       * on the host, is taken back and the request held. Written first and read after, so of two instances that race, a
       * share either sees the other's or is seen by it; a write that failed is not read back, and holds.
       */
      const reserve = (where: Pooled, credentialID: string, sessionID: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const before = yield* resetsStore.read
          const refuse = (reason: string) => new RequestHeld({ sessionID, reason, reasonCode: "reset-room", retryAt: now + UNREAD_RETRY_MS })
          // The login's account and its pool's reset provider, and the claim whose room the request is admitted on.
          const found = Option.all([
            Option.fromUndefinedOr(config.resets?.[where.id]),
            Arr.findFirst(status(yield* SynchronizedRef.get(where.pool), now, rules), (item) => item.credentialID === credentialID),
          ]).pipe(
            Option.flatMap(([provider, account]) =>
              Option.fromUndefinedOr(ResetsModel.pacePlans(provider, [account], before.claims, now, before.spends)[credentialID]).pipe(
                Option.flatMap((plan) => Option.fromUndefinedOr(plan.rebase)),
                Option.flatMap((rebase) => Option.fromUndefinedOr(rebase.key)),
                Option.map((claim) => ({ provider, account, claim })),
              ),
            ),
          )
          if (Option.isNone(found)) return yield* refuse("the room a claimed reset gave back on the chosen login could not be found to reserve on")
          const { provider, account, claim } = found.value
          spendSeq += 1
          const spend: ResetsModel.Spend = { id: `${fleetConfig.host}:${sessionID}:${now}:${spendSeq}`, claim, credentialID, at: now, cost: fleetConfig.startCost }
          yield* sendResets(ResetsModel.ReserveSpend.make({ spend }))
          if (ResetsModel.reservationHolds(yield* resetsStore.read, provider, account, now, spend.id)) return
          yield* sendResets(ResetsModel.WithdrawSpend.make({ id: spend.id }))
          return yield* refuse("the room a claimed reset gave back on the chosen login is reserved by requests admitted meanwhile")
        })

      /**
       * The login a session's request of `kind` went out on: as this copy placed it, else as the ledger has it now. A
       * copy a restart closed may still place a request it was asked for before (its turn waited on a login's read) and
       * record its mark after this copy restored the ledger; its answer comes back here, and the mark still names it.
       */
      const answeredHere = (where: Pooled, sessionID: string, kind: RequestKind) =>
        Effect.gen(function* () {
          const own = answeredOn(yield* SynchronizedRef.get(where.pool), sessionID, kind)
          if (Option.isSome(own)) return own
          return answeredOn(restored(yield* ledger.restore(where.id)), sessionID, kind)
        })

      const responded = Effect.fn("Pool.responded")(function* (input: {
        readonly providerID: string
        readonly sessionID: string
        readonly kind: RequestKind
        readonly status: number
        readonly credentialID?: string
      }) {
        if (input.status !== 401 && input.status !== 429) return
        const where = pooled(input.providerID)
        if (where === undefined) return
        const answered = yield* Option.match(Option.fromUndefinedOr(input.credentialID), {
          onNone: () => answeredHere(where, input.sessionID, input.kind),
          onSome: (id) => Effect.succeed(Option.some(id)),
        })
        if (Option.isNone(answered)) return
        const credentialID = answered.value
        // The reading says for how long; without one (or with one that holds
        // nothing) the refusal holds the login for the default time.
        yield* pull(where, credentialID)
        yield* apply(where.pool, where.id, RefuseRequest.make({ credentialID, status: input.status }))
      })

      const retry = Effect.fn("Pool.retry")(function* (input: { readonly providerID: string; readonly sessionID: string; readonly error?: string }) {
        const where = pooled(input.providerID)
        if (where === undefined) return false
        // A request placed before a restart is answered after it: the ledger's mark names its account.
        const answered = yield* answeredHere(where, input.sessionID, "primary")
        // A refused sign-in (401) on a login this copy cannot name (placed before a restart, its mark since pruned)
        // goes again, placed afresh: on a login not held, or else the pool refuses it in its own words (a sign-in to
        // make, when the first opens), never the provider's. Another refusal (429) stays the host's to retry: placed
        // afresh it could go out again on the login that just refused it.
        if (Option.isNone(answered)) return input.error === "Authentication"
        const credentialID = answered.value
        // A refusal that never reached a response (a sign-in that failed before
        // the request went out) is only in the provider's reading.
        if (!held(yield* SynchronizedRef.get(where.pool), credentialID, yield* Clock.currentTimeMillis))
          yield* pull(where, credentialID)
        // A refusal whose response this copy never saw (it came back to the copy a restart closed) holds the login
        // here, as `responded` would have.
        const status = Option.fromNullishOr(REFUSED_STATUS.get(input.error ?? ""))
        if (Option.isSome(status) && !held(yield* SynchronizedRef.get(where.pool), credentialID, yield* Clock.currentTimeMillis))
          yield* apply(where.pool, where.id, RefuseRequest.make({ credentialID, status: status.value }))
        return held(yield* SynchronizedRef.get(where.pool), credentialID, yield* Clock.currentTimeMillis)
      })

      /**
       * The sessions busy on this host, by id: the provider of the newest step
       * each started and when. A session is busy from a step's start until it
       * goes idle; one not heard of for BUSY_MS lost its idle event and runs
       * no more. Kept in memory: after a restart a session counts again at its
       * next step. Every copy of the plugin on the host hears every session's
       * events, so each holds the host's whole.
       */
      const busySessions = new Map<string, { readonly providerID: string; readonly at: number }>()

      const stepStarted = (sessionID: string, providerID: string) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          busySessions.set(sessionID, { providerID, at })
        })

      /** The provider of each session busy on this host now. */
      const busyNow = (now: number): ReadonlyArray<string> => {
        for (const [sessionID, entry] of busySessions) if (entry.at <= now - BUSY_MS) busySessions.delete(sessionID)
        return [...busySessions.values()].map((entry) => entry.providerID)
      }

      const release = (sessionID: string) =>
        Effect.suspend(() => {
          busySessions.delete(sessionID)
          return Effect.forEach(every, ({ id, pool }) => apply(pool, id, ReleaseRun.make({ sessionID })), { discard: true })
        })

      /** The pool that placed the session's newest request, if any did. */
      const newest = Effect.fn("Pool.newest")(function* (sessionID: string) {
        let latest: { readonly where: Pooled; readonly at: number } | undefined
        for (const where of every) {
          const at = lastPlacedAt(yield* SynchronizedRef.get(where.pool), sessionID) ?? -1
          if (latest === undefined || at > latest.at) latest = { where, at }
        }
        return latest === undefined || latest.at < 0 ? undefined : latest.where
      })

      /**
       * A step's tokens in the limit tally, on the account it went out on: the
       * session's primary placement in a placed pool, the login the host named
       * in a pool only paced. Nothing without a message to key it by.
       */
      const tallyStep = Effect.fn("Pool.tallyStep")(function* (sessionID: string, messageID: string, usage: StepUsage) {
        if (limits === undefined) return
        const at = yield* Clock.currentTimeMillis
        const placed = pooled(usage.providerID)
        const id = placed?.id ?? measuredBy(config, usage.providerID)
        const credentialID =
          placed === undefined ? usage.credentialID : placedOn(yield* SynchronizedRef.get(placed.pool), sessionID, "primary")
        if (id === undefined || credentialID === undefined) return
        yield* limits.use(messageID, { at, pool: id, credentialID, model: usage.model, tokens: usage.tokens })
      })

      const stepEnded = Effect.fn("Pool.stepEnded")(function* (sessionID: string, cost: number, messageID?: string, usage?: StepUsage) {
        if (messageID !== undefined && usage !== undefined) yield* tallyStep(sessionID, messageID, usage)
        // The step's event names no model: it belongs to the pool that placed the session's newest request.
        const where = yield* newest(sessionID)
        if (where === undefined) return
        yield* apply(where.pool, where.id, RecordStep.make({ sessionID, cost, ...(messageID === undefined ? {} : { messageID }) }))
      })

      const limitsAnswer = Effect.gen(function* () {
        if (limits === undefined) return {}
        const tally = yield* limits.tally
        const line = limitsLine(tally)
        return { tally, ...(line === undefined ? {} : { line }) } satisfies LimitsAnswer
      }).pipe(Effect.withSpan("Pool.limits"))

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
            const listed = yield* Effect.option(refresh(where, true))
            // On a successful listing, the sweep's existing prune also
            // cleans up late retired rows; don't scan a second time in refresh.
            const state = yield* SynchronizedRef.get(where.pool)
            yield* apply(where.pool, where.id, PruneLedger.make(Option.match(listed, {
              onNone: () => ({}), onSome: () => ({ listed: [...state.credentials] }),
            })))
            const { credentials, holds } = yield* SynchronizedRef.get(where.pool)
            for (const credentialID of credentials) yield* readUsage(where, credentialID, holds[credentialID]?.kind === "record-unreadable")
          }),
        { discard: true },
      ).pipe(
        // The fresh readings close and count the tally's rows.
        Effect.andThen(limits?.flush ?? Effect.void),
        // The fresh readings may lift a hold (a question withdrawn) or let a credit expire unused (a claim due).
        Effect.andThen(Effect.suspend(() => reviewResets)),
        // The pushes end by their time or their run, and the queued work may need one.
        Effect.andThen(Effect.suspend(() => reviewPushes)),
        Effect.withSpan("Pool.sweep"),
      )

      /** Have the Fleet aggregate decide a command against the host's fleet, and record what it decides. */
      const sendFleet = (command: FleetModel.Command) =>
        Effect.gen(function* () {
          const state = yield* fleetStore.read
          const events = yield* FleetModel.Fleet.decide(state, command, yield* Clock.currentTimeMillis)
          if (events.length > 0) yield* fleetStore.record(events, fold(FleetModel.Fleet, events, state))
          return events
        }).pipe(fleetLock.withPermits(1))

      // ── Resets ──

      /** Have the Resets aggregate decide a command against the host's state, and record what it decides. */
      const sendResets = (command: ResetsModel.Command) =>
        Effect.gen(function* () {
          const read = (command: ResetsModel.Command) => {
            if (command._tag === "ObserveClaim") return Effect.map(resetsStore.claims, (claims) => ({ ...ResetsModel.Resets.initial, claims }))
            return resetsStore.read
          }
          const state = yield* read(command)
          const events = yield* ResetsModel.Resets.decide(state, command, yield* Clock.currentTimeMillis)
          if (events.length > 0) yield* resetsStore.record(events, fold(ResetsModel.Resets, events, state))
          return events
        }).pipe(leases.resetLedgerLock.withPermits(1))

      /**
       * The session of the newest start that asked each pool's pace, held or
       * not, in this instance: where a notice is told when no
       * held start names one. Kept in memory: a restart forgets it, and the
       * next start names one again.
       */
      const askers = new Map<string, { readonly at: number; readonly sessionID: string }>()

      /**
       * Each account's readings of the last BURN_MS, oldest first, by pool and
       * credential: what its burn is measured over (burn.ts). Kept in memory:
       * a restart forgets them, and the burn is the period's average until
       * two readings far enough apart are in hand again.
       */
      const samples = new Map<string, ReadonlyArray<Burn.Sample>>()

      /** Every pool whose resets are worked, as the review reads it: its accounts now, each with its label and burn, and the agents running on it. */
      const resetViews = Effect.gen(function* () {
        const views: Array<ResetsModel.PoolView> = []
        const now = yield* Clock.currentTimeMillis
        const tally = limits === undefined ? undefined : yield* limits.tally
        const fleet = yield* fleetStore.read
        const running = FleetModel.running(fleet, busyNow(now), now)
        for (const [id, provider] of Object.entries(config.resets ?? {})) {
          const where = poolOf(PoolId.make(id))
          if (where === undefined) continue
          const accounts = status(yield* SynchronizedRef.get(where.pool), now, rules)
          const labels: Record<string, string> = {}
          const burns: Record<string, Readonly<Record<string, number>>> = {}
          const averaged: Record<string, ReadonlyArray<string>> = {}
          for (const account of accounts) {
            labels[account.credentialID] = yield* logins.label(where.id, account.credentialID)
            const key = `${id}/${account.credentialID}`
            const kept = Burn.remember(samples.get(key) ?? [], Option.fromUndefinedOr(account.reading), now)
            samples.set(key, kept)
            burns[account.credentialID] = Burn.burnsOf(kept, now)
            averaged[account.credentialID] = Burn.averagedOf(kept)
          }
          views.push({
            id,
            provider,
            accounts,
            labels,
            ...(tally === undefined ? {} : { ratios: weeklyRatios(tally, id) }),
            burns,
            averaged,
            // The fleet's agents on the pool: every session busy now on a provider it paces, on any host.
            running: running.busy.filter((providerID) => measuredBy(config, providerID) === id).length,
            hosts: running.hosts,
          })
        }
        return views
      })

      /** Each account's spend-evenly line moved by the resets it claimed and observed (resets.ts `pacePlans`), for a pool whose resets are worked. */
      const plansOf = Effect.fn("Pool.plansOf")(function* (id: string, accounts: ReadonlyArray<AccountStatus>, now: number) {
        const provider = resetProvider(id)
        if (Option.isNone(provider)) return {}
        const state = yield* resetsStore.read
        return ResetsModel.pacePlans(provider.value, accounts, state.claims, now, state.spends)
      })

      const windowsText = (windows: ReadonlyArray<{ readonly name: string; readonly utilization: number; readonly resetAt?: number }> | undefined) =>
        (windows ?? [])
          .filter((window) => window.name === "5h" || window.name === "7d")
          .map((window) => `${window.name} ${usedOf(window.utilization)}${window.resetAt === undefined ? "" : ` (resets ${new Date(window.resetAt).toISOString()})`}`)
          .join(", ")

      const leaseMs = fleetConfig.leaseMs ?? Lease.LEASE_MS
      const leaseWaitMs = fleetConfig.leaseWaitMs ?? Lease.LEASE_WAIT_MS

      /** The account as read right now, and whether the claim is still worth sending on it (`staleReason`). */
      const judge = (where: Pooled, reset: ResetsModel.Reset) =>
        Effect.gen(function* () {
          const fresh = yield* quota.usage(where.id, reset.credentialID)
          if (fresh === undefined) return { fresh, why: "the account could not be read just before the claim" }
          yield* take(where, reset.credentialID, fresh)
          const now = yield* Clock.currentTimeMillis
          const view = (yield* resetViews).find((item) => item.id === reset.pool)
          const account = status(yield* SynchronizedRef.get(where.pool), now, rules).find((item) => item.credentialID === reset.credentialID)
          const why =
            view === undefined || account === undefined
              ? "the account is no longer in the pool"
              : ResetsModel.staleReason(view, { ...account, reading: fresh }, reset, now)
          return { fresh, why }
        })

      type Sent =
        | { readonly _tag: "sent"; readonly answer: ClaimAnswer; readonly before: ReadonlyArray<QuotaWindow>; readonly lease?: string }
        | { readonly _tag: "unreachable"; readonly peers: ReadonlyArray<string> }
      const failed = (message: string): ClaimAnswer => ({ outcome: "failed", message })
      const settles = (answer: ClaimAnswer, before: ReadonlyArray<QuotaWindow>, lease?: string): Extract<Sent, { _tag: "sent" }> => ({
        _tag: "sent",
        answer,
        before,
        ...(lease === undefined ? {} : { lease }),
      })

      /**
       * Send a claim under the provider's claim lock and the fleet's lease
       * for the provider (lease.ts): judge it on the account read now, ask
       * every peer for the lease (each for at most `leaseWaitMs`), and go on
       * only as `verdict` allows: every peer granted, or a push approved it
       * and no peer that answered refused. A claim the pool decided on its own
       * with a peer unreachable is not sent: `unreachable`.
       * Then hold the lease (held, it refuses every peer's ask until it is
       * finished here), read the account again right before the send, and
       * send only when that reading still finds the claim worth it: a reading
       * taken after every grant, so after each peer judged on its own clock
       * that the claims it knew of settled. The lease is released to the peers that
       * granted it, with the claim's time whenever one was sent.
       * Backed off (a peer refused): `failed`, to go again while the hold
       * lasts; no longer worth it: settled unsent.
       */
      const sendClaim = (where: Pooled, reset: ResetsModel.Reset): Effect.Effect<Sent> =>
        leases.lock(reset.provider).withPermits(1)(
          Effect.gen(function* () {
            const first = yield* judge(where, reset)
            if (first.fresh === undefined) return settles(failed(first.why ?? "unread"), [])
            const before = first.fresh.windows
            if (first.why !== undefined) return settles({ outcome: "nothing-to-reset", message: `not sent: ${first.why}` }, before)
            const host = fleetConfig.host
            const requestedAt = yield* Clock.currentTimeMillis
            const ask = {
              id: `${host}:${reset.requestID}:${requestedAt}`,
              provider: reset.provider,
              grants: ResetsModel.grantsOf({ reading: first.fresh }),
              readAt: first.fresh.at,
              requestedAt,
              holdMs: leaseMs,
            }
            // A claim this host sent on the account less than SETTLE_MS ago by its clock, a restart ago too: a reading may not show it yet.
            const out = ResetsModel.claimOut(yield* resetsStore.read, reset.provider, requestedAt, reset.credentialID)
            if (out !== undefined) return settles(failed(`backed off: ${out}`), before)
            const busy = yield* leases.begin(host, ask)
            if (busy !== undefined) return settles(failed(`backed off: ${busy}`), before)
            let claimedAt: number | undefined
            let granted: ReadonlyArray<string> = []
            // However this ends (an answer, a refusal, an interruption), the lease ends here and with every peer that granted it.
            const release = Effect.suspend(() =>
              Effect.andThen(
                leases.finish(ask.id),
                Effect.forEach(
                  granted,
                  (peer) =>
                    peers
                      .lease(peer, Lease.LeaseRelease.make({ host, id: ask.id, provider: ask.provider, grants: ask.grants, ...(claimedAt === undefined ? {} : { claimedAt }) }))
                      .pipe(Effect.timeout(leaseWaitMs), Effect.ignore),
                  { concurrency: "unbounded", discard: true },
                ),
              ),
            )
            return yield* Effect.gen(function* () {
              const answers = yield* Effect.forEach(
                peers.names,
                (peer) =>
                  peers.lease(peer, Lease.LeaseAsk.make({ host, ...ask })).pipe(
                    Effect.timeout(leaseWaitMs),
                    Effect.option,
                    Effect.map((answer) => ({ peer, answer: Option.getOrUndefined(answer) })),
                  ),
                { concurrency: "unbounded" },
              )
              granted = answers.flatMap((item) => (item.answer?.granted === true ? [item.peer] : []))
              const verdict = Lease.verdict(answers, reset.yes === true)
              if (verdict._tag === "refused") return settles(failed(`backed off: ${verdict.reasons.join("; ")}`), before)
              if (verdict._tag === "unreachable") return { _tag: "unreachable", peers: verdict.peers } satisfies Sent
              const lease =
                verdict.passedOver.length > 0
                  ? `the owner's yes; ${verdict.passedOver.join(", ")} unreachable${verdict.granted.length === 0 ? "" : `; granted by ${verdict.granted.join(", ")}`}`
                  : verdict.granted.length === 0
                    ? undefined
                    : `granted by ${verdict.granted.join(", ")}`
              if (!(yield* leases.hold(ask.id))) return settles(failed("backed off: the lease ended or went to a peer that asked first"), before, lease)
              // Right before the send: a claim made meanwhile, from any pool or host, shows in the account read again.
              const second = yield* judge(where, reset)
              if (second.fresh === undefined) return settles(failed(second.why ?? "unread"), before, lease)
              if (second.why !== undefined) return settles({ outcome: "nothing-to-reset", message: `not sent: ${second.why}` }, second.fresh.windows, lease)
              claimedAt = yield* Clock.currentTimeMillis
              yield* sendResets(ResetsModel.NoteSend.make({ key: reset.key }))
              const answer = yield* quota.claim(where.id, { credentialID: reset.credentialID, creditID: reset.creditID, requestID: reset.requestID })
              claimedAt = yield* Clock.currentTimeMillis
              return settles(answer, second.fresh.windows, lease)
            }).pipe(Effect.ensuring(release))
          }),
        )

      /**
       * Send a claim the aggregate decided (`sendClaim`), then read the account's
       * usage again, record the outcome with the windows before and after and
       * how the fleet agreed to it, and log what it did to them: whether the
       * weekly reset moved answers what a Claude grant does to the week. A
       * claim that found a peer unreachable is recorded failed, unsent, and
       * goes again later.
       */
      const claim = Effect.fn("Pool.claim")(function* (reset: ResetsModel.Reset) {
        const where = poolOf(PoolId.make(reset.pool))
        if (where === undefined) return
        const found = yield* sendClaim(where, reset)
        // A peer that cannot be reached may be claiming too: the claim is not sent, and goes again later as any that did not go through.
        const sent: Extract<Sent, { _tag: "sent" }> =
          found._tag === "unreachable" ? settles(failed(`not sent: no agreement, ${found.peers.join(", ")} unreachable`), []) : found
        const { answer, before, lease } = sent
        // A claim that emptied the windows frees the account; the reading taken next holds it again if a window is still spent.
        if (answer.outcome === "reset")
          yield* apply(where.pool, where.id, ClearHold.make({ credentialID: reset.credentialID }))
        const after = yield* quota.usage(where.id, reset.credentialID)
        yield* take(where, reset.credentialID, after)
        const settled = yield* sendResets(
          ResetsModel.SettleClaim.make({
            key: reset.key,
            outcome: answer.outcome,
            ...(answer.message === undefined ? {} : { message: answer.message }),
            before,
            ...(after === undefined ? {} : { after: after.windows }),
            ...(lease === undefined ? {} : { lease }),
          }),
        )
        const record = settled.flatMap((event) => (event._tag === "ClaimSettled" ? [event.claim] : []))[0]
        yield* Effect.logInfo(
          `pool resets: claimed a ${reset.provider} reset on ${reset.label} (${reset.why}): ${answer.outcome}${answer.message === undefined ? "" : ` (${answer.message})`}; ` +
            `before ${windowsText(before) || "unread"}; after ${windowsText(after?.windows) || "unread"}; the weekly reset ${record?.weekly ?? "unread"}${lease === undefined ? "" : `; ${lease}`}`,
        )
        // What the settling decided beside the record (the owner told of a claim made on its own) is carried out too.
        yield* carry(settled.filter((event) => event._tag === "OwnerTold"))
      })

      /**
       * A peer's lease message: an ask is refused while a claim this host sent
       * (its store keeps it across a restart) is less than SETTLE_MS old by
       * this host's clock, else the table answers. The asker's times are
       * never compared with this host's: clocks differ.
       */
      const lease = (message: LeaseMessage): Effect.Effect<LeaseAnswer> =>
        message._tag === "Release"
          ? Effect.as(leases.release(message), { granted: true })
          : Effect.gen(function* () {
              const out = ResetsModel.claimOut(yield* resetsStore.read, message.provider, yield* Clock.currentTimeMillis)
              return out === undefined ? yield* leases.answer(fleetConfig.host, message) : { granted: false, reason: out }
            })

      /** Each pool's last reasons for claiming nothing, logged when they change. */
      const weighed = new Map<string, string>()

      /** Carry out what the aggregate decided. */
      const carry = (events: ReadonlyArray<ResetsModel.Event>): Effect.Effect<void> =>
        Effect.forEach(
          events,
          (event) => {
            switch (event._tag) {
              case "ClaimDue":
                return Effect.sync(() => weighed.delete(event.reset.pool)).pipe(Effect.andThen(claim(event.reset)))
              case "ClaimWeighed": {
                const text = `${event.step === undefined ? "" : `${event.step}: `}${event.reasons.join("; ")}`
                if (weighed.get(event.pool) === text) return Effect.void
                weighed.set(event.pool, text)
                return Effect.logInfo(`pool resets: no claim on ${event.pool}: ${text}`)
              }
              case "OwnerTold": {
                // The session that waited last, else the newest that asked any pool's pace.
                const sessionID =
                  event.sessionID ?? [...askers.values()].filter((asker) => event.at - asker.at < ResetsModel.WAIT_MS).toSorted((left, right) => right.at - left.at)[0]?.sessionID
                return Effect.logInfo(`pool resets: ${event.text}`).pipe(
                  Effect.andThen(
                    sessionID === undefined
                      ? Effect.void
                      : owner.ask({
                          sessionID,
                          key: ResetsModel.toldKey(event.key),
                          question: event.text,
                          header: "Pool reset claimed",
                          options: [{ label: ResetsModel.SEEN }],
                          assume: ResetsModel.SEEN_ASSUME,
                        }),
                  ),
                  Effect.asVoid,
                )
              }
              case "ResetsForgotten":
                // A notice not yet read goes with its reset.
                return Effect.forEach(event.keys, (key) => owner.withdraw(ResetsModel.toldKey(key)), { discard: true })
              case "WaitNoted":
              case "ClaimSent":
              case "ClaimSettled":
              case "ClaimObserved":
              case "SpendReserved":
              case "SpendWithdrawn":
                return Effect.void
            }
          },
          { discard: true },
        )

      /**
       * The pool asks the owner nothing: a notice read (its one choice taken)
       * leaves the tray, and any other question under the pool (an older
       * pool's, about a reset or a push) is withdrawn.
       */
      const clearNotices = Effect.gen(function* () {
        const answers = yield* owner.answers
        if (answers === undefined) return
        for (const row of answers) if (!row.key.startsWith(ResetsModel.toldKey("")) || row.answer !== undefined) yield* owner.withdraw(row.key)
      })

      const reviewResets = Effect.gen(function* () {
        if (Object.keys(config.resets ?? {}).length === 0) return
        yield* clearNotices
        const pushes = PushModel.activeOn(yield* pushStore.read, fleetConfig.host, yield* Clock.currentTimeMillis).map(PushModel.grantOf)
        yield* carry(
          yield* sendResets(
            ResetsModel.Review.make({ pools: yield* resetViews, auto: config.autoClaims !== false, ...(pushes.length === 0 ? {} : { pushes }) }),
          ),
        )
      }).pipe(
        reviewing.withPermits(1),
        Effect.catchCause((cause) => Effect.logWarning("pool resets: a review failed", cause)),
        Effect.withSpan("Pool.reviewResets"),
      )

      const followAnswers = owner.changes.pipe(Stream.runForEach(() => reviewResets))

      // ── Pushes ──

      /** Have the Pushes aggregate decide a command against the host's pushes, and record what it decides. */
      const sendPush = (command: PushModel.Command) =>
        Effect.gen(function* () {
          const state = yield* pushStore.read
          const events = yield* PushModel.Pushes.decide(state, command, yield* Clock.currentTimeMillis)
          if (events.length > 0) yield* pushStore.record(events, fold(PushModel.Pushes, events, state))
          return events
        }).pipe(pushLock.withPermits(1))

      /** Carry out what the Pushes aggregate decided: log it. */
      const carryPush = (events: ReadonlyArray<PushModel.Event>): Effect.Effect<void> =>
        Effect.forEach(
          events,
          (event) => {
            switch (event._tag) {
              case "PushStarted":
                return Effect.logInfo(`pool push: started "${event.push.goal}" (${event.push.by}) on ${event.push.scope.host}, up to ${event.push.allowance.max} resets, until ${new Date(event.push.endsAt).toISOString()}`)
              case "PushEnded":
                return Effect.logInfo(`pool push: ${event.id} ended: ${event.why}`)
            }
          },
          { discard: true },
        )

      const hostLoad = workload === undefined ? Effect.succeed(undefined) : workload.load

      /** A request's resets as a push's allowance: `resets` approved (none named: none), of the kinds and accounts named. */
      const allowanceOf = (request: PushRequest): PushModel.Allowance => ({
        max: Math.max(0, Math.floor(request.resets ?? 0)),
        asNeeded: request.asNeeded === true,
        ...(request.kinds === undefined || request.kinds.length === 0 ? {} : { kinds: request.kinds }),
        ...(request.accounts === undefined || request.accounts.length === 0 ? {} : { accounts: request.accounts }),
      })

      /** Every reset in hand, for a plan that measures what the work would need. */
      const ALL = 99

      /** Time passed: pushes past their end go, and so do those whose run closed (the status plugin's runs). */
      const reviewPushes = Effect.gen(function* () {
        const runs = workload === undefined ? [] : yield* workload.runs
        const closedRuns = runs.filter((run) => run.units.length > 0 && run.units.every((unit) => PushModel.closedState(unit.state))).map((run) => run.name)
        yield* carryPush(yield* sendPush(PushModel.Tick.make({ closedRuns })))
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("pool push: a review failed", cause)),
        Effect.withSpan("Pool.reviewPushes"),
      )

      /** What one push request did, with the host's pushes after it. */
      const answered = (ok: boolean, text: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return { ok, text, pushes: PushModel.activeOn(yield* pushStore.read, fleetConfig.host, now) } satisfies PushAnswer
        })

      /** A push's text and its plan now. */
      const describe = Effect.fn("Pool.describe")(function* (push: PushModel.Push) {
        const now = yield* Clock.currentTimeMillis
        const used = ResetsModel.pushUsed(yield* resetsStore.read, push.id).length
        const load = yield* hostLoad
        const plan = PushModel.planOf({
          views: yield* resetViews,
          grant: { ...push.allowance, max: Math.max(0, push.allowance.max - used) },
          now,
          ...(load === undefined ? {} : { load }),
        })
        return `${PushModel.pushText(push, used, now)}\n${PushModel.planText(plan)}`
      })

      const push: (request: PushRequest) => Effect.Effect<PushAnswer> = Effect.fn("Pool.push")(
        function* (request: PushRequest) {
          const host = request.host ?? fleetConfig.host
          if (host !== fleetConfig.host) {
            if (!peers.names.includes(host)) return yield* answered(false, `No host ${host}: this is ${fleetConfig.host}, and its peers are ${peers.names.join(", ") || "none"}.`)
            // The caller's session is this host's, not the peer's: a push for a peer covers that whole host, so it names no session, nor a run (a run is a session's).
            if (request.action === "start" && (request.session === true || request.run !== undefined))
              return yield* answered(false, `A push for ${host} covers that whole host: this session's tree and runs are ${fleetConfig.host}'s. Start it without session or run, or from a session on ${host}.`)
            // Nor does it name the host: the peer knows itself by its own name (the Mac's "workbox" is "bite-cristian" there), and a request with none is for itself.
            const { sessionID: _caller, session: _session, host: _host, ...forwarded } = request
            return yield* peers.push(host, forwarded).pipe(
              Effect.catchTag("PeerUnreachable", (error) => answered(false, `${host} cannot be reached: ${error.message}. Nothing changed.`)),
            )
          }
          const now = yield* Clock.currentTimeMillis
          const state = yield* pushStore.read
          const active = PushModel.activeOn(state, host, now)
          switch (request.action) {
            case "status": {
              if (active.length === 0) return yield* answered(true, `No push is active on ${host}.`)
              const texts = yield* Effect.forEach(active, describe)
              return yield* answered(true, texts.join("\n\n"))
            }
            case "end": {
              const ending = request.id === undefined ? active : active.filter((item) => item.id === request.id)
              if (ending.length === 0) return yield* answered(false, request.id === undefined ? `No push is active on ${host}.` : `No push ${request.id} is active on ${host}.`)
              for (const item of ending) yield* carryPush(yield* sendPush(PushModel.EndPush.make({ id: item.id, why: "ended by the owner" })))
              return yield* answered(true, `Ended ${ending.map((item) => `"${item.goal}"`).join(", ")}: the pace holds starts as usual again.`)
            }
            case "plan": {
              const load = yield* hostLoad
              const plan = PushModel.planOf({
                views: yield* resetViews,
                grant: { ...allowanceOf(request), max: request.resets === undefined ? ALL : allowanceOf(request).max },
                now,
                ...(request.units === undefined ? {} : { need: { units: request.units, cost: request.units * (config.unitCost ?? PushModel.UNIT_COST) } }),
                ...(load === undefined ? {} : { load }),
              })
              return yield* answered(true, PushModel.planText(plan))
            }
            case "start": {
              const goal = request.goal?.trim() ?? ""
              if (goal === "") return yield* answered(false, "A push needs a goal: say what the work is.")
              const until = request.until === undefined || request.until === "done" ? undefined : Date.parse(request.until)
              if (until !== undefined && Number.isNaN(until)) return yield* answered(false, `"${request.until}" is not a time: give an ISO time, or "done".`)
              const endsAt = request.hours !== undefined ? now + request.hours * 3_600_000 : until
              if (endsAt !== undefined && endsAt <= now) return yield* answered(false, "That end time has passed already.")
              // A run is the calling session's: its push covers the caller's tree, as `session` does, and nothing outside it.
              const tree = request.session === true || request.run !== undefined
              if (tree && request.sessionID === undefined)
                return yield* answered(false, "A push for a session's tree or a run needs the calling session: start it from that session, or for the whole host.")
              const root = tree && request.sessionID !== undefined ? yield* owner.root(request.sessionID) : undefined
              const scope: PushModel.PushScope =
                root === undefined ? { host } : request.run === undefined ? { host, sessionID: root } : { host, sessionID: root, run: request.run }
              const events = yield* sendPush(
                PushModel.StartPush.make({
                  goal,
                  scope,
                  ...(endsAt === undefined ? {} : { endsAt }),
                  allowance: allowanceOf(request),
                  by: "asked",
                  ...(request.sessionID === undefined ? {} : { sessionID: request.sessionID }),
                }),
              )
              yield* carryPush(events)
              const started = events.flatMap((event) => (event._tag === "PushStarted" ? [event.push] : []))[0]
              if (started === undefined) return yield* answered(false, "The push did not start.")
              return yield* answered(true, yield* describe(started))
            }
          }
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("pool push: a request failed", cause).pipe(Effect.andThen(Effect.succeed({ ok: false, text: "The push request failed; nothing changed.", pushes: [] }))),
        ),
      )

      const resetsStatus = Effect.gen(function* () {
        const state = yield* resetsStore.read
        const now = yield* Clock.currentTimeMillis
        const forecast = (yield* resetViews).flatMap((view) => {
          const text = PushModel.forecastText(PushModel.forecastOf(view, now))
          return text === undefined ? [] : [text]
        })
        const pushes = PushModel.activeOn(yield* pushStore.read, fleetConfig.host, now).map((item) =>
          PushModel.pushText(item, ResetsModel.pushUsed(state, item.id).length, now),
        )
        return {
          resets: Object.values(state.resets).toSorted((left, right) => right.at - left.at),
          claims: [...state.claims].reverse(),
          ...(forecast.length === 0 ? {} : { forecast }),
          ...(pushes.length === 0 ? {} : { pushes }),
        } satisfies ResetsStatus
      }).pipe(Effect.withSpan("Pool.resets"))

      /**
       * A held answer of the pool `id` with, when a claim that went through still waits for a reading to show its
       * recovery, that claim pending in its words (`pendingWords`) and its ask again by the next sweep.
       */
      const withPending = (paced: Pace, pool: Option.Option<PoolId>, now: number): Effect.Effect<Pace> => {
        if (paced.ok || Option.isNone(pool) || Option.exists(Option.fromUndefinedOr(paced.signIn), (ids) => ids.length > 0)) return Effect.succeed(paced)
        return Effect.map(resetsStore.read, (state) =>
          Option.match(ResetsModel.pendingWords(state.claims, pool.value, now), {
            onNone: () => paced,
            onSome: (words) => ({
              ...paced,
              reason: `${paced.reason}; ${words}`,
              retryAt: nextRetryAt(now, [paced.retryAt, now + UNREAD_RETRY_MS]),
            }),
          }),
        )
      }

      const liftPace = Effect.fn("Pool.liftPace")(function* (
        providerID: string, model: string | undefined, dispatch: boolean | undefined, policy: DispatchPolicy, push: PushModel.Push,
        answer: Pace, work: "new-work" | "existing-request",
      ) {
        const reason = `the push "${push.goal}" lifts the spend-evenly hold until ${formatNotificationTime(push.endsAt)} (${answer.reason})`
        if (dispatch !== true && Option.isNone(Option.fromUndefinedOr(model))) return { ok: true, measured: true, reason } satisfies Pace
        const lifted = yield* paceOf(providerID, model, true, { ...policy, liftEvenLine: true }, work)
        if (!lifted.ok) return lifted
        return { ...lifted, reason } satisfies Pace
      })

      const pace = Effect.fn("Pool.pace")(function* (
        providerID: string, model?: string, sessionID?: string, dispatch?: boolean, policy: DispatchPolicy = {},
        work: "new-work" | "existing-request" = "new-work",
      ) {
        const paced = yield* paceOf(providerID, model, dispatch, policy, work)
        const id = Option.fromUndefinedOr(measuredBy(config, providerID))
        const session = Option.fromUndefinedOr(sessionID)
        // A title or other auxiliary request waits for ordinary room; it does not ask for another reset.
        const resetting = Option.filter(id, (pool) => Option.isNone(Option.fromUndefinedOr(policy.auxiliary)) && Option.isSome(resetProvider(pool)))
        const now = yield* Clock.currentTimeMillis
        if (Option.isSome(resetting) && Option.isSome(session)) askers.set(resetting.value, { at: now, sessionID: session.value })
        const answer = yield* withPending(paced, id, now)
        if (answer.ok || !answer.measured) return answer
        // A push active on this host covers the start when its scope names no session, or the root of the start's.
        const active = PushModel.activeOn(yield* pushStore.read, fleetConfig.host, now)
        const root = yield* Option.match(Option.filter(session, () => active.length > 0), {
          onNone: () => Effect.succeed(undefined), onSome: owner.root,
        })
        const push = Arr.findFirst(active, (item) => PushModel.covers(item, root))
        const used = yield* Option.match(push, {
          onNone: () => Effect.succeed(0),
          onSome: (activePush) => Effect.map(resetsStore.read, (state) => ResetsModel.pushUsed(state, activePush.id).length),
        })
        // The spend-evenly target alone does not hold a start a push covers: the accounts have quota, and the push spends
        // them to 100% and claims its resets. Once its approved resets are spent, the pace holds again from the last claim's line.
        const approved = Option.filter(push, (activePush) => activePush.allowance.max === 0 || used < activePush.allowance.max)
        if (answer.soft === true && Option.isSome(approved)) return yield* liftPace(providerID, model, dispatch, policy, approved.value, answer, work)
        // A start held by a measured pace waits: the resets are reviewed for it, without holding up the answer.
        if (Option.isNone(resetting)) return answer
        const hard = answer.soft !== true
        yield* sendResets(
          ResetsModel.NoteWait.make({
            pool: resetting.value,
            ...(sessionID === undefined ? {} : { sessionID }),
            ...(hard ? { hard: true } : {}),
            ...(root === undefined ? {} : { root }),
            ...(model === undefined ? {} : { model }),
          }),
        )
        yield* Effect.forkIn(reviewResets, scope)
        if (!hard || Option.isNone(push)) return answer
        // Held for lack of quota in a push's scope: the review claims one of its resets, and the start asks again soon.
        const { allowance, goal } = push.value
        const left = allowance.max - used
        if (left <= 0) return { ...answer, reason: `${answer.reason}; the push "${goal}" has spent its ${allowance.max} approved resets` }
        return {
          ...answer,
          reason: `${answer.reason}; the push "${goal}" claims one of its ${left} approved reset${left === 1 ? "" : "s"}`,
          retryAt: nextRetryAt(now, [answer.retryAt, now + PUSH_RETRY_MS]),
        }
      })

      /**
       * The pace on the readings now. Both ways of quoting new work count the same fleet starts not yet in the readings.
       * Placement of an existing request does not charge its launch again: it was charged when it was admitted.
       */
      const paceOf = Effect.fn("Pool.paceOf")(function* (
        providerID: string, model?: string, dispatch?: boolean, policy: DispatchPolicy = {},
        work: "new-work" | "existing-request" = "new-work",
      ) {
        const paced = poolOf(measuredBy(config, providerID))
        if (paced === undefined) return UNPOOLED
        const authority = yield* Effect.result(ledger.withHolds(currentHolds(paced)))
        if (authority._tag === "Failure") return storeHeld(authority.failure.retryAt, yield* Clock.currentTimeMillis)
        yield* refresh(paced, false)
        const fleet = yield* fleetStore.read
        // A peer's newer readings of the same logins count here too, whichever instance on the host read the peer.
        yield* mergeReports(fleet)
        for (const credentialID of (yield* SynchronizedRef.get(paced.pool)).credentials) yield* pull(paced, credentialID)
        const dispatches = dispatch === true || Option.isSome(Option.fromUndefinedOr(model))
        const current = yield* SynchronizedRef.get(paced.pool)
        if (dispatches || Object.values(current.holds).some((hold) => hold.kind === "record-unreadable")) {
          const before = yield* Clock.currentTimeMillis
          const listed = status(current, before, rules)
          const required = requiredScopes(listed, model)
          const unread = listed.filter((account) => Option.match(Option.fromUndefinedOr(account.hold), {
            onSome: (hold) => (hold.kind === "record-unreadable" || (dispatches && hold.kind === "signin")) && holdRecheckAt(hold) <= before,
            onNone: () => dispatches && Option.exists(evidenceGap(account, before, required), (gap) => refreshEvidence(gap, before)),
          }))
          const read = Effect.forEach(unread, (account) => readUsage(paced, account.credentialID, account.hold?.kind === "record-unreadable"),
            { discard: true, concurrency: unread.length })
          // A quote leaves time for the caller's RPC. Dispatch has its own
          // overall deadline; it decides on all the outcomes in by that time.
          const deadline = Option.getOrElse(Option.filter(Option.some(DISPATCH_EVIDENCE_MS), () => work === "existing-request"), () => QUOTE_EVIDENCE_MS)
          if (unread.length > 0) yield* read.pipe(Effect.timeoutOption(deadline))
        }
        const now = yield* Clock.currentTimeMillis
        const accounts = status(yield* SynchronizedRef.get(paced.pool), now, rules)
        const plans = yield* plansOf(paced.id, accounts, now)
        // Every start in the fleet on a provider this pool paces counts, whichever host admitted it.
        const starts = FleetModel.inflight(fleet, now, fleetConfig.settleMs)
          .filter((start) => work === "new-work" && measuredBy(config, start.providerID) === paced.id)
          .map((start) => start.at)
        const inflight = { starts, cost: fleetConfig.startCost, settleMs: fleetConfig.settleMs }
        if (dispatch === true && Option.isNone(Option.fromUndefinedOr(model))) return dispatchPace(accounts, now, plans, fleetConfig.startCost, model, { ...policy, inflight })
        return poolPace(accounts, now, inflight, model, plans, policy)
      })

      const started = (providerID: string) => sendFleet(FleetModel.RecordStart.make({ providerID })).pipe(Effect.asVoid)

      const report = Effect.gen(function* () {
        const readings: Array<SharedReading> = []
        for (const { id, pool } of every) {
          const state = yield* SynchronizedRef.get(pool)
          for (const credentialID of state.credentials) {
            const reading = state.readings[credentialID]
            if (reading !== undefined) readings.push({ pool: id, credentialID, reading })
          }
        }
        const now = yield* Clock.currentTimeMillis
        const answer = FleetModel.report(yield* fleetStore.read, fleetConfig.host, now, fleetConfig.settleMs, readings, busyNow(now))
        // The tokens this host sent count in a peer's tally of the same accounts.
        return limits === undefined ? answer : { ...answer, limits: yield* limits.report }
      }).pipe(Effect.withSpan("Pool.report"))

      /**
       * A peer's reading of a login this pool lists, when it is newer than the
       * one held: the accounts are the same, and a reading is account-wide.
       */
      const merge = Effect.fn("Pool.merge")(function* (shared: SharedReading) {
        const target = poolOf(PoolId.make(shared.pool))
        if (target === undefined) return
        // The list is read again only when it is old: a pool that has not listed its logins yet does now.
        yield* refresh(target, false).pipe(Effect.ignore)
        const state = yield* SynchronizedRef.get(target.pool)
        if (!state.credentials.includes(shared.credentialID)) return
        const held = state.readings[shared.credentialID]
        if (held !== undefined && held.at >= shared.reading.at) return
        yield* apply(target.pool, target.id, TakeReading.make({ credentialID: shared.credentialID, reading: shared.reading }))
        if (limits !== undefined) yield* limits.observe(target.id, shared.credentialID, shared.reading)
      })

      const mergeReports = (fleet: FleetModel.FleetState) =>
        Effect.forEach(Object.values(fleet.peers), (peer) => Effect.forEach(peer.report?.readings ?? [], merge, { discard: true }), {
          discard: true,
        })

      const pollPeer = (peer: string) =>
        peers.report(peer).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              sendFleet(FleetModel.MissPeer.make({ peer, message: error.message })).pipe(
                Effect.tap((events) =>
                  events.length === 0
                    ? Effect.void
                    : Effect.logWarning(`pool fleet: ${peer} cannot be read (${error.message}); the pace goes on without its new starts`),
                ),
                Effect.asVoid,
              ),
            onSuccess: (answer) =>
              Effect.gen(function* () {
                const missed = (yield* fleetStore.read).peers[peer]?.missed
                yield* sendFleet(FleetModel.TakeReport.make({ peer, report: answer }))
                if (missed !== undefined) yield* Effect.logInfo(`pool fleet: ${peer} answers again`)
                yield* Effect.forEach(answer.readings, merge, { discard: true })
                if (limits !== undefined && answer.limits !== undefined) yield* limits.takePeer(peer, answer.limits)
              }),
          }),
        )

      const poll = Effect.forEach(
        peers.names,
        (peer) =>
          sendFleet(FleetModel.ClaimPoll.make({ peer, everyMs: fleetConfig.pollMs / 2 })).pipe(
            Effect.flatMap((claimed) => (claimed.length === 0 ? Effect.void : pollPeer(peer))),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("Pool.poll"))

      const fleetStatus = Effect.gen(function* () {
        const state = yield* fleetStore.read
        const now = yield* Clock.currentTimeMillis
        return {
          host: fleetConfig.host,
          starts: FleetModel.ownStarts(state, now, fleetConfig.settleMs).length,
          settleMinutes: fleetConfig.settleMs / 60_000,
          peers: FleetModel.peers(state, peers.names, now, fleetConfig.settleMs),
        } satisfies FleetStatus
      }).pipe(Effect.withSpan("Pool.fleet"))

      const poolsStatus = Effect.gen(function* () {
        const answer: Record<string, PoolsStatus[string]> = {}
        for (const where of every) {
          const { id, pool } = where
          const pacedOnly = !placedPools.has(id)
          if (pacedOnly) yield* refresh(where, false).pipe(Effect.ignore)
          const snapshot = status(yield* SynchronizedRef.get(pool), yield* Clock.currentTimeMillis, rules)
          const accounts = yield* Match.value(pacedOnly).pipe(
            Match.when(false, () => Effect.succeed(snapshot)),
            Match.orElse(() => Effect.forEach(snapshot, (account) => Effect.gen(function* () {
              if (Option.isSome(Option.fromUndefinedOr(account.reading))) return { ...account, measurement: "measured" as const }
              const failed = yield* ledger.firstReadingFailure(id, account.credentialID)
              return { ...account, measurement: "unmeasured" as const, ...Option.match(failed, {
                onNone: () => ({}), onSome: (usageReadFailure) => ({ usageReadFailure }),
              }) }
            }))),
          )
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

      return {
        place,
        confirmed,
        admitActive,
        responded,
        retry,
        release,
        stepEnded,
        limits: limitsAnswer,
        follow,
        sweep,
        pace,
        status: poolsStatus,
        session,
        alerts,
        logins: sessionLogins,
        started,
        stepStarted,
        report,
        poll,
        fleet: fleetStatus,
        reviewResets,
        followAnswers,
        resets: resetsStatus,
        lease,
        push,
        reviewPushes,
      }
    }),
  )
