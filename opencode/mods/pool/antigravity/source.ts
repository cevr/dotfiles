// Antigravity's read authority: the one place a read of Google, a keychain
// attempt and every change of the state are decided. The state lives on disk
// only (state.ts): each change is decide-then-commit under the state file's
// lock (Store.transact), so every plugin instance and every process on the
// host (a second server, the read command) decides from the same state, and a
// save never overwrites a newer one. A read happens only when asked (`read`):
// under the lock it loads the state, keeps the floor (no read within
// READ_EVERY_MS of the last attempt, whoever made it), picks the sign-in (the
// profile's token files first; then a token this authority holds in memory;
// then the keychain, only with an unused consent, which this attempt uses up),
// and commits the attempt; then it acts with the lock released, and commits
// its result under the lock again, kept only while it is still the state's
// attempt. A keychain token lives in this authority's memory until it expires
// or Google refuses it; after that, or a restart, nothing touches the keychain
// until a new consent. Nothing here runs on its own: building it does no I/O.
// Every failure in it, typed or a defect, is contained at its methods: it
// answers a typed unknown and never fails its caller.
import { Cause, Clock, Effect, Match, Option, Predicate, Random, Redacted, Ref, Result, Schema, Semaphore } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { HttpClient } from "effect/http"
import {
  type AntigravityReport,
  fromLocalState,
  fromReport,
  isKeyLiveInMerged,
  mergedGroupsOf,
  mergedNextReadAt,
  mergeFleet,
  type MergedRecord,
  openDecisionAt,
  type OpenStatus,
  type PeerRecord,
  readingHost,
  resolveGroup,
  WireWhy,
} from "./fleet.ts"
import { checkStartGate, DEFAULT_GEMINI_CAP, GateDecision, type GateQuery, type GeminiCap, geminiStartProvider, type PeerBusy } from "./gate.ts"
import { type PaneLimit, parsePaneLimits, validateRecordAt } from "./limit.ts"
import { type Access, type AuthMethod, accessOf, EXPIRY_MARGIN_MS, endpointOrder, type Endpoints, ReadFailed, readQuota } from "./reader.ts"
import { fromFiles, fromKeychain, Lookup, type Places, SignIn as SignInSchema, type SignIn } from "./signin.ts"
import { type Answer, due, Event, evolve, groupsOf, keychainAllowed, type State, Why } from "./state.ts"
import { mergedStatusLines, statusLines } from "./text.ts"

/** The state file's store: never a token. */
export interface Store {
  /** The state on disk now; a fresh one when none reads. */
  readonly load: Effect.Effect<State, StoreFailed>
  /** `step` run on the state on disk under the file's lock; what it returns saved before the lock is let go. */
  readonly transact: <A, R>(step: (state: State) => Effect.Effect<readonly [State, A], never, R>) => Effect.Effect<A, StoreFailed, R>
}

/** The state file could not be locked, read or written. */
export class StoreFailed extends Schema.TaggedError<StoreFailed>()("StoreFailed", { what: Schema.String }) {}

/** A snapshot of the fleet as Antigravity reads it (from the pool's shared FleetStore + busy set). */
export interface FleetView {
  readonly host: string
  readonly peers: Readonly<Record<string, PeerRecord>>
  readonly peerNames: ReadonlyArray<string>
  /** Currently running providers/agents on this host. */
  readonly ownBusy: ReadonlyArray<string>
  /** Each peer's last reported busy set and when its report was seen (local clock). */
  readonly peerBusy: ReadonlyArray<PeerBusy>
}

/** Optional fleet bridge: reads peers' reports and host identity without blocking plugin startup. */
export interface FleetContext {
  /** Configured fleet host id (used even if `read` fails so reports never collide on a placeholder name). */
  readonly host: string
  readonly read: Effect.Effect<FleetView>
  readonly recordBusy?: (paneId: string, providerID: string) => Effect.Effect<void>
  readonly releaseBusy?: (paneId: string) => Effect.Effect<void>
}

export interface Options {
  /** The CLI's profile directory: the managed one (profile.ts) by default.  */
  readonly profile: string
  readonly places: Places
  readonly store: Store
  readonly auth: AuthMethod
  readonly endpoints: Endpoints
  /** The user agent requests carry (reader.ts `userAgent`), worked out only when a read is made. */
  readonly agent: Effect.Effect<string>
  /** Configured host id when standalone (overridden by `fleet.host` when in a fleet). */
  readonly host?: string
  /** Optional fleet context: enables cross-host merge, single reading host and fleet Gemini concurrency cap. */
  readonly fleet?: FleetContext
  /** Concurrent Gemini agent cap: default 4 per agent and 8 fleet total across hosts. */
  readonly geminiCap?: GeminiCap
}

/** A group's answer at a time, for the tool and RPC: always carries OpenStatus with finite time when not now. */
export interface GroupAnswer {
  readonly group: string
  readonly label: string
  readonly answer: Answer
  readonly open: OpenStatus
}

/** What a `read` came to, in words, and the rows after it. */
export interface ReadAnswer {
  readonly note: string
  readonly lines: ReadonlyArray<string>
}

/** Optional metadata when recording a pane limit (e.g. a workbox pane read from the Mac). */
export interface RecordOptions {
  readonly host?: string
  readonly at?: number
}

export interface Source {
  /** Antigravity's rows from the merged record (or stored local state when standalone). */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** Each group's "open now, else when" answer from the merged record, or the one group/model named. */
  readonly open: (groupOrModel: Option.Option<string>) => Effect.Effect<ReadonlyArray<GroupAnswer>>
  /** A pane's text: its live, non-replayed limit frame(s) recorded with host and seen-at; none when nothing new was recorded. */
  readonly record: (text: string, groupOrModel: Option.Option<string>, options?: RecordOptions) => Effect.Effect<Option.Option<PaneLimit>>
  /** A pane on the group (every group when none) ran a turn since its limit: forget the limit. */
  readonly clear: (group: Option.Option<string>) => Effect.Effect<void>
  /** Read Google now unless the floor holds; `consent` allows the one keychain attempt. */
  readonly read: (consent: boolean) => Effect.Effect<ReadAnswer>
  /** This host's own Antigravity report (never carries a token or peer data), for the fleet Report. */
  readonly report: Effect.Effect<AntigravityReport>
  /** Start gate before starting or resuming an agy pane/worker; with `recordStart`, records a Gemini pane busy when admitted. */
  readonly gate: (query: GateQuery & { readonly recordStart?: boolean }) => Effect.Effect<GateDecision>
  /** Refresh a running Gemini pane's live busy entry so long-running panes (> 60m) never drop out of the concurrency count. */
  readonly heartbeat: (paneId: string, agent?: string) => Effect.Effect<void>
  /** Release a finished Gemini pane's busy entry immediately on exit. */
  readonly release: (paneId: string) => Effect.Effect<void>
}

const isRefused = (failure: ReadFailed) =>
  Match.value(failure.why).pipe(
    Match.tag("RequestFailed", (request) => request.why === "refused"),
    Match.orElse(() => false),
  )

const fresh = (access: Access, now: number) => !Option.exists(access.expiresAt, (at) => at <= now + EXPIRY_MARGIN_MS)

/** The sign-in a read uses, decided under the lock. */
type Plan =
  | { readonly kind: "use"; readonly signIn: SignIn; readonly access: Option.Option<Access> }
  | { readonly kind: "keychain" }

/** What the decision under the lock came to. */
type Decision =
  | { readonly kind: "floored"; readonly nextReadAt: number }
  | { readonly kind: "delegated"; readonly leader: string; readonly host: string }
  | { readonly kind: "unavailable"; readonly why: Why }
  | { readonly kind: "go"; readonly id: string; readonly plan: Plan }

const keep = (state: State, decision: Decision): readonly [State, Decision] => [state, decision]

/** The same refreshable sign-in: an access token from it may be used again. */
const sameRefreshable = (left: SignIn, right: SignIn) =>
  left._tag === "Refreshable" &&
  right._tag === "Refreshable" &&
  left.clientId === right.clientId &&
  Redacted.value(left.refreshToken) === Redacted.value(right.refreshToken)

/** A failure's reason, never its message (which could quote a response or a path): its tag or kind. */
export const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause)
  if (Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag)) return failure._tag
  if (failure instanceof Error) return failure.name
  return "an unexpected failure"
}

export const make = Effect.fn("Antigravity.make")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient
  /** A token this authority holds from a sign-in, in memory only, until it expires or is refused. */
  const held = yield* Ref.make(Option.none<{ readonly signIn: SignIn; readonly access: Access }>())
  /** One read at a time in this process; the file's lock serializes processes. */
  const reading = yield* Semaphore.make(1)
  const now = Clock.currentTimeMillis

  const contained = (cause: Cause.Cause<unknown>) => Why.cases.Contained.make({ reason: reasonOf(cause) })
  const unknownLines = (cause: Cause.Cause<unknown>) => statusLines(evolve({ failures: 0, nextReadAt: 0 }, Event.cases.Unavailable.make({ at: 0, why: contained(cause) })), 0)

  const heldFor = (at: number) => Effect.map(Ref.get(held), (kept) => Option.filter(kept, (entry) => fresh(entry.access, at)))

  /** Whether this host has a readable sign-in right now (token files or held memory token; never touches keychain). */
  const hasReadableSignIn = (at: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const file = yield* fromFiles(options.places, options.profile)
      if (Option.isSome(file)) {
        return SignInSchema.match(file.value, {
          Refreshable: () => true,
          Access: (access) => !Option.exists(Option.fromUndefinedOr(access.expiresAt), (exp) => exp <= at + EXPIRY_MARGIN_MS),
        })
      }
      return Option.isSome(yield* heldFor(at))
    }).pipe(Effect.catchCause(() => Effect.succeed(false)))

  const localHost = Option.getOrElse(
    Option.orElse(Option.map(Option.fromUndefinedOr(options.fleet), (fleet) => fleet.host), () => Option.fromUndefinedOr(options.host)),
    () => "local",
  )

  const singleHostView = (host: string): FleetView => ({ host, peers: {}, peerNames: [], ownBusy: [], peerBusy: [] })

  const fleetView = Option.match(Option.fromUndefinedOr(options.fleet), {
    onNone: () => Effect.succeed(singleHostView(localHost)),
    onSome: (fleet) => fleet.read.pipe(Effect.catchCause(() => Effect.succeed(singleHostView(fleet.host)))),
  })

  const mergedView = Effect.gen(function* () {
    const state = yield* options.store.load
    const at = yield* now
    const view = yield* fleetView
    const readable = yield* hasReadableSignIn(at)
    const own = fromLocalState(view.host, state, at, readable)
    const hasPeers = view.peerNames.length > 0 || Object.keys(view.peers).length > 0
    const merged: MergedRecord = Match.value(hasPeers).pipe(
      Match.when(true, () => mergeFleet(own, view.peers, view.peerNames, at)),
      Match.orElse(() => fromReport(own, at)),
    )
    return { state, at, view, own, merged, hasPeers }
  })

  const report: Effect.Effect<AntigravityReport> = Effect.gen(function* () {
    const state = yield* options.store.load
    const at = yield* now
    const view = yield* fleetView
    const readable = yield* hasReadableSignIn(at)
    return fromLocalState(view.host, state, at, readable)
  }).pipe(
    Effect.catchCause(() =>
      Effect.map(now, (at): AntigravityReport => ({
        host: localHost,
        at,
        readableSignIn: false,
        limits: [],
        failure: { at, why: WireWhy.cases.Contained.make({}) },
      })),
    ),
  )

  /** Under the lock: the cross-host floor, the sole reading host, then the sign-in, then the attempt committed. */
  const decide = (consent: boolean, at: number, view: FleetView) =>
    options.store.transact((stored) =>
      Effect.gen(function* () {
        const hasPeers = view.peerNames.length > 0 || Object.keys(view.peers).length > 0
        const peerMerged = Match.value(hasPeers).pipe(
          Match.when(true, () => mergeFleet(fromLocalState(view.host, stored, at, false), view.peers, view.peerNames, at)),
          Match.orElse(() => fromReport(fromLocalState(view.host, stored, at, false), at)),
        )
        // A floored read records no consent and touches no token file: a consent is for this read, never for a later one nobody asked for.
        const floor = Math.max(stored.nextReadAt, mergedNextReadAt(peerMerged))
        if (!due({ ...stored, nextReadAt: floor }, at)) return keep(stored, { kind: "floored", nextReadAt: floor })
        const file = yield* fromFiles(options.places, options.profile)
        const kept = yield* heldFor(at)
        const fileFresh = Option.exists(file, (signIn) =>
          SignInSchema.match(signIn, {
            Refreshable: () => true,
            Access: (access) => !Option.exists(Option.fromUndefinedOr(access.expiresAt), (exp) => exp <= at + EXPIRY_MARGIN_MS),
          }),
        )
        const readable = fileFresh || Option.isSome(kept)
        // One reading host across the fleet: the lowest host id with a readable sign-in reads Google.
        if (hasPeers) {
          const merged = mergeFleet(fromLocalState(view.host, stored, at, readable), view.peers, view.peerNames, at)
          const leader = readingHost(merged)
          if (Option.isSome(leader) && leader.value !== view.host) {
            return keep(stored, { kind: "delegated", leader: leader.value, host: view.host })
          }
        }
        const state = Match.value(consent).pipe(
          Match.when(true, () => evolve(stored, Event.cases.ConsentGiven.make({ at }))),
          Match.orElse(() => stored),
        )
        const plan: Option.Option<Plan> = Option.match(file, {
          onSome: (signIn) =>
            Option.some<Plan>({ kind: "use", signIn, access: Option.map(Option.filter(kept, (entry) => sameRefreshable(entry.signIn, signIn)), (entry) => entry.access) }),
          onNone: () =>
            Option.match(kept, {
              onSome: (entry) => Option.some<Plan>({ kind: "use", signIn: entry.signIn, access: Option.some(entry.access) }),
              // The keychain only for a business sign-in, as T3 reads it; a personal one reads its managed profile's files alone.
              onNone: () => Option.map(Option.liftPredicate(state, (current) => options.auth === "business" && consent && keychainAllowed(current)), (): Plan => ({ kind: "keychain" })),
            }),
        })
        if (Option.isNone(plan)) {
          const why = Match.value(options.auth).pipe(
            Match.when("personal", () => Why.cases.NotSignedIn.make({ profile: options.profile })),
            Match.orElse(() => Why.cases.NotHeld.make({})),
          )
          return keep(evolve(state, Event.cases.Unavailable.make({ at, why })), { kind: "unavailable", why })
        }
        const id = `${at}-${yield* Random.nextIntBetween(0, 1_000_000_000)}`
        const attempted = evolve(state, Event.cases.Attempted.make({ id, at, keychain: plan.value.kind === "keychain" }))
        return keep(attempted, { kind: "go", id, plan: plan.value })
      }),
    )

  /** The one keychain attempt this consent bought; its outcome committed whatever it is. */
  const fromKeychainOnce = Effect.fn("Antigravity.keychainOnce")(function* () {
    const found = fromKeychain(yield* options.places.keychain)
    const outcome = Option.getOrElse(Option.fromUndefinedOr(found.keychain), () => "failed" as const)
    const at = yield* now
    yield* options.store
      .transact((state) => Effect.succeed([evolve(state, Event.cases.KeychainTried.make({ at, outcome })), true] as const))
      .pipe(Effect.mapError((failure) => new ReadFailed({ why: Why.cases.Contained.make({ reason: failure._tag }) })))
    return yield* Lookup.match(found, {
      Missing: ({ why }) => Effect.fail(new ReadFailed({ why })),
      Found: ({ signIn }) => Effect.succeed(signIn),
    })
  })

  const project = (signIn: SignIn) =>
    SignInSchema.match(signIn, { Refreshable: (entry) => Option.fromUndefinedOr(entry.project), Access: () => Option.none<string>() })

  /** With the lock let go: the sign-in's token, then Google; the result committed if still the state's attempt. */
  const act = Effect.fn("Antigravity.act")(function* (id: string, plan: Plan) {
    const outcome = yield* Effect.gen(function* () {
      const signIn = yield* Match.value(plan).pipe(
        Match.when({ kind: "use" }, (use) => Effect.succeed(use.signIn)),
        Match.orElse(() => fromKeychainOnce()),
      )
      const access = yield* Option.match(Match.value(plan).pipe(Match.when({ kind: "use" }, (use) => use.access), Match.orElse(() => Option.none<Access>())), {
        onSome: Effect.succeed,
        onNone: () => accessOf(signIn, options.endpoints),
      })
      yield* Ref.set(held, Option.some({ signIn, access }))
      const agent = yield* options.agent
      return yield* readQuota(access, endpointOrder(options.endpoints, options.auth), agent, project(signIn)).pipe(
        // A bare token Google refuses has expired or was revoked: only an Antigravity turn renews it.
        Effect.mapError((failure) =>
          Match.value({ refused: isRefused(failure), bare: signIn._tag === "Access" }).pipe(
            Match.when({ refused: true, bare: true }, () => new ReadFailed({ why: Why.cases.SignInExpired.make({}) })),
            Match.orElse(() => failure),
          ),
        ),
      )
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)
    // A token Google refused, or one that expired, is let go: a keychain one comes back only with a new consent.
    const letGo = Option.exists(Result.getFailure(outcome), (failure) => isRefused(failure) || failure.why._tag === "SignInExpired")
    if (letGo) yield* Ref.set(held, Option.none())
    const at = yield* now
    const event = Result.match(outcome, {
      onFailure: (failure) => Event.cases.Failed.make({ attempt: id, at, why: failure.why }),
      onSuccess: (windows) => Event.cases.Read.make({ attempt: id, at, windows }),
    })
    yield* options.store.transact((state) => Effect.succeed([evolve(state, event), true] as const))
    return Result.match(outcome, { onFailure: (failure) => Option.some(failure.why), onSuccess: () => Option.none<Why>() })
  })

  const lines = mergedView.pipe(
    Effect.map(({ state, merged, at, hasPeers }) =>
      Match.value(hasPeers).pipe(
        Match.when(true, () => mergedStatusLines(merged, at)),
        Match.orElse(() => statusLines(state, at)),
      ),
    ),
    Effect.catchCause((cause) => Effect.succeed(unknownLines(cause))),
  )

  const read = (consent: boolean) =>
    reading.withPermits(1)(
      Effect.gen(function* () {
        const view = yield* fleetView
        const decision: Decision = yield* decide(consent, yield* now, view)
        const note = yield* Match.value(decision).pipe(
          Match.when({ kind: "floored" }, (floored) => Effect.succeed(`Not read: a read was attempted within the floor (5 minutes after each attempt, longer after failures); the next read is possible at ${formatNotificationTime(floored.nextReadAt)}.`)),
          Match.when({ kind: "delegated" }, (delegated) => Effect.succeed(`Not read: ${delegated.leader} is the fleet's reading host (${delegated.host} leaves active reads to it).`)),
          Match.when({ kind: "unavailable" }, () => Match.value(options.auth).pipe(
            Match.when("personal", () => Effect.succeed(`Not read: no sign-in in the managed profile ${options.profile}. Sign in there (bun cmd/pool/antigravity-read.ts --profile-env ${options.profile} prints how).`)),
            Match.orElse(() => Effect.succeed("Not read: no token file, and no sign-in held. Read with consent to try the keychain once.")),
          )),
          Match.orElse((go) =>
            Effect.map(act(go.id, go.plan), (failure) =>
              Option.match(failure, { onNone: () => "Read now.", onSome: () => "Read attempted now; it gave no reading (below)." }),
            ),
          ),
        )
        return { note, lines: yield* lines }
      }),
    ).pipe(Effect.catchCause((cause) => Effect.succeed({ note: `Not read: ${reasonOf(cause)}.`, lines: unknownLines(cause) })))

  const geminiCap = Option.getOrElse(Option.fromUndefinedOr(options.geminiCap), () => DEFAULT_GEMINI_CAP)

  const gate = (query: GateQuery & { readonly recordStart?: boolean }): Effect.Effect<GateDecision> =>
    mergedView.pipe(
      Effect.flatMap(({ merged, at, view }) => {
        const decision = checkStartGate({
          merged,
          ownBusy: view.ownBusy,
          peerBusy: view.peerBusy,
          cap: geminiCap,
          now: at,
          query,
        })
        const shouldRecord =
          decision._tag === "Admitted" &&
          query.recordStart === true &&
          (decision.group === "gemini" || decision.group.startsWith("gemini-"))
        const record = Option.flatMap(Option.fromUndefinedOr(options.fleet), (fleet) => Option.fromUndefinedOr(fleet.recordBusy))
        return Match.value(shouldRecord).pipe(
          Match.when(true, () =>
            Option.match(record, {
              onNone: () => Effect.succeed(decision),
              onSome: (recordBusy) => {
                const paneId = Option.getOrElse(Option.fromUndefinedOr(query.paneId), () => `agy:${Option.getOrElse(Option.fromUndefinedOr(query.agent), () => "pane")}:${at}`)
                return Effect.as(recordBusy(paneId, geminiStartProvider(query.agent)).pipe(Effect.ignoreCause), decision)
              },
            }),
          ),
          Match.orElse(() => Effect.succeed(decision)),
        )
      }),
      Effect.catchCause(() =>
        Effect.succeed(
          GateDecision.cases.Admitted.make({
            group: Option.getOrElse(Option.orElse(Option.fromUndefinedOr(query.group), () => Option.fromUndefinedOr(query.model)), () => "gemini"),
            measured: false,
            answer: openDecisionAt(fromReport({ host: localHost, at: 0, readableSignIn: false, limits: [], failure: { at: 0, why: WireWhy.cases.Contained.make({}) } }, 0), 0, "gemini").answer,
            geminiFleetCount: 0,
            geminiAgentCount: 0,
          }),
        ),
      ),
    )

  return {
    lines,
    report,
    gate,
    open: (groupOrModel) =>
      mergedView.pipe(
        Effect.map(({ merged, at }) => {
          const wanted = Option.map(groupOrModel, (named) => Option.getOrElse(resolveGroup(named), () => named))
          return mergedGroupsOf(merged)
            .filter((entry) =>
              Option.getOrElse(
                Option.map(wanted, (named) => named.toLowerCase() === entry.id.toLowerCase() || named.toLowerCase() === entry.label.toLowerCase()),
                () => true,
              ),
            )
            .map((entry) => {
              const open = openDecisionAt(merged, at, entry.id)
              return { group: entry.id, label: entry.label, answer: open.answer, open }
            })
        }),
        Effect.catchCause(() =>
          Effect.succeed(
            groupsOf({ failures: 0, nextReadAt: 0 }).map((entry) => {
              const fallback = fromReport({ host: localHost, at: 0, readableSignIn: false, limits: [], failure: { at: 0, why: WireWhy.cases.Contained.make({}) } }, 0)
              const open = openDecisionAt(fallback, 0, entry.id)
              return { group: entry.id, label: entry.label, answer: open.answer, open }
            }),
          ),
        ),
      ),
    record: (text, groupOrModel, recordOptions?: RecordOptions) =>
      Effect.gen(function* () {
        const at = yield* now
        const frameAt = Option.flatMap(Option.fromUndefinedOr(recordOptions), (opts) => Option.fromUndefinedOr(opts.at))
        if (Option.isSome(validateRecordAt(frameAt, at))) return Option.none<PaneLimit>()
        const parsed = parsePaneLimits(text, at, Option.getOrUndefined(frameAt))
        if (parsed.length === 0) return Option.none<PaneLimit>()
        const view = yield* fleetView
        const host = Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(recordOptions), (opts) => Option.fromUndefinedOr(opts.host)), () => view.host)
        const callerGroup = Option.map(groupOrModel, (named) => Option.getOrElse(resolveGroup(named), () => named))
        // Cross-host liveness check: an Error ID never re-arms; a text-hash episode key suppresses repeats ONLY while live on a peer.
        const peerMerged = mergeFleet(fromLocalState(view.host, { failures: 0, nextReadAt: 0 }, at, false), view.peers, view.peerNames, at)
        return yield* options.store.transact((stored) => {
          let next = stored
          let lastRecorded = Option.none<PaneLimit>()
          for (const seen of parsed) {
            const group = Option.orElse(seen.group, () => callerGroup)
            if (isKeyLiveInMerged(peerMerged, at, group, seen.key)) continue
            const base = { seenAt: seen.seenAt, host, key: seen.key }
            const withReset = Option.match(seen.resetAt, { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
            const withGroup = Option.match(group, { onNone: () => withReset, onSome: (named) => ({ ...withReset, group: named }) })
            const evolved = evolve(next, Event.cases.LimitSeen.make({ limit: withGroup }))
            if (evolved !== next) {
              next = evolved
              lastRecorded = Option.some(Option.match(group, { onNone: () => seen, onSome: (named) => ({ ...seen, group: Option.some(named) }) }))
            }
          }
          return Effect.succeed([next, lastRecorded] as const)
        })
      }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<PaneLimit>()))),
    heartbeat: (paneId, agent) =>
      Option.match(Option.flatMap(Option.fromUndefinedOr(options.fleet), (fleet) => Option.fromUndefinedOr(fleet.recordBusy)), {
        onNone: () => Effect.void,
        onSome: (recordBusy) => recordBusy(paneId, geminiStartProvider(agent)).pipe(Effect.ignoreCause),
      }),
    release: (paneId) =>
      Option.match(Option.flatMap(Option.fromUndefinedOr(options.fleet), (fleet) => Option.fromUndefinedOr(fleet.releaseBusy)), {
        onNone: () => Effect.void,
        onSome: (releaseBusy) => releaseBusy(paneId).pipe(Effect.ignoreCause),
      }),
    clear: (group) =>
      options.store
        .transact((state) =>
          Effect.succeed([
            evolve(state, Option.match(group, { onNone: () => Event.cases.LimitCleared.make({}), onSome: (named) => Event.cases.LimitCleared.make({ group: named }) })),
            true,
          ] as const),
        )
        .pipe(Effect.catchCause((cause) => Effect.logWarning(`antigravity: a limit could not be cleared: ${reasonOf(cause)}`))),
    read,
  } satisfies Source
})
