// Antigravity's quota source: the state (state.ts) kept in memory and on disk,
// read from Google by the reader (reader.ts) at most once per READ_EVERY_MS
// with a backoff after each failure, a limit a pane printed recorded, and the
// questions the pool and the tool ask answered from the state alone, so no
// send and no status render ever waits on Google. One read at a time. The
// sign-in's access token is kept in memory only, until it expires.
import { Clock, Effect, Match, Option, Ref, Result, Semaphore } from "effect"
import { HttpClient } from "effect/http"
import { type UsageLimit, parseLimit } from "./limit.ts"
import { type Access, type AuthMethod, accessOf, EXPIRY_MARGIN_MS, endpointOrder, type Endpoints, ReadFailed, readQuota } from "./reader.ts"
import { type KeychainMode, Lookup, lookup, type Places, SignIn as SignInSchema, type SignIn } from "./signin.ts"
import { type Answer, answerAt, due, EMPTY, Event, evolve, groupsOf, type State, Why } from "./state.ts"
import { statusLines } from "./text.ts"

/** Where the state is kept across restarts: never a token. */
export interface Store {
  readonly load: Effect.Effect<Option.Option<State>>
  readonly save: (state: State) => Effect.Effect<void>
}

export interface Options {
  /** The CLI's profile directory (`~/.gemini/antigravity-cli` on the owner's hosts). */
  readonly profile: string
  readonly places: Places
  readonly store: Store
  readonly auth: AuthMethod
  readonly keychain: KeychainMode
  readonly endpoints: Endpoints
  /** The user agent requests carry (reader.ts `userAgent`). */
  readonly agent: string
}

/** A group's answer at a time, for the tool. */
export interface GroupAnswer {
  readonly group: string
  readonly label: string
  readonly answer: Answer
}

export interface Source {
  /** The state now. */
  readonly state: Effect.Effect<State>
  /** Antigravity's rows now (text.ts `statusLines`). */
  readonly lines: Effect.Effect<ReadonlyArray<string>>
  /** Each group's answer now, or the one group named. */
  readonly open: (group: Option.Option<string>) => Effect.Effect<ReadonlyArray<GroupAnswer>>
  /** A pane's text: its limit recorded when it is one; none when it is not. */
  readonly record: (text: string, group: Option.Option<string>) => Effect.Effect<Option.Option<UsageLimit>>
  /** Read Google when a read is due; otherwise nothing. */
  readonly refresh: Effect.Effect<void>
  /** The owner asked: forget a keychain refusal and read now. */
  readonly retry: Effect.Effect<void>
}

const isRefused = (failure: ReadFailed) =>
  Match.value(failure.why).pipe(
    Match.tag("RequestFailed", (request) => request.why === "refused"),
    Match.orElse(() => false),
  )

const fresh = (access: Access, now: number) => !Option.exists(access.expiresAt, (at) => at <= now + EXPIRY_MARGIN_MS)

export const make = Effect.fn("Antigravity.make")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient
  const state = yield* Ref.make(Option.getOrElse(yield* options.store.load, () => EMPTY))
  const held = yield* Ref.make(Option.none<{ readonly signIn: SignIn; readonly access: Access }>())
  const reading = yield* Semaphore.make(1)

  const apply = (events: ReadonlyArray<Event>) =>
    Ref.updateAndGet(state, (current) => events.reduce(evolve, current)).pipe(Effect.flatMap(options.store.save))

  /** The access token to read with: the one held while fresh, else the sign-in's. */
  const access = Effect.fn("Antigravity.access")(function* (now: number, current: State) {
    const kept = Option.filter(yield* Ref.get(held), (entry) => fresh(entry.access, now))
    if (Option.isSome(kept)) return kept.value
    const found = yield* lookup(options.places, options.profile, current, options.keychain)
    yield* Option.match(Option.fromUndefinedOr(found.keychain), {
      onNone: () => Effect.void,
      onSome: (outcome) => apply([Event.cases.KeychainTried.make({ at: now, outcome })]),
    })
    return yield* Lookup.match(found, {
      Missing: ({ why }) => Effect.fail(new ReadFailed({ why })),
      Found: ({ signIn }) =>
        accessOf(signIn, options.endpoints).pipe(
          Effect.tap((token) => Ref.set(held, Option.some({ signIn, access: token }))),
          Effect.map((token) => ({ signIn, access: token })),
        ),
    })
  })

  const project = (signIn: SignIn) =>
    SignInSchema.match(signIn, { Refreshable: (entry) => Option.fromUndefinedOr(entry.project), Access: () => Option.none<string>() })

  const read = Effect.fn("Antigravity.read")(function* () {
    const now = yield* Clock.currentTimeMillis
    const current = yield* Ref.get(state)
    if (!due(current, now)) return
    const outcome = yield* access(now, current).pipe(
      Effect.flatMap((entry) =>
        readQuota(entry.access, endpointOrder(options.endpoints, options.auth), options.agent, project(entry.signIn)).pipe(
          // A bare token Google refuses has expired or was revoked: only an Antigravity turn renews it.
          Effect.mapError((failure) => Match.value({ refused: isRefused(failure), bare: entry.signIn._tag === "Access" }).pipe(
            Match.when({ refused: true, bare: true }, () => new ReadFailed({ why: Why.cases.SignInExpired.make({}) })),
            Match.orElse(() => failure),
          )),
        ),
      ),
      Effect.result,
    )
    const at = yield* Clock.currentTimeMillis
    yield* apply([
      Result.match(outcome, {
        onFailure: (failure) => Event.cases.Failed.make({ at, why: failure.why }),
        onSuccess: (windows) => Event.cases.Read.make({ at, windows }),
      }),
    ])
    // A token Google refused, or one that expired, is let go: the next read looks the sign-in up again.
    const letGo = Option.exists(Result.getFailure(outcome), (failure) => isRefused(failure) || failure.why._tag === "SignInExpired")
    if (letGo) yield* Ref.set(held, Option.none())
  })

  const now = Clock.currentTimeMillis

  return {
    state: Ref.get(state),
    lines: Effect.gen(function* () {
      return statusLines(yield* Ref.get(state), yield* now)
    }),
    open: (group) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const at = yield* now
        return groupsOf(current)
          .filter((entry) => Option.getOrElse(Option.map(group, (named) => named === entry.id || named === entry.label), () => true))
          .map((entry) => ({ group: entry.id, label: entry.label, answer: answerAt(current, at, entry.id) }))
      }),
    record: (text, group) =>
      Effect.gen(function* () {
        const limit = parseLimit(text, yield* now)
        yield* Option.match(limit, {
          onNone: () => Effect.void,
          onSome: (seen) => {
            const base = { seenAt: seen.seenAt }
            const withReset = Option.match(seen.resetAt, { onNone: () => base, onSome: (resetAt) => ({ ...base, resetAt }) })
            const withGroup = Option.match(group, { onNone: () => withReset, onSome: (named) => ({ ...withReset, group: named }) })
            return apply([Event.cases.LimitSeen.make({ limit: withGroup })])
          },
        })
        return limit
      }),
    refresh: reading.withPermits(1)(read()).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    retry: Effect.gen(function* () {
      yield* apply([Event.cases.RetryAsked.make({ at: yield* now })])
      yield* Ref.set(held, Option.none())
    }),
  } satisfies Source
})
