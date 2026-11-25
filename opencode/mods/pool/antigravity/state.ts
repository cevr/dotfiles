// What the pool holds of Antigravity's quota, and what it answers from it: the
// last reading of the windows, the last read that failed and why, each group's
// limit an agy pane printed, the last read attempt, the last keychain attempt
// and an unused consent. A send or a status render reads this state only. A
// read of Google happens only when asked (the tool's read, the read command),
// at most once per READ_EVERY_MS after the last attempt, backing off on failure.
// An unknown window is never unlimited and never a hold by itself: with one
// unknown, "is it open" answers a typed unknown. Pure: no clock, no I/O.
import { Array as Arr, Match, Option, Schema } from "effect"
import { keyOf, Span, Window } from "./quota.ts"

const MINUTE = 60_000
/** At most one read of Google per sign-in in this long. */
export const READ_EVERY_MS = 5 * MINUTE
/** The longest wait after failed reads. */
export const BACKOFF_CAP_MS = 60 * MINUTE

/** What a keychain attempt came to; `started` until it answers. Each attempt uses one consent, whatever it comes to. */
export const KeychainOutcome = Schema.Literals(["started", "read", "absent", "denied", "failed", "timed-out"])
export type KeychainOutcome = typeof KeychainOutcome.Type

/** Why a request to Google gave no reading. */
export const RequestWhy = Schema.Literals(["refused", "rate-limited", "timed-out", "unreachable", "malformed", "failed"])
export type RequestWhy = typeof RequestWhy.Type

/** Why nothing, or not everything, can be said: each case has its own words (text.ts `whyText`). */
export const Why = Schema.TaggedUnion({
  /** No read has been made yet. */
  NotRead: {},
  /** No token file in the profile, and no keychain entry. */
  NoSignIn: {},
  /** No file, and this host has no keychain this can read (a Linux without one). */
  NotReadableHere: {},
  /** The sign-in's token has expired and cannot be refreshed from here. */
  SignInExpired: {},
  /** The keychain attempt was refused, failed or timed out: none again until the owner consents again. */
  KeychainRefused: { outcome: Schema.Literals(["denied", "failed", "timed-out"]) },
  /** No token file, and no sign-in held from a keychain read: the keychain is read only with the owner's consent. */
  NotHeld: {},
  /** A personal sign-in: no token file in the managed profile `profile`; it is never read from the keychain. */
  NotSignedIn: { profile: Schema.String },
  /** The Antigravity code itself failed here: contained, with its reason. */
  Contained: { reason: Schema.String },
  /** Google's answer was no reading: its status when it answered. */
  RequestFailed: { why: RequestWhy, status: Schema.optionalKey(Schema.Finite) },
  /** Google answered, with no quota this reads. */
  NoQuota: {},
  /** A request was to go to a host that is not Google's, and did not. */
  HostRefused: { host: Schema.String },
  /** The group's window of this length was not in the last reading, or has reset since. */
  WindowUnknown: { group: Schema.String, span: Span },
  /** A full window with no reset time. */
  FullWithoutReset: { group: Schema.String, span: Span },
})
export type Why = typeof Why.Type

/** The last limit a pane printed: when, until when if it said, and the group if one was named (else every group). */
export const SeenLimit = Schema.Struct({
  seenAt: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
  group: Schema.optionalKey(Schema.String),
})
export type SeenLimit = typeof SeenLimit.Type

/** The newest limit a pane printed on one group. */
export const GroupLimit = Schema.Struct({ group: Schema.String, seenAt: Schema.Finite, resetAt: Schema.optionalKey(Schema.Finite) })
export type GroupLimit = typeof GroupLimit.Type

export const Reading = Schema.Struct({ at: Schema.Finite, windows: Schema.Array(Window) })
export type Reading = typeof Reading.Type

/** A read of Google decided and committed under the state file's lock, before anything is sent. */
export const Attempt = Schema.Struct({ id: Schema.String, at: Schema.Finite })
export type Attempt = typeof Attempt.Type

/** The state, as kept on disk too: no token, ever. */
export const State = Schema.Struct({
  reading: Schema.optionalKey(Reading),
  failure: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, why: Why })),
  failures: Schema.Finite,
  /** No read of Google before this, whoever asks: the last attempt plus READ_EVERY_MS, or its backoff. */
  nextReadAt: Schema.Finite,
  /** The last read of Google decided, whoever made it; only its own result is kept. */
  attempt: Schema.optionalKey(Attempt),
  /** Each group's newest pane limit; a limit naming no group is kept on every group. */
  limits: Schema.optionalKey(Schema.Array(GroupLimit)),
  /** The last keychain attempt and what it came to (`started` until it answers). */
  keychain: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, outcome: KeychainOutcome })),
  /** The owner's consent to one keychain attempt, not yet used: the attempt that uses it clears it. */
  consentAt: Schema.optionalKey(Schema.Finite),
})
export type State = typeof State.Type

export const EMPTY: State = { failures: 0, nextReadAt: 0 }

export const Event = Schema.TaggedUnion({
  /** A read was decided at `at`: the floor moves past it; with `keychain`, it uses the consent and is the one keychain attempt. */
  Attempted: { id: Schema.String, at: Schema.Finite, keychain: Schema.Boolean },
  /** Attempt `attempt` answered these windows at `at`. */
  Read: { attempt: Schema.String, at: Schema.Finite, windows: Schema.Array(Window) },
  /** Attempt `attempt` gave no reading at `at`, for `why`. */
  Failed: { attempt: Schema.String, at: Schema.Finite, why: Why },
  /** No read was made at `at`, for `why` (no sign-in held, say): shown, with no floor and no backoff. */
  Unavailable: { at: Schema.Finite, why: Why },
  /** A pane printed a limit. */
  LimitSeen: { limit: SeenLimit },
  /** A pane on the group (every group when none is named) ran a turn since its limit: the limit is gone. */
  LimitCleared: { group: Schema.optionalKey(Schema.String) },
  /** The keychain attempt came to `outcome`. */
  KeychainTried: { at: Schema.Finite, outcome: KeychainOutcome },
  /** The owner consented to one keychain attempt. */
  ConsentGiven: { at: Schema.Finite },
})
export type Event = typeof Event.Type

/** How long after the `failures`th failure in a row the next read waits: twice as long each time, at most an hour. */
export const backoffMs = (failures: number) => Math.min(READ_EVERY_MS * 2 ** Math.max(0, failures), BACKOFF_CAP_MS)

const withoutFailure = (state: State): State => {
  const { failure: _dropped, ...rest } = state
  return rest
}

const withoutConsent = (state: State): State => {
  const { consentAt: _dropped, ...rest } = state
  return rest
}

/** Whether `id` is the state's attempt: a result of any other (an older one, another process's) changes nothing. */
const isCurrent = (state: State, id: string) => Option.exists(Option.fromUndefinedOr(state.attempt), (attempt) => attempt.id === id)

const attemptAt = (state: State) => Option.getOrElse(Option.map(Option.fromUndefinedOr(state.attempt), (attempt) => attempt.at), () => 0)

const ifCurrent = (state: State, id: string, next: () => State): State =>
  Match.value(isCurrent(state, id)).pipe(
    Match.when(true, next),
    Match.orElse(() => state),
  )

/** An attempt uses its read's consent or drops it unused: a consent is for one read, never a later one nobody asked for. */
const attempted = (state: State, id: string, at: number, keychain: boolean): State => {
  const base = { ...withoutConsent(state), attempt: { id, at }, nextReadAt: at + backoffMs(state.failures) }
  return Match.value(keychain).pipe(
    Match.when(true, () => ({ ...base, keychain: { at, outcome: "started" as const } })),
    Match.orElse(() => base),
  )
}

const limitsOf = (state: State): ReadonlyArray<GroupLimit> => Option.getOrElse(Option.fromUndefinedOr(state.limits), () => [])

/** The group ids a name means (a group's id or label, any case), every group when none is named; an unknown name as given. */
const namedGroups = (state: State, name: Option.Option<string>): ReadonlyArray<string> =>
  Option.match(name, {
    onNone: () => groupsOf(state).map((group) => group.id),
    onSome: (named) => [
      Option.getOrElse(
        Option.map(
          Arr.findFirst(groupsOf(state), (group) => [group.id, group.label].some((key) => key.toLowerCase() === named.toLowerCase())),
          (group) => group.id,
        ),
        () => named,
      ),
    ],
  })

export const evolve = (state: State, event: Event): State =>
  Event.match(event, {
    Attempted: ({ id, at, keychain }) => attempted(state, id, at, keychain),
    Read: ({ attempt, at, windows }) => ifCurrent(state, attempt, () => ({ ...withoutFailure(state), reading: { at, windows }, failures: 0 })),
    Failed: ({ attempt, at, why }) =>
      ifCurrent(state, attempt, () => ({ ...state, failure: { at, why }, failures: state.failures + 1, nextReadAt: attemptAt(state) + backoffMs(state.failures + 1) })),
    Unavailable: ({ at, why }) => ({ ...state, failure: { at, why } }),
    LimitSeen: ({ limit }) =>
      ({
        ...state,
        limits: namedGroups(state, Option.fromUndefinedOr(limit.group)).reduce((limits, group) => {
          const seen = Option.match(Option.fromUndefinedOr(limit.resetAt), {
            onNone: (): GroupLimit => ({ group, seenAt: limit.seenAt }),
            onSome: (resetAt): GroupLimit => ({ group, seenAt: limit.seenAt, resetAt }),
          })
          return Match.value(limits.some((before) => before.group === group && before.seenAt > limit.seenAt)).pipe(
            Match.when(true, () => limits),
            Match.orElse(() => [...limits.filter((before) => before.group !== group), seen]),
          )
        }, limitsOf(state)),
      }),
    LimitCleared: ({ group }) => {
      const cleared = namedGroups(state, Option.fromUndefinedOr(group))
      return { ...state, limits: limitsOf(state).filter((seen) => !cleared.includes(seen.group)) }
    },
    KeychainTried: ({ at, outcome }) => ({ ...state, keychain: { at, outcome } }),
    ConsentGiven: ({ at }) => ({ ...state, consentAt: at }),
  })

/** Whether a read of Google may be made at `now`: the floor after the last attempt, whoever made it. */
export const due = (state: State, now: number) => now >= state.nextReadAt

/** Whether a keychain attempt may be made: only with an unused consent. */
export const keychainAllowed = (state: State) => Option.isSome(Option.fromUndefinedOr(state.consentAt))

/** A window as the pool shows it: read, or unknown with why. */
export const Shown = Schema.TaggedUnion({ Known: { window: Window }, Unknown: { why: Why } })
export type Shown = typeof Shown.Type

/** The groups the last reading names, the two Antigravity always meters first. */
export const groupsOf = (state: State): ReadonlyArray<{ readonly id: string; readonly label: string }> => {
  const read = Option.getOrElse(Option.map(Option.fromUndefinedOr(state.reading), (reading) => reading.windows), () => [])
  const base = [
    { id: "gemini", label: "Gemini" },
    { id: "claude-gpt", label: "Claude & GPT (shared)" },
  ]
  return Arr.dedupeWith([...base, ...read.map((window) => ({ id: window.group, label: window.label }))], (left, right) => left.id === right.id)
}

/** The last reading's window of `group` and `span` at `now`; unknown when it was not read or has reset since. */
export const windowAt = (state: State, now: number, group: string, span: Span): Shown => {
  const unknown = Shown.cases.Unknown.make({ why: Why.cases.WindowUnknown.make({ group, span }) })
  return Option.match(
    Option.flatMap(Option.fromUndefinedOr(state.reading), (reading) => Arr.findFirst(reading.windows, (window) => keyOf(window) === keyOf({ group, span }))),
    {
      onNone: () => unknown,
      onSome: (window) =>
        Match.value(Option.exists(Option.fromUndefinedOr(window.resetAt), (at) => at <= now)).pipe(
          Match.when(true, (): Shown => unknown),
          Match.orElse((): Shown => Shown.cases.Known.make({ window })),
        ),
    },
  )
}

/**
 * Is a group open: measured open (a reading with room), limited until a
 * time, limited with its reset unknown (a pane's limit gave none), not
 * measured (no reading and no live limit: usable, but never called open, and
 * never a hold), or a typed unknown (a reading that leaves a window unsaid).
 */
export const Answer = Schema.TaggedUnion({
  Open: {},
  Limited: { until: Schema.Finite, by: Schema.Literals(["limit", "window"]) },
  LimitedResetUnknown: { seenAt: Schema.Finite },
  /** `since`: when the group's last limit reset, if one was seen. */
  Unmeasured: { why: Why, since: Schema.optionalKey(Schema.Finite) },
  Unknown: { why: Why },
})
export type Answer = typeof Answer.Type

const limitOn = (state: State, group: string) => Arr.findFirst(limitsOf(state), (limit) => limit.group === group)

/** Why nothing is read: the last failure's reason, else not read yet. */
const unreadWhy = (state: State): Why =>
  Option.getOrElse(Option.map(Option.fromUndefinedOr(state.failure), (failure) => failure.why), () => Why.cases.NotRead.make({}))

/**
 * Whether `group` is open at `now`. A limit a pane printed holds until its
 * reset; with none given it holds, its reset unknown, until a reading after
 * it or a clear. With no reading it is not measured. Then a full window holds
 * until its reset (the last of them), or is unknown with none. Open only with
 * both the 5-hour and the weekly window read and neither full; any other case
 * is unknown, never open.
 */
export const answerAt = (state: State, now: number, group: string): Answer => {
  const reading = Option.fromUndefinedOr(state.reading)
  const limit = limitOn(state, group)
  const limitedUntil = Option.flatMap(limit, (seen) => Option.filter(Option.fromUndefinedOr(seen.resetAt), (at) => at > now))
  if (Option.isSome(limitedUntil)) return Answer.cases.Limited.make({ until: limitedUntil.value, by: "limit" })
  const silent = Option.filter(limit, (seen) =>
    Option.isNone(Option.fromUndefinedOr(seen.resetAt)) && !Option.exists(reading, (read) => read.at > seen.seenAt),
  )
  if (Option.isSome(silent)) return Answer.cases.LimitedResetUnknown.make({ seenAt: silent.value.seenAt })
  if (Option.isNone(reading))
    return Option.match(Option.flatMap(limit, (seen) => Option.fromUndefinedOr(seen.resetAt)), {
      onNone: () => Answer.cases.Unmeasured.make({ why: unreadWhy(state) }),
      onSome: (since) => Answer.cases.Unmeasured.make({ why: unreadWhy(state), since }),
    })
  const spans: ReadonlyArray<Span> = ["5h", "7d", "quota"]
  const known = spans.flatMap((span) => {
    const shown = windowAt(state, now, group, span)
    return Shown.match(shown, { Known: ({ window }) => [window], Unknown: () => [] })
  })
  const full = known.filter((window) => window.used >= 1)
  const fullWithoutReset = Arr.findFirst(full, (window) => Option.isNone(Option.fromUndefinedOr(window.resetAt)))
  if (Option.isSome(fullWithoutReset))
    return Answer.cases.Unknown.make({ why: Why.cases.FullWithoutReset.make({ group, span: fullWithoutReset.value.span }) })
  const resets = full.flatMap((window) => Option.toArray(Option.fromUndefinedOr(window.resetAt)))
  if (Arr.isReadonlyArrayNonEmpty(resets)) return Answer.cases.Limited.make({ until: Math.max(...resets), by: "window" })
  const missing = Arr.findFirst(["5h", "7d"] as const, (span) => !known.some((window) => window.span === span))
  return Option.match(missing, {
    onNone: () => Answer.cases.Open.make({}),
    onSome: (span) => Answer.cases.Unknown.make({ why: Why.cases.WindowUnknown.make({ group, span }) }),
  })
}
