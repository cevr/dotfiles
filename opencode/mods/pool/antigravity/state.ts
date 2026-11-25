// What the pool holds of Antigravity's quota, and what it answers from it: the
// last reading of the windows, the last read that failed and why, the last
// limit an agy pane printed, and the one keychain attempt. A send or a status
// render reads this state only; a read of Google is the reader's, on its own
// schedule (at most once per READ_EVERY_MS, backing off on each failure).
// An unknown window is never unlimited and never a hold by itself: with one
// unknown, "is it open" answers a typed unknown. Pure: no clock, no I/O.
import { Array as Arr, Match, Option, Schema } from "effect"
import { keyOf, Span, Window } from "./quota.ts"

const MINUTE = 60_000
/** At most one read of Google per sign-in in this long. */
export const READ_EVERY_MS = 5 * MINUTE
/** The longest wait after failed reads. */
export const BACKOFF_CAP_MS = 60 * MINUTE

/** What a keychain attempt came to. `denied`, `failed` and `timed-out` stop further attempts until the owner asks again. */
export const KeychainOutcome = Schema.Literals(["read", "absent", "denied", "failed", "timed-out"])
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
  /** The keychain read was refused, failed or timed out: not tried again until the owner asks. */
  KeychainRefused: { outcome: Schema.Literals(["denied", "failed", "timed-out"]) },
  /** The keychain is read only when the owner asks, and has not been. */
  KeychainNotAsked: {},
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

/** The state, as kept on disk too: no token, ever. */
export const State = Schema.Struct({
  reading: Schema.optionalKey(Reading),
  failure: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, why: Why })),
  failures: Schema.Finite,
  nextReadAt: Schema.Finite,
  /** Each group's newest pane limit; a limit naming no group is kept on every group. */
  limits: Schema.optionalKey(Schema.Array(GroupLimit)),
  keychain: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, outcome: KeychainOutcome })),
  /** When the owner last asked, through the tool, to read again (the keychain too). */
  askedAt: Schema.optionalKey(Schema.Finite),
})
export type State = typeof State.Type

export const EMPTY: State = { failures: 0, nextReadAt: 0 }

export const Event = Schema.TaggedUnion({
  /** A read of Google answered these windows at `at`. */
  Read: { at: Schema.Finite, windows: Schema.Array(Window) },
  /** A read at `at` gave no reading, for `why`. */
  Failed: { at: Schema.Finite, why: Why },
  /** A pane printed a limit. */
  LimitSeen: { limit: SeenLimit },
  /** A pane on the group (every group when none is named) ran a turn since its limit: the limit is gone. */
  LimitCleared: { group: Schema.optionalKey(Schema.String) },
  /** The one keychain attempt came to `outcome`. */
  KeychainTried: { at: Schema.Finite, outcome: KeychainOutcome },
  /** The owner asked, through the tool, to read again: the keychain too. */
  RetryAsked: { at: Schema.Finite },
})
export type Event = typeof Event.Type

/** How long after the `failures`th failure in a row the next read waits: twice as long each time, at most an hour. */
export const backoffMs = (failures: number) => Math.min(READ_EVERY_MS * 2 ** Math.max(0, failures), BACKOFF_CAP_MS)

const withoutFailure = (state: State): State => {
  const { failure: _dropped, ...rest } = state
  return rest
}

const withoutKeychain = (state: State): State => {
  const { keychain: _dropped, ...rest } = state
  return rest
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
    Read: ({ at, windows }) => ({ ...withoutFailure(state), reading: { at, windows }, failures: 0, nextReadAt: at + READ_EVERY_MS }),
    Failed: ({ at, why }) => ({ ...state, failure: { at, why }, failures: state.failures + 1, nextReadAt: at + backoffMs(state.failures + 1) }),
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
    RetryAsked: ({ at }) => ({ ...withoutKeychain(state), failures: 0, nextReadAt: at, askedAt: at }),
  })

/** Whether a read is due at `now`. */
export const due = (state: State, now: number) => now >= state.nextReadAt

/** Whether the keychain may be tried: never again after a refusal, a failure or a timeout, until the owner asks. */
export const keychainAllowed = (state: State) =>
  !Option.exists(Option.fromUndefinedOr(state.keychain), (tried) => tried.outcome === "denied" || tried.outcome === "failed" || tried.outcome === "timed-out")

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
