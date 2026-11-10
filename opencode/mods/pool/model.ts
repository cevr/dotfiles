// The pool model's handlers: each gathers what one moment of a request needs
// from the outside systems (the provider's logins, its quota, the ledger), has
// the AccountPool aggregate decide it, and writes what changed to the ledger.
// The Fleet aggregate (fleet.ts) keeps this host's starts and its peers'
// reports, which the pace counts, in the FleetStore every instance of the
// plugin on the host shares.
// The aggregate is the one decision entry point, so the stories run exactly
// what these do. The plugin calls these and nothing else.
import { Clock, Context, Effect, Layer, Scope, Semaphore, Stream, SynchronizedRef } from "effect"
import { fold } from "@dotfiles/decider/decider"
import {
  AccountPool,
  ClearHold,
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
  PoolId,
} from "./account-pool.ts"
import { held, lastPlacedAt, placedOn, sessionAccount, shouldFailOver, status, type RequestKind, type Rules } from "./accounts.ts"
import * as FleetModel from "./fleet.ts"
import { poolPace, UNPOOLED, type Pace } from "./pace.ts"
import type { QuotaReading } from "./quota.ts"
import * as ResetsModel from "./resets.ts"
import type { ResetProvider } from "./resets.ts"
import { FleetStore, Ledger, Logins, Owner, Peers, Quota, ResetsStore, type LoginsUnavailable } from "./service.ts"

/** A question gone from the owner's tray this long after it was asked, with no answer, was dismissed. */
const ANSWER_GRACE_MS = 60_000
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

/** The pools a config names: each integration once, in the order the providers name them, then the paced ones. */
export const poolsOf = (config: Config): ReadonlyArray<PoolId> => [
  ...new Set([...Object.values(config.providers), ...Object.values(config.paced ?? {})]),
]

export class Pool extends Context.Service<
  Pool,
  {
    /**
     * A model request goes out: the login it goes out on, and the lifetime its
     * cache is written for when its agent keeps its own (the provider's once
     * the session has outlived it); none when the provider is not pooled or
     * lists no login.
     */
    readonly place: (input: {
      readonly providerID: string
      readonly sessionID: string
      readonly kind: RequestKind
      /** How long its agent keeps the request's cache when it keeps its own lifetime (ms); else the provider's. */
      readonly cacheLifeMs?: number
      /** The session whose cache the request reads when the session has none of its own: a fork's source. */
      readonly cacheOf?: string
    }) => Effect.Effect<Placed | undefined>
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
    /**
     * Whether a new agent on the provider may start now; of `model`, when
     * named, so a window of that model's own (`7d:Fable`) can hold it too.
     */
    readonly pace: (providerID: string, model?: string, sessionID?: string) => Effect.Effect<Pace, LoginsUnavailable>
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
    /** What this host tells a peer: its starts that still count and its readings. */
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
     * Work the resets: read the owner's answers, then have the Resets
     * aggregate review every pool, and carry out what it decides (claims,
     * questions, withdrawals). The sweep and a held pace run it.
     */
    readonly reviewResets: Effect.Effect<void>
    /** Read the owner's answers each time the questions change, until interrupted. */
    readonly followAnswers: Effect.Effect<void>
    /** The resets being worked and the claims made, for the pane. */
    readonly resets: Effect.Effect<ResetsStatus>
  }
>()("dotfiles-opencode/pool/Pool") {}

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
      const scope = yield* Scope.Scope
      // The resets are decided one command at a time in this instance; another instance's claim of the same hold is the same claim (its request id).
      const resetsLock = yield* Semaphore.make(1)
      // One review at a time: a review carries out claims, which take seconds.
      const reviewing = yield* Semaphore.make(1)

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

      const poolOf = (id: PoolId | undefined) => {
        const pool = id === undefined ? undefined : pools.get(id)
        return id === undefined || pool === undefined ? undefined : { id, pool }
      }
      /** The pool a provider's requests are placed through, if it has one. */
      const pooled = (providerID: string) => poolOf(Object.hasOwn(config.providers, providerID) ? config.providers[providerID] : undefined)
      type Pooled = NonNullable<ReturnType<typeof poolOf>>
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
        readonly cacheOf?: string
      }) {
        const where = pooled(input.providerID)
        if (where === undefined) return undefined
        yield* refresh(where, false).pipe(Effect.ignore)
        const command = PlaceRequest.make({
          sessionID: input.sessionID,
          kind: input.kind,
          ...(input.cacheLifeMs === undefined ? {} : { cacheLifeMs: input.cacheLifeMs }),
          ...(input.cacheOf === undefined ? {} : { cacheOf: input.cacheOf }),
        })
        const events = yield* send(where.pool, where.id, command).pipe(
          Effect.catchTag("NoAccount", () => Effect.succeed([])),
        )
        return events.flatMap((event): ReadonlyArray<Placed> =>
          event._tag === "RequestPlaced"
            ? [{ credentialID: event.credentialID, ...(event.cacheLifeMs === undefined ? {} : { cacheLifeMs: event.cacheLifeMs }) }]
            : [],
        )[0]
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
      ).pipe(
        // The fresh readings may lift a hold (a question withdrawn) or let a credit expire unused (a claim due).
        Effect.andThen(Effect.suspend(() => reviewResets)),
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
          const state = yield* resetsStore.read
          const events = yield* ResetsModel.Resets.decide(state, command, yield* Clock.currentTimeMillis)
          if (events.length > 0) yield* resetsStore.record(events, fold(ResetsModel.Resets, events, state))
          return events
        }).pipe(resetsLock.withPermits(1))

      /** Every pool whose resets are worked, as the review reads it: its accounts now, each with its label. */
      const resetViews = Effect.gen(function* () {
        const views: Array<ResetsModel.PoolView> = []
        const now = yield* Clock.currentTimeMillis
        for (const [id, provider] of Object.entries(config.resets ?? {})) {
          const where = poolOf(PoolId.make(id))
          if (where === undefined) continue
          const accounts = status(yield* SynchronizedRef.get(where.pool), now, rules)
          const labels: Record<string, string> = {}
          for (const account of accounts) labels[account.credentialID] = yield* logins.label(where.id, account.credentialID)
          views.push({ id, provider, accounts, labels })
        }
        return views
      })

      const windowsText = (windows: ReadonlyArray<{ readonly name: string; readonly utilization: number; readonly resetAt?: number }> | undefined) =>
        (windows ?? [])
          .filter((window) => window.name === "5h" || window.name === "7d")
          .map((window) => `${window.name} ${Math.round(window.utilization * 100)}%${window.resetAt === undefined ? "" : ` (resets ${new Date(window.resetAt).toISOString()})`}`)
          .join(", ")

      /**
       * Send a claim the aggregate decided, then read the account's usage
       * again, record the outcome with the windows before and after, and log
       * what it did to them: whether the weekly reset moved answers what a
       * Claude grant does to the week.
       */
      const claim = Effect.fn("Pool.claim")(function* (reset: ResetsModel.Reset) {
        const where = poolOf(PoolId.make(reset.pool))
        if (where === undefined) return
        const before = (yield* SynchronizedRef.get(where.pool)).readings[reset.credentialID]?.windows ?? []
        const answer = yield* quota.claim(where.id, { credentialID: reset.credentialID, creditID: reset.creditID, requestID: reset.requestID })
        // A claim that emptied the windows frees the account; the reading taken next holds it again if a window is still spent.
        if (answer.outcome === "reset" || answer.outcome === "already-redeemed")
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
          }),
        )
        const record = settled.flatMap((event) => (event._tag === "ClaimSettled" ? [event.claim] : []))[0]
        yield* Effect.logInfo(
          `pool resets: claimed a ${reset.provider} reset on ${reset.label} (${reset.why}): ${answer.outcome}${answer.message === undefined ? "" : ` (${answer.message})`}; ` +
            `before ${windowsText(before) || "unread"}; after ${windowsText(after?.windows) || "unread"}; the weekly reset ${record?.weekly ?? "unread"}`,
        )
      })

      /** Carry out what the aggregate decided. */
      const carry = (events: ReadonlyArray<ResetsModel.Event>): Effect.Effect<void> =>
        Effect.forEach(
          events,
          (event) => {
            switch (event._tag) {
              case "ClaimDue":
                return claim(event.reset)
              case "OwnerAsked":
                return owner
                  .ask({
                    sessionID: event.reset.sessionID ?? "",
                    key: event.reset.key,
                    question: event.reset.question ?? "",
                    header: ResetsModel.claudeHeader(event.reset.label),
                    options: [{ label: ResetsModel.CLAIM }, { label: ResetsModel.KEEP }],
                    assume: ResetsModel.ASSUME,
                  })
                  .pipe(
                    Effect.tap((asked) =>
                      asked
                        ? Effect.logInfo(`pool resets: asked the owner about a Claude reset on ${event.reset.label}`)
                        : Effect.logWarning(`pool resets: the owner could not be asked about a Claude reset on ${event.reset.label}`),
                    ),
                  )
              case "AskWithdrawn":
                return owner.withdraw(event.key).pipe(Effect.andThen(Effect.logInfo(`pool resets: withdrew the question (${event.why})`)))
              case "AnswerDeclined":
                return owner.withdraw(event.key)
              case "WaitNoted":
              case "ClaimSettled":
              case "ResetsForgotten":
                return Effect.void
            }
          },
          { discard: true },
        )

      /**
       * The owner's answers to the questions open: an answer is taken (a yes
       * claims), and a question gone without one (dismissed, its session
       * deleted) is a no once it has had a minute to be written.
       */
      const takeAnswers = Effect.gen(function* () {
        const state = yield* resetsStore.read
        const open = Object.values(state.resets).filter((reset) => reset.stage === "asked")
        if (open.length === 0) return
        const answers = yield* owner.answers
        if (answers === undefined) return
        const now = yield* Clock.currentTimeMillis
        for (const reset of open) {
          const found = answers.find((row) => row.key === reset.key)
          if (found !== undefined && found.answer === undefined) continue
          if (found === undefined && now - reset.at < ANSWER_GRACE_MS) continue
          yield* carry(yield* sendResets(ResetsModel.TakeAnswer.make({ key: reset.key, ...(found?.answer === undefined ? {} : { answer: found.answer }) })))
          if (found !== undefined) yield* owner.withdraw(reset.key)
        }
      })

      const reviewResets = Effect.gen(function* () {
        if (Object.keys(config.resets ?? {}).length === 0) return
        yield* takeAnswers
        yield* carry(yield* sendResets(ResetsModel.Review.make({ pools: yield* resetViews })))
      }).pipe(
        reviewing.withPermits(1),
        Effect.catchCause((cause) => Effect.logWarning("pool resets: a review failed", cause)),
        Effect.withSpan("Pool.reviewResets"),
      )

      const followAnswers = owner.changes.pipe(Stream.runForEach(() => reviewResets))

      const resetsStatus = Effect.gen(function* () {
        const state = yield* resetsStore.read
        return {
          resets: Object.values(state.resets).toSorted((left, right) => right.at - left.at),
          claims: [...state.claims].reverse(),
        } satisfies ResetsStatus
      }).pipe(Effect.withSpan("Pool.resets"))

      const pace = Effect.fn("Pool.pace")(function* (providerID: string, model?: string, sessionID?: string) {
        const answer = yield* paceOf(providerID, model)
        const id = measuredBy(config, providerID)
        // A start held by a measured pace waits: the resets are reviewed for it, without holding up the answer.
        if (!answer.ok && answer.measured && id !== undefined && config.resets?.[id] !== undefined) {
          yield* sendResets(ResetsModel.NoteWait.make({ pool: id, ...(sessionID === undefined ? {} : { sessionID }) }))
          yield* Effect.forkIn(reviewResets, scope)
        }
        return answer
      })

      const paceOf = Effect.fn("Pool.paceOf")(function* (providerID: string, model?: string) {
        const paced = poolOf(measuredBy(config, providerID))
        if (paced === undefined) return UNPOOLED
        yield* refresh(paced, false)
        const fleet = yield* fleetStore.read
        // A peer's newer readings of the same logins count here too, whichever instance on the host read the peer.
        yield* mergeReports(fleet)
        for (const credentialID of (yield* SynchronizedRef.get(paced.pool)).credentials) yield* pull(paced, credentialID)
        const now = yield* Clock.currentTimeMillis
        // Every start in the fleet on a provider this pool paces counts, whichever host admitted it.
        const starts = FleetModel.inflight(fleet, now, fleetConfig.settleMs)
          .filter((start) => measuredBy(config, start.providerID) === paced.id)
          .map((start) => start.at)
        return poolPace(
          status(yield* SynchronizedRef.get(paced.pool), now, rules),
          now,
          { starts, cost: fleetConfig.startCost, settleMs: fleetConfig.settleMs },
          model,
        )
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
        return FleetModel.report(yield* fleetStore.read, fleetConfig.host, yield* Clock.currentTimeMillis, fleetConfig.settleMs, readings)
      }).pipe(Effect.withSpan("Pool.report"))

      /**
       * A peer's reading of a login this pool lists, when it is newer than the
       * one held: the accounts are the same, and a reading is account-wide.
       */
      const merge = Effect.fn(function* (shared: SharedReading) {
        const target = poolOf(PoolId.make(shared.pool))
        if (target === undefined) return
        // The list is read again only when it is old: a pool that has not listed its logins yet does now.
        yield* refresh(target, false).pipe(Effect.ignore)
        const state = yield* SynchronizedRef.get(target.pool)
        if (!state.credentials.includes(shared.credentialID)) return
        const held = state.readings[shared.credentialID]
        if (held !== undefined && held.at >= shared.reading.at) return
        yield* apply(target.pool, target.id, TakeReading.make({ credentialID: shared.credentialID, reading: shared.reading }))
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

      return {
        place,
        responded,
        retry,
        release,
        stepEnded,
        follow,
        sweep,
        pace,
        status: poolsStatus,
        session,
        alerts,
        logins: sessionLogins,
        started,
        report,
        poll,
        fleet: fleetStatus,
        reviewResets,
        followAnswers,
        resets: resetsStatus,
      }
    }),
  )
