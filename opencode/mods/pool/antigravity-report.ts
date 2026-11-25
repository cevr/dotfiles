// Wire schemas and tolerant decoder for Antigravity's cross-host fleet report:
// limit events, quota readings, read attempts and privacy-safe wire reasons.
// Lives at the root of mods/pool/ so the pool's domain files stay inside the
// pool domain fence; mods/pool/antigravity/* re-exports these.
// Never carries a token, secret, profile path, home directory, or user name.
import { Array as Arr, Match, Option, Schema, SchemaGetter } from "effect"

/** A window's length: the 5-hour window, the weekly one, or a model's quota of unstated length. */
export const Span = Schema.Literals(["5h", "7d", "quota"])
export type Span = typeof Span.Type

/** One window of one quota group as read: the share used (0 to 1) and, when Google says it, its reset (epoch ms). */
export const Window = Schema.Struct({
  group: Schema.String,
  label: Schema.String,
  span: Span,
  used: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
})
export type Window = typeof Window.Type

/** Why a request to Google gave no reading. */
export const RequestWhy = Schema.Literals(["refused", "rate-limited", "timed-out", "unreachable", "malformed", "failed"])
export type RequestWhy = typeof RequestWhy.Type

/** Local reasons (kept on disk and shown locally; may carry the local profile path). */
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
  /** A personal sign-in: no token file in the managed profile `profile`; local only, never sent on the wire. */
  NotSignedIn: { profile: Schema.String },
  /** A peer host has no sign-in in its managed profile (pathless wire reason). */
  NotSignedInRemote: {},
  /** The state file did not decode (kept beside it as `.undecodable`): read as an attempt made then, so the floor holds. */
  StateUnreadable: {},
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
  /** A fleet peer could not be read: shown stale with its age, never as open. */
  PeerStale: { peer: Schema.String, ageMs: Schema.Finite },
  /** A peer sent an unknown reason, field, or window span from a newer host. */
  FromNewerHost: {},
})
export type Why = typeof Why.Type

/**
 * Privacy-safe wire reasons carried in cross-host reports: carries ONLY reason
 * kinds and bounded enums — structurally incapable of carrying a profile path,
 * home directory, user name, or arbitrary error text.
 */
export const WireWhy = Schema.TaggedUnion({
  NotRead: {},
  NoSignIn: {},
  NotReadableHere: {},
  SignInExpired: {},
  KeychainRefused: { outcome: Schema.Literals(["denied", "failed", "timed-out"]) },
  NotHeld: {},
  NotSignedIn: {},
  StateUnreadable: {},
  Contained: {},
  RequestFailed: { why: RequestWhy, status: Schema.optionalKey(Schema.Finite) },
  NoQuota: {},
  HostRefused: {},
  WindowUnknown: { group: Schema.String, span: Span },
  FullWithoutReset: { group: Schema.String, span: Span },
  PeerStale: { peer: Schema.String, ageMs: Schema.Finite },
  FromNewerHost: {},
})
export type WireWhy = typeof WireWhy.Type

/** Strip any local identifying detail (profile path, host string, free-form reason) before crossing the wire. */
export const toWireWhy = (why: Why): WireWhy =>
  Match.value(why).pipe(
    Match.tagsExhaustive({
      NotRead: () => WireWhy.cases.NotRead.make({}),
      NoSignIn: () => WireWhy.cases.NoSignIn.make({}),
      NotReadableHere: () => WireWhy.cases.NotReadableHere.make({}),
      SignInExpired: () => WireWhy.cases.SignInExpired.make({}),
      KeychainRefused: ({ outcome }) => WireWhy.cases.KeychainRefused.make({ outcome }),
      NotHeld: () => WireWhy.cases.NotHeld.make({}),
      NotSignedIn: () => WireWhy.cases.NotSignedIn.make({}),
      NotSignedInRemote: () => WireWhy.cases.NotSignedIn.make({}),
      StateUnreadable: () => WireWhy.cases.StateUnreadable.make({}),
      Contained: () => WireWhy.cases.Contained.make({}),
      RequestFailed: ({ why: reason, status }) =>
        Option.match(Option.fromUndefinedOr(status), {
          onNone: () => WireWhy.cases.RequestFailed.make({ why: reason }),
          onSome: (code) => WireWhy.cases.RequestFailed.make({ why: reason, status: code }),
        }),
      NoQuota: () => WireWhy.cases.NoQuota.make({}),
      HostRefused: () => WireWhy.cases.HostRefused.make({}),
      WindowUnknown: ({ group, span }) => WireWhy.cases.WindowUnknown.make({ group, span }),
      FullWithoutReset: ({ group, span }) => WireWhy.cases.FullWithoutReset.make({ group, span }),
      PeerStale: ({ peer, ageMs }) => WireWhy.cases.PeerStale.make({ peer, ageMs }),
      FromNewerHost: () => WireWhy.cases.FromNewerHost.make({}),
    }),
  )

/** Project a pathless wire reason into a local `Why` for rendering. */
export const fromWireWhy = (wire: WireWhy): Why =>
  Match.value(wire).pipe(
    Match.tagsExhaustive({
      NotRead: () => Why.cases.NotRead.make({}),
      NoSignIn: () => Why.cases.NoSignIn.make({}),
      NotReadableHere: () => Why.cases.NotReadableHere.make({}),
      SignInExpired: () => Why.cases.SignInExpired.make({}),
      KeychainRefused: ({ outcome }) => Why.cases.KeychainRefused.make({ outcome }),
      NotHeld: () => Why.cases.NotHeld.make({}),
      NotSignedIn: () => Why.cases.NotSignedInRemote.make({}),
      StateUnreadable: () => Why.cases.StateUnreadable.make({}),
      Contained: () => Why.cases.Contained.make({ reason: "contained" }),
      RequestFailed: ({ why: reason, status }) =>
        Option.match(Option.fromUndefinedOr(status), {
          onNone: () => Why.cases.RequestFailed.make({ why: reason }),
          onSome: (code) => Why.cases.RequestFailed.make({ why: reason, status: code }),
        }),
      NoQuota: () => Why.cases.NoQuota.make({}),
      HostRefused: () => Why.cases.HostRefused.make({ host: "non-Google" }),
      WindowUnknown: ({ group, span }) => Why.cases.WindowUnknown.make({ group, span }),
      FullWithoutReset: ({ group, span }) => Why.cases.FullWithoutReset.make({ group, span }),
      PeerStale: ({ peer, ageMs }) => Why.cases.PeerStale.make({ peer, ageMs }),
      FromNewerHost: () => Why.cases.FromNewerHost.make({}),
    }),
  )

/** Canonical total-order sort key covering every payload field of `WireWhy`, for deterministic tie-breaking. */
export const wireWhySortKey = (wire: WireWhy): string =>
  Match.value(wire).pipe(
    Match.tagsExhaustive({
      NotRead: () => "NotRead",
      NoSignIn: () => "NoSignIn",
      NotReadableHere: () => "NotReadableHere",
      SignInExpired: () => "SignInExpired",
      KeychainRefused: ({ outcome }) => `KeychainRefused\0${outcome}`,
      NotHeld: () => "NotHeld",
      NotSignedIn: () => "NotSignedIn",
      StateUnreadable: () => "StateUnreadable",
      Contained: () => "Contained",
      RequestFailed: ({ why, status }) =>
        `RequestFailed\0${why}\0${Option.getOrElse(Option.map(Option.fromUndefinedOr(status), (code) => String(code).padStart(6, "0")), () => "")}`,
      NoQuota: () => "NoQuota",
      HostRefused: () => "HostRefused",
      WindowUnknown: ({ group, span }) => `WindowUnknown\0${group}\0${span}`,
      FullWithoutReset: ({ group, span }) => `FullWithoutReset\0${group}\0${span}`,
      PeerStale: ({ peer, ageMs }) => `PeerStale\0${peer}\0${String(ageMs).padStart(15, "0")}`,
      FromNewerHost: () => "FromNewerHost",
    }),
  )

/** One pane limit event observed on a host. */
export const LimitEvent = Schema.Struct({
  group: Schema.String,
  seenAt: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
  host: Schema.String,
  /** Stable time-independent dedup key (Error ID line when present, else frame text hash). */
  key: Schema.optionalKey(Schema.String),
})
export type LimitEvent = typeof LimitEvent.Type

/** One quota reading taken on a host. */
export const HostReading = Schema.Struct({
  at: Schema.Finite,
  host: Schema.String,
  windows: Schema.Array(Window),
})
export type HostReading = typeof HostReading.Type

/** One read attempt and its floor, for cross-host 5-minute spacing. */
export const HostAttempt = Schema.Struct({
  id: Schema.String,
  at: Schema.Finite,
  nextReadAt: Schema.Finite,
  host: Schema.String,
})
export type HostAttempt = typeof HostAttempt.Type

/** One host's last read failure, for status display (wire-safe reason only). */
export const HostFailure = Schema.Struct({
  host: Schema.String,
  at: Schema.Finite,
  why: WireWhy,
})
export type HostFailure = typeof HostFailure.Type

/** One host's Antigravity report, carried in the fleet Report. Never carries a token or profile path. */
export const AntigravityReport = Schema.Struct({
  host: Schema.String,
  at: Schema.Finite,
  /** Whether this host currently has a readable sign-in (managed profile token file or held token; never touches keychain). */
  readableSignIn: Schema.Boolean,
  /** Limit events seen on this host. */
  limits: Schema.Array(LimitEvent),
  /** Dedup keys of pane limit frames this host has already recorded. */
  seenLimitKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  /** This host's newest reading, if any. */
  reading: Schema.optionalKey(HostReading),
  /** This host's last read attempt and floor, if any. */
  attempt: Schema.optionalKey(HostAttempt),
  /** Why this host last failed or could not read, if any (wire-safe kind only). */
  failure: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, why: WireWhy })),
  /** True when tolerant decoding encountered an unknown reason, field, group, or span from a newer host. */
  fromNewerHost: Schema.optionalKey(Schema.Boolean),
})
export type AntigravityReport = typeof AntigravityReport.Type

const KNOWN_REPORT_KEYS: ReadonlySet<string> = new Set([
  "host",
  "at",
  "readableSignIn",
  "limits",
  "seenLimitKeys",
  "reading",
  "attempt",
  "failure",
  "fromNewerHost",
])
const KNOWN_GROUPS: ReadonlySet<string> = new Set(["gemini", "claude-gpt", "gemini-argon", "gemini-carbon"])

const TolerantWireWhy = Schema.Union([
  WireWhy,
  Schema.Struct({ _tag: Schema.String }).pipe(
    Schema.decodeTo(WireWhy, {
      decode: SchemaGetter.transform(() => WireWhy.cases.FromNewerHost.make({})),
      encode: SchemaGetter.passthrough(),
    }),
  ),
])

const TolerantFailure = Schema.Struct({ at: Schema.Finite, why: TolerantWireWhy })
const TolerantReadingEnvelope = Schema.Struct({
  at: Schema.Finite,
  host: Schema.String,
  windows: Schema.Array(Schema.Unknown),
})

const decodeWindow = Schema.decodeUnknownOption(Window)
const decodeLimit = Schema.decodeUnknownOption(LimitEvent)
const decodeLimitsRaw = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const decodeKeys = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeReadingEnv = Schema.decodeUnknownOption(TolerantReadingEnvelope)
const decodeAttempt = Schema.decodeUnknownOption(HostAttempt)
const decodeFailure = Schema.decodeUnknownOption(TolerantFailure)

const ReportEnvelope = Schema.StructWithRest(
  Schema.Struct({
    host: Schema.NonEmptyString,
    at: Schema.Finite,
    readableSignIn: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

type ReportEnvelopeType = typeof ReportEnvelope.Type

const parseLimitsField = (raw: ReportEnvelopeType) =>
  Option.match(decodeLimitsRaw(raw["limits"]), {
    onNone: () => ({ limits: Arr.empty<LimitEvent>(), unknown: Option.isSome(Option.fromUndefinedOr(raw["limits"])) }),
    onSome: (items) => {
      const decoded = items.map((item) => decodeLimit(item))
      const limits = decoded.flatMap(Option.toArray)
      const unknown = decoded.some(Option.isNone) || limits.some((item) => !KNOWN_GROUPS.has(item.group))
      return { limits, unknown }
    },
  })

const parseReadingField = (raw: ReportEnvelopeType) => {
  if (Option.isNone(Option.fromUndefinedOr(raw["reading"]))) return { reading: Option.none<HostReading>(), unknown: false }
  return Option.match(decodeReadingEnv(raw["reading"]), {
    onNone: () => ({ reading: Option.none<HostReading>(), unknown: true }),
    onSome: (env) => {
      const decoded = env.windows.map((item) => decodeWindow(item))
      const windows = decoded.flatMap(Option.toArray)
      const unknown = decoded.some(Option.isNone) || windows.some((window) => !KNOWN_GROUPS.has(window.group))
      return { reading: Option.some<HostReading>({ at: env.at, host: env.host, windows }), unknown }
    },
  })
}

const parseFailureField = (raw: ReportEnvelopeType) => {
  if (Option.isNone(Option.fromUndefinedOr(raw["failure"]))) return { failure: Option.none<{ readonly at: number; readonly why: WireWhy }>(), unknown: false }
  return Option.match(decodeFailure(raw["failure"]), {
    onNone: () => ({ failure: Option.some({ at: raw.at, why: WireWhy.cases.FromNewerHost.make({}) }), unknown: true }),
    onSome: (failure) => ({ failure: Option.some(failure), unknown: failure.why._tag === "FromNewerHost" }),
  })
}

const parseAttemptField = (raw: ReportEnvelopeType) => {
  if (Option.isNone(Option.fromUndefinedOr(raw["attempt"]))) return { attempt: Option.none<HostAttempt>(), unknown: false }
  const decoded = decodeAttempt(raw["attempt"])
  return { attempt: decoded, unknown: Option.isNone(decoded) }
}

/**
 * Tolerant decoder schema for a peer's `antigravity` report payload:
 * - Unknown reason `_tag` -> decoded to `WireWhy.FromNewerHost` (shown as "unknown, from a newer host").
 * - Extra fields, unknown window spans, or unknown groups -> kept with `fromNewerHost: true` while preserving all valid data.
 * - Garbage payload (missing `host`, `at`, `readableSignIn`) -> fails decoding (`Option.none()`), yielding "no Antigravity record from that peer" without affecting the peer's Claude/OpenAI pool data.
 */
export const TolerantAntigravityReport = ReportEnvelope.pipe(
  Schema.decodeTo(AntigravityReport, {
    decode: SchemaGetter.transform((raw): AntigravityReport => {
      const extraField = Object.keys(raw).some((key) => !KNOWN_REPORT_KEYS.has(key))
      const limitsPart = parseLimitsField(raw)
      const readingPart = parseReadingField(raw)
      const failurePart = parseFailureField(raw)
      const attemptPart = parseAttemptField(raw)
      const seenLimitKeys = decodeKeys(raw["seenLimitKeys"])
      const fromNewerHost =
        extraField ||
        limitsPart.unknown ||
        readingPart.unknown ||
        failurePart.unknown ||
        attemptPart.unknown ||
        raw["fromNewerHost"] === true
      const base: AntigravityReport = {
        host: raw.host,
        at: raw.at,
        readableSignIn: raw.readableSignIn,
        limits: limitsPart.limits,
      }
      const withKeys = Option.match(seenLimitKeys, { onNone: () => base, onSome: (keys) => ({ ...base, seenLimitKeys: keys }) })
      const withReading = Option.match(readingPart.reading, { onNone: () => withKeys, onSome: (reading) => ({ ...withKeys, reading }) })
      const withAttempt = Option.match(attemptPart.attempt, { onNone: () => withReading, onSome: (attempt) => ({ ...withReading, attempt }) })
      const withFailure = Option.match(failurePart.failure, { onNone: () => withAttempt, onSome: (failure) => ({ ...withAttempt, failure }) })
      return Match.value(fromNewerHost).pipe(
        Match.when(true, () => ({ ...withFailure, fromNewerHost: true })),
        Match.orElse(() => withFailure),
      )
    }),
    encode: SchemaGetter.transform((report): ReportEnvelopeType => ({ ...report })),
  }),
)

/** Tolerantly decode a peer's `antigravity` field on its own; none when absent or completely undecodable. */
export const decodeAntigravityReport = Schema.decodeUnknownOption(TolerantAntigravityReport)
