// What the auth plugin needs from outside, with its failures: randomness,
// Anthropic's token and usage endpoints, OpenCode's logins, the credentials
// other plugins keep, and the quota event the pool listens to. laws.ts states
// what every implementation owes.
import { Context, type Effect, Schema } from "effect"
import type { ConnectionInfo } from "./rate-limit.ts"
import type { CallbackParams, OAuthCredential, TokenGrant } from "./oauth.ts"
import type { ClaimAnswer, QuotaReading } from "./quota.ts"
import type { SourcedCredential } from "./credential-source.ts"

// ── failures ──

/** A login could not be read: OpenCode's integration or its stored credential, or a credential source. */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  message: Schema.String,
}) {}

/** A credential source could not hand out a token; `retryAt` (epoch ms) when it says the failure passes. */
export class SourceFailed extends Schema.TaggedError<SourceFailed>()("SourceFailed", {
  message: Schema.String,
  retryAt: Schema.optional(Schema.Number),
}) {}

/**
 * A sourced login cannot take the request until a while passes: it answers
 * as a retryable 429 after `retryAfter` seconds, so the session retries and
 * the pool places it on another login.
 */
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("LoginRefused", {
  message: Schema.String,
  retryAfter: Schema.Number,
}) {}

/** The token endpoint gave no grant for a sign-in's code. */
export class ExchangeFailed extends Schema.TaggedError<ExchangeFailed>()("ExchangeFailed", {
  message: Schema.String,
}) {}

/** The token endpoint answered a refresh with `status` and no grant (0: no answer). */
export class TokenRefused extends Schema.TaggedError<TokenRefused>()("TokenRefused", {
  status: Schema.Number,
}) {}

/** A refresh failed in a way that is not the network's or the endpoint's answer. Its token may be spent. */
export class TokenRequestBroken extends Schema.TaggedError<TokenRequestBroken>()("TokenRequestBroken", {
  message: Schema.String,
}) {}

/** A refresh this plugin owns failed; the message names why. */
export class RefreshFailed extends Schema.TaggedError<RefreshFailed>()("RefreshFailed", {
  message: Schema.String,
}) {}

/** The usage endpoint could not be read (no answer, or a body past its bound). */
export class UsageFailed extends Schema.TaggedError<UsageFailed>()("UsageFailed", {
  message: Schema.String,
}) {}

// ── contracts ──

/** Random bytes, synchronously: a login's label is made in a synchronous callback. */
export class Entropy extends Context.Service<
  Entropy,
  {
    readonly bytes: (size: number) => Uint8Array
  }
>()("dotfiles-opencode/anthropic-auth/Entropy") {}

/** Anthropic's OAuth token endpoint. Each call makes exactly one token request: a refresh token may rotate once it lands. */
export class TokenEndpoint extends Context.Service<
  TokenEndpoint,
  {
    readonly exchange: (callback: CallbackParams, verifier: string, redirectUri: string) => Effect.Effect<TokenGrant, ExchangeFailed>
    readonly refresh: (refreshToken: string) => Effect.Effect<TokenGrant, TokenRefused | TokenRequestBroken>
  }
>()("dotfiles-opencode/anthropic-auth/TokenEndpoint") {}

/** What OpenCode's credential store holds for a login: this plugin's OAuth credential, or something else. */
export type StoredCredential = OAuthCredential | { readonly type: "other" }

/** A login of the integration and the credential OpenCode holds for it. */
export interface Login {
  readonly connection: ConnectionInfo
  /** The stored credential; OpenCode refreshes an expiring one first. */
  readonly credential: Effect.Effect<StoredCredential | undefined, LoginFailed>
}

/** OpenCode's logins of the `anthropic` integration. */
export class Logins extends Context.Service<
  Logins,
  {
    /** The integration's active login, if it has one. */
    readonly active: Effect.Effect<Login | undefined>
    /** The login `credentialID` names; a credential that is not a login of the integration fails, never falls back. */
    readonly chosen: (credentialID: string) => Effect.Effect<Login, LoginFailed>
  }
>()("dotfiles-opencode/anthropic-auth/Logins") {}

/** A credential another plugin keeps, as this plugin reads it. */
export interface Source {
  /** The token to send now; the source refreshes it under its own rules. */
  readonly resolve: Effect.Effect<SourcedCredential, SourceFailed>
  /** The token the source holds now while it is good, never refreshing; absent when the source cannot say (it is not swept). */
  readonly peek: Effect.Effect<SourcedCredential | undefined> | undefined
  /** The provider rejected `access` (a 401): the source refreshes it next time if it still holds it. */
  readonly rejected: (access: string) => Effect.Effect<void>
}

/** The credentials other plugins keep for the integration (the pool's login store). */
export class CredentialSources extends Context.Service<
  CredentialSources,
  {
    /** The source that keeps `credentialID`, if one does. */
    readonly find: (credentialID: string) => Effect.Effect<Source | undefined>
  }
>()("dotfiles-opencode/anthropic-auth/CredentialSources") {}

/** What the usage endpoint answered. */
export type UsageAnswer =
  | { readonly status: "ok"; readonly body: unknown }
  | { readonly status: "unauthorized" }
  /** Not read: an untrusted endpoint, or an answer that is not a success. */
  | { readonly status: "unread" }

/** Anthropic's usage endpoints: what a login has left of its windows, and the claim of one of its reset grants. */
export class UsageEndpoint extends Context.Service<
  UsageEndpoint,
  {
    readonly read: (access: string, userAgent: string) => Effect.Effect<UsageAnswer, UsageFailed>
    /**
     * Claim the `cedar_ember` grant `grantID` for the login's organization
     * (read from its profile), under the idempotency key `requestID`: the
     * same id claims once. Never fails: a failure is its outcome.
     */
    readonly reset: (access: string, userAgent: string, grantID: string, requestID: string) => Effect.Effect<ClaimAnswer>
  }
>()("dotfiles-opencode/anthropic-auth/UsageEndpoint") {}

/** Where each new quota reading goes: the quota protocol's `reading` event. Publishing never fails the caller. */
export class QuotaEvents extends Context.Service<
  QuotaEvents,
  {
    readonly publish: (credentialID: string, reading: QuotaReading) => Effect.Effect<void>
  }
>()("dotfiles-opencode/anthropic-auth/QuotaEvents") {}
