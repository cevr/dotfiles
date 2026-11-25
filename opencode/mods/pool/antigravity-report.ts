// Wire schemas for Antigravity's cross-host fleet report: limit events,
// quota readings, read attempts and typed reasons. Lives at the root of
// mods/pool/ so the pool's domain files (status.ts, fleet.ts, service.ts)
// stay inside the pool domain fence; mods/pool/antigravity/* re-exports these.
// Never carries a token or secret.
import { Schema } from "effect"

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

/** Why nothing, or not everything, can be said: each case has its own words (antigravity/text.ts `whyText`). */
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
})
export type Why = typeof Why.Type

/** One pane limit event observed on a host. */
export const LimitEvent = Schema.Struct({
  group: Schema.String,
  seenAt: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.Finite),
  host: Schema.String,
  /** Stable dedup key (Error ID line when present, else reset time). */
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

/** One host's last read failure, for status display. */
export const HostFailure = Schema.Struct({
  host: Schema.String,
  at: Schema.Finite,
  why: Why,
})
export type HostFailure = typeof HostFailure.Type

/** One host's Antigravity report, carried in the fleet Report. Never carries a token. */
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
  /** Why this host last failed or could not read, if any. */
  failure: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, why: Why })),
})
export type AntigravityReport = typeof AntigravityReport.Type
