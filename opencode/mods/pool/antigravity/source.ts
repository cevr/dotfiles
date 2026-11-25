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
import { type UsageLimit, parseLimit } from "./limit.ts"
import { type Access, type AuthMethod, accessOf, EXPIRY_MARGIN_MS, endpointOrder, type Endpoints, ReadFailed, readQuota } from "./reader.ts"
import { fromFiles, fromKeychain, Lookup, type Places, SignIn as SignInSchema, type SignIn } from "./signin.ts"
import { type Answer, answerAt, due, Event, evolve, groupsOf, keychainAllowed, type State, Why } from "./state.ts"
import { statusLines } from "./text.ts"

/** The state file's store: never a token. */
export interface Store {
  /** The state on disk now; a fresh one when none reads. */
  readonly load: Effect.Effect<State, StoreFailed>
  /** `step` run on the state on disk under the file's lock; what it returns saved before the lock is let go. */
  readonly transact: <A, R>(step: (state: State) => Effect.Effect<readonly [State, A], never, R>) => Effect.Effect<A, StoreFailed, R>
}

/** The state file could not be locked, read or written. */
export class StoreFailed extends Schema.TaggedError<StoreFailed>()("StoreFailed", { what: Schema.String }) {}

export interface Options {
  /** The CLI's profile directory: the managed one (profile.ts) by default.  */
  readonly profile: string
  readonly places: Places
  readonly store: Store
  readonly auth: AuthMethod
  readonly endpoints: Endpoints
  /** The user agent requests carry (reader.ts `userAgent`), worked out only when a read is made. */
  readonly agent: Effect.Effect<string>
}

/** A group's answer at a time, for the tool. */
export interface GroupAnswer {
  readonly group: string
  readonly label: string
  readonly answer: Answer
}

/** What a `read` came to, in words, and the rows after it. */
export interface ReadAnswer {
  readonly note: string
  readonly lines: ReadonlyArray<string>
}

export interface Source {
  /** Antigravity's rows from the stored state (text.ts `statusLines`). */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** Each group's answer from the stored state, or the one group named. */
  readonly open: (group: Option.Option<string>) => Effect.Effect<ReadonlyArray<GroupAnswer>>
  /** A pane's text: its limit recorded when it is one; none when it is not (or the store failed). */
  readonly record: (text: string, group: Option.Option<string>) => Effect.Effect<Option.Option<UsageLimit>>
  /** A pane on the group (every group when none) ran a turn since its limit: forget the limit. */
  readonly clear: (group: Option.Option<string>) => Effect.Effect<void>
  /** Read Google now unless the floor holds; `consent` allows the one keychain attempt. */
  readonly read: (consent: boolean) => Effect.Effect<ReadAnswer>
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

  /** Under the lock: the floor, then the sign-in, then the attempt committed. */
  const decide = (consent: boolean, at: number) =>
    options.store.transact((stored) =>
      Effect.gen(function* () {
        // A floored read records no consent: a consent is for this read, never for a later one nobody asked for.
        if (!due(stored, at)) return keep(stored, { kind: "floored", nextReadAt: stored.nextReadAt })
        const state = Match.value(consent).pipe(
          Match.when(true, () => evolve(stored, Event.cases.ConsentGiven.make({ at }))),
          Match.orElse(() => stored),
        )
        const file = yield* fromFiles(options.places, options.profile)
        const kept = yield* heldFor(at)
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

  const loaded = Effect.gen(function* () {
    return { state: yield* options.store.load, at: yield* now }
  })

  const lines = loaded.pipe(
    Effect.map(({ state, at }) => statusLines(state, at)),
    Effect.catchCause((cause) => Effect.succeed(unknownLines(cause))),
  )

  const read = (consent: boolean) =>
    reading.withPermits(1)(
      Effect.gen(function* () {
        const decision: Decision = yield* decide(consent, yield* now)
        const note = yield* Match.value(decision).pipe(
          Match.when({ kind: "floored" }, (floored) => Effect.succeed(`Not read: a read was attempted within the floor (5 minutes after each attempt, longer after failures); the next read is possible at ${formatNotificationTime(floored.nextReadAt)}.`)),
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

  return {
    lines,
    open: (group) =>
      loaded.pipe(
        Effect.map(({ state, at }) =>
          groupsOf(state)
            .filter((entry) => Option.getOrElse(Option.map(group, (named) => named === entry.id || named === entry.label), () => true))
            .map((entry) => ({ group: entry.id, label: entry.label, answer: answerAt(state, at, entry.id) })),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed(
            groupsOf({ failures: 0, nextReadAt: 0 }).map((entry) => ({ group: entry.id, label: entry.label, answer: answerAt({ failures: 0, nextReadAt: 0, failure: { at: 0, why: contained(cause) } }, 0, entry.id) })),
          ),
        ),
      ),
    record: (text, group) =>
      Effect.gen(function* () {
        const limit = parseLimit(text, yield* now)
        yield* Option.match(limit, {
          onNone: () => Effect.void,
          onSome: (seen) => {
            const base = { seenAt: seen.seenAt }
            const withReset = Option.match(seen.resetAt, { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
            const withGroup = Option.match(group, { onNone: () => withReset, onSome: (named) => ({ ...withReset, group: named }) })
            return options.store.transact((state) => Effect.succeed([evolve(state, Event.cases.LimitSeen.make({ limit: withGroup })), true] as const))
          },
        })
        return limit
      }).pipe(Effect.catchCause(() => Effect.succeed(Option.none<UsageLimit>()))),
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
