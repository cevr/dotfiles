// Where the Antigravity CLI keeps its sign-in, read in T3 Code's order
// (antigravityUsageLimits.ts at 55085df2): the profile's
// `antigravity-acp/acp_token.json` (an OAuth client and refresh token, which
// can be refreshed), then `antigravity-acp/antigravity-oauth-token` (the 1.5.x
// CLI's own token, which cannot), then the OS keychain entry the CLI writes
// with go-keyring (service `gemini`, account `antigravity`; on macOS stored as
// `go-keyring-base64:` or `go-keyring-encoded:` text). Every secret is a
// Redacted from the moment it is read: it prints as `<redacted>` in any log,
// error or answer, and is unwrapped only to set a request's header or body.
import { Effect, Option, Redacted, Result, Schema } from "effect"
import { Base64, Hex } from "effect/encoding"
import { tokenFilesOf } from "./profile.ts"
import { Why } from "./state.ts"

/** A sign-in, its secrets redacted: one this can refresh, or a bare access token with its expiry. */
export const SignIn = Schema.TaggedUnion({
  Refreshable: {
    clientId: Schema.String,
    clientSecret: Schema.Redacted(Schema.String),
    refreshToken: Schema.Redacted(Schema.String),
    project: Schema.optionalKey(Schema.String),
  },
  Access: {
    access: Schema.Redacted(Schema.String),
    expiresAt: Schema.optionalKey(Schema.Finite),
    source: Schema.Literals(["file", "keychain"]),
  },
})
export type SignIn = typeof SignIn.Type

/** What one read of the keychain entry answered. */
export const KeychainRead = Schema.TaggedUnion({
  Found: { secret: Schema.Redacted(Schema.String) },
  Absent: {},
  Denied: {},
  Failed: {},
  TimedOut: {},
  /** This host has no keychain this can read. */
  Unsupported: {},
})
export type KeychainRead = typeof KeychainRead.Type

/** What the sign-in lookup reaches: the profile's files, and the keychain. */
export interface Places {
  /** A file's text, or none when it is not there. */
  readonly read: (path: string) => Effect.Effect<Option.Option<string>>
  /** One read of the CLI's keychain entry; a read that can put a dialog on the owner's screen. */
  readonly keychain: Effect.Effect<KeychainRead>
}

/** A lookup's outcome: a sign-in or why there is none, and the keychain attempt it made, if it made one. */
export const Lookup = Schema.TaggedUnion({
  Found: { signIn: SignIn, keychain: Schema.optionalKey(Schema.Literals(["read", "absent", "denied", "failed", "timed-out"])) },
  Missing: { why: Why, keychain: Schema.optionalKey(Schema.Literals(["read", "absent", "denied", "failed", "timed-out"])) },
})
export type Lookup = typeof Lookup.Type

const TokenFile = Schema.fromJsonString(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    client_secret: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
    project_id: Schema.optionalKey(Schema.String),
  }),
)
const CliToken = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.Struct({
      access_token: Schema.NonEmptyString,
      expiry: Schema.optionalKey(Schema.String),
    }),
  }),
)
const decodeTokenFile = Schema.decodeUnknownOption(TokenFile)
const decodeCliToken = Schema.decodeUnknownOption(CliToken)
const decodeInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)

/** go-keyring's text as stored: its `go-keyring-base64:` and `go-keyring-encoded:` (hex) forms decoded, any other as is. */
export const decodeGoKeyring = (stored: string): Option.Option<string> => {
  const base64 = "go-keyring-base64:"
  const hex = "go-keyring-encoded:"
  if (stored.startsWith(base64)) return Result.getSuccess(Base64.decodeString(stored.slice(base64.length)))
  if (stored.startsWith(hex)) return Result.getSuccess(Hex.decodeString(stored.slice(hex.length)))
  return Option.some(stored)
}

const accessOf = (text: string, source: "file" | "keychain"): Option.Option<SignIn> =>
  Option.map(decodeCliToken(text), ({ token }) => {
    const access = Redacted.make(token.access_token)
    return Option.match(
      Option.flatMap(Option.fromUndefinedOr(token.expiry), (expiry) => Option.map(decodeInstant(expiry), (at) => at.epochMilliseconds)),
      {
        onNone: () => SignIn.cases.Access.make({ access, source }),
        onSome: (expiresAt) => SignIn.cases.Access.make({ access, expiresAt, source }),
      },
    )
  })

const refreshableOf = (text: string): Option.Option<SignIn> =>
  Option.map(decodeTokenFile(text), (token) => {
    const fields = { clientId: token.client_id, clientSecret: Redacted.make(token.client_secret), refreshToken: Redacted.make(token.refresh_token) }
    return Option.match(Option.fromUndefinedOr(token.project_id), {
      onNone: () => SignIn.cases.Refreshable.make(fields),
      onSome: (project) => SignIn.cases.Refreshable.make({ ...fields, project }),
    })
  })

const refused = (outcome: "denied" | "failed" | "timed-out") =>
  Lookup.cases.Missing.make({ why: Why.cases.KeychainRefused.make({ outcome }), keychain: outcome })

export const fromKeychain = (read: KeychainRead): Lookup =>
  KeychainRead.match(read, {
    Found: ({ secret }) =>
      Option.match(Option.flatMap(decodeGoKeyring(Redacted.value(secret)), (text) => accessOf(text, "keychain")), {
        onNone: () => refused("failed"),
        onSome: (signIn) => Lookup.cases.Found.make({ signIn, keychain: "read" }),
      }),
    Absent: () => Lookup.cases.Missing.make({ why: Why.cases.NoSignIn.make({}), keychain: "absent" }),
    Denied: () => refused("denied"),
    Failed: () => refused("failed"),
    TimedOut: () => refused("timed-out"),
    Unsupported: () => Lookup.cases.Missing.make({ why: Why.cases.NotReadableHere.make({}) }),
  })

/** The sign-in the profile's token files give, in T3's order: the refreshable `acp_token.json`, then the CLI's token; none when neither reads. */
export const fromFiles = Effect.fn("Antigravity.fromFiles")(function* (places: Places, profile: string) {
  const files = tokenFilesOf(profile)
  const acp = Option.flatMap(yield* places.read(files.acp), refreshableOf)
  if (Option.isSome(acp)) return acp
  return Option.flatMap(yield* places.read(files.cli), (text) => accessOf(text, "file"))
})
