// The auth plugin's handlers: which login a request goes out on, what each
// login has left (its newest quota reading, published to the pool), the
// Claude Code version reported, and the sign-in and refresh of a Claude
// Pro/Max login. The HTTP hooks (`fetch/exchange.ts`) and the composition
// root (`cmd/anthropic-auth/server.ts`) call it.
import { Clock, Context, Deferred, Effect, Exit, Layer } from "effect"
import type { SourcedCredential } from "./credential-source.ts"
import {
  AUTHORIZE_INSTRUCTIONS,
  authorizationUrl,
  CODE_CALLBACK_URL,
  EXCHANGE_FAILED_MESSAGE,
  exchangeCallback,
  isAmbiguousRefreshFailure,
  METHOD_ID,
  type OAuthCredential,
  stateFrom,
  toCredential,
} from "./oauth.ts"
import { pkceFrom } from "./pkce.ts"
import {
  type ClaimAnswer,
  earliestRelease,
  MAX_QUOTA_CREDENTIALS,
  MIN_UNAUTHORIZED_HOLD_MS,
  HOST_REFRESH_WINDOW_MS,
  type QuotaReading,
  type QuotaRefusal,
  readUsageBody,
  refusalOf,
  retryAfterSeconds,
  SIGNIN_RETRY_MS,
  USAGE_REFRESH_AFTER_MS,
} from "./quota.ts"
import { type ConnectionInfo, createConnectionLabel, type RateLimitCategory } from "./rate-limit.ts"
import {
  type CachedRefresh,
  MAX_REFRESH_CACHE_ENTRIES,
  MAX_REFRESH_IN_FLIGHT,
  REFRESH_CACHE_GRACE_MS,
  type Refreshes,
  sweepRefreshCache,
  tokenKey,
} from "./refresh.ts"
import {
  CredentialSources,
  Entropy,
  ExchangeFailed,
  LoginFailed,
  LoginRefused,
  Logins,
  QuotaEvents,
  RefreshFailed,
  TokenEndpoint,
  UsageEndpoint,
  type UsageFailed,
} from "./service.ts"
import {
  CLAUDE_CODE_VERSION,
  compareClaudeCodeVersions,
  formatUserAgent,
  resolveClaudeCodeVersion,
} from "./version.ts"

/** The prefix of everything the plugin logs. */
export const LOG_PREFIX = "[ex-machina.anthropic-auth]"
/** How many sessions may each recover once from a version rejection; past it, none does. */
export const MAX_VERSION_GATE_RECOVERIES = 256

/** The login a request goes out on, with the token to send. */
export interface ResolvedLogin {
  readonly connection: ConnectionInfo
  /** The credential's id, when the login is a credential (not an environment key). */
  readonly credentialID: string | undefined
  readonly access: string
  /** Epoch ms. */
  readonly expires: number
}

/** A sign-in begun: the URL the owner opens, and the exchange of the code they paste back. */
export interface Authorization {
  readonly url: string
  readonly instructions: string
  readonly callback: (code: string) => Effect.Effect<OAuthCredential, ExchangeFailed>
}

/** A refused response, as the refusal it makes of its login. */
export interface Refusal {
  readonly credentialID: string
  readonly status: number
  readonly category: RateLimitCategory | undefined
  /** The response's headers as Anthropic sent them. */
  readonly headers: Headers
  readonly quota: QuotaReading | undefined
  readonly now: number
  /** The token the request carried, for a source to drop on a 401. */
  readonly bearer: string | undefined
}

export class Auth extends Context.Service<
  Auth,
  {
    /**
     * The login to send a request on: the credential `credentialID` names,
     * else the integration's active login; none when there is no Claude
     * Pro/Max login to use. A credential a source keeps comes from that
     * source, which refreshes it; this plugin never does. A login whose
     * token cannot be resolved is refused for a while, so the pool places
     * nothing on it; a sourced one whose failure passes is `LoginRefused`.
     */
    readonly login: (credentialID: string | undefined) => Effect.Effect<ResolvedLogin | undefined, LoginFailed | LoginRefused>
    /** The Claude Code version requests report now. */
    readonly version: Effect.Effect<string>
    /** Whether the version was set by the owner: a rejection never raises it. */
    readonly explicitVersion: boolean
    /**
     * Anthropic rejected the version and needs `required`: report it from
     * now on if it is newer. Whether the request may be retried: once per
     * `key` (session, agent, provider, model).
     */
    readonly recoverVersion: (required: string, key: string) => Effect.Effect<boolean>
    /** A response succeeded with the reading its headers carry. */
    readonly succeeded: (credentialID: string, quota: QuotaReading) => Effect.Effect<void>
    /** A response did not succeed: a 401 or 429 refuses its login a while. */
    readonly refused: (refusal: Refusal) => Effect.Effect<void>
    /** The newest reading of a credential. */
    readonly reading: (credentialID: string) => Effect.Effect<QuotaReading | undefined>
    /** Read the usage endpoint for one credential now: the pool's sweep. */
    readonly usage: (credentialID: string) => Effect.Effect<QuotaReading | undefined, LoginFailed | LoginRefused | UsageFailed>
    /**
     * Claim the reset grant `grantID` on a credential's account, under the
     * idempotency key `requestID`. A claim that reset the windows drops the
     * refusal the credential's reading held, so the next usage read says
     * what is left. Never fails: a login that cannot be had is `signed-out`.
     */
    readonly claim: (credentialID: string, grantID: string, requestID: string) => Effect.Effect<ClaimAnswer>
    /** Refresh a Claude Pro/Max credential OpenCode keeps; a token is sent at most once. */
    readonly refresh: (credential: OAuthCredential) => Effect.Effect<OAuthCredential, RefreshFailed>
    /** Begin a sign-in. */
    readonly authorize: Effect.Effect<Authorization>
    /** A label for a new login. */
    readonly label: () => string | undefined
    /** Forget this location's version recoveries and settled refreshes. */
    readonly dispose: Effect.Effect<void>
  }
>()("dotfiles-opencode/anthropic-auth/Auth") {}

export interface Config {
  /** `ANTHROPIC_CLAUDE_CODE_VERSION` as the process holds it. */
  readonly versionOverride: string | undefined
  /** The refreshes of the whole process (`refresh.ts`). */
  readonly refreshes: Refreshes<OAuthCredential, RefreshFailed>
}

const credentialIDOf = (connection: ConnectionInfo): string | undefined =>
  connection.type === "credential" ? connection.id : undefined

/** The usage login: a token to read with, a reading to keep, or no login. */
type UsageLogin =
  | { readonly type: "read"; readonly access: string; readonly expires: number; readonly sourced: boolean }
  | { readonly type: "skip" }
  | undefined

export const layer = (config: Config) =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const entropy = yield* Entropy
      const tokens = yield* TokenEndpoint
      const logins = yield* Logins
      const sources = yield* CredentialSources
      const usageEndpoint = yield* UsageEndpoint
      const events = yield* QuotaEvents

      // Resolved once, so user-agent and billing agree for every request this
      // location handles.
      const resolution = resolveClaudeCodeVersion(config.versionOverride)
      if (resolution.type === "invalid") yield* Effect.logError(`${LOG_PREFIX} ${resolution.error}`)
      else if (resolution.type === "outdated") yield* Effect.logWarning(`${LOG_PREFIX} ${resolution.warning}`)
      let version = resolution.type === "invalid" ? CLAUDE_CODE_VERSION : resolution.version
      // A valid explicit override is absolute; adoption is only the fallback
      // for an unset (or malformed and so ignored) value.
      const explicitVersion = config.versionOverride !== undefined && resolution.type !== "invalid"
      // An at-most-once limiter. On overflow, recovery fails closed rather
      // than forgetting old entries.
      const recoveries = new Set<string>()

      const readings = new Map<string, QuotaReading>()
      const credentialExpiry = new Map<string, number>()
      // This location's refreshes: a rotation is remembered a while after it
      // lands, so a caller still holding the old token cannot send it again.
      const refreshCache = new Map<string, CachedRefresh<OAuthCredential, RefreshFailed>>()

      const publish = (credentialID: string, reading: QuotaReading) =>
        Effect.suspend(() => {
          if (!readings.has(credentialID) && readings.size >= MAX_QUOTA_CREDENTIALS) {
            const oldest = readings.keys().next().value
            if (oldest !== undefined) readings.delete(oldest)
          }
          readings.delete(credentialID)
          readings.set(credentialID, reading)
          return events.publish(credentialID, reading)
        })

      const refuse = (credentialID: string, refusal: QuotaRefusal) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => {
            const previous = readings.get(credentialID)
            return publish(credentialID, {
              at: now,
              ...(previous?.status ? { status: previous.status } : {}),
              windows: previous?.windows ?? [],
              refusal,
            })
          }),
        )

      const sourcedLogin = (credentialID: string, credential: SourcedCredential): ResolvedLogin => ({
        connection: { type: "credential", id: credentialID },
        credentialID,
        access: credential.access,
        expires: credential.expires,
      })

      const login = (credentialID: string | undefined): Effect.Effect<ResolvedLogin | undefined, LoginFailed | LoginRefused> =>
        Effect.gen(function* () {
          const source = credentialID === undefined ? undefined : yield* sources.find(credentialID)
          if (credentialID !== undefined && source !== undefined) {
            return yield* source.resolve.pipe(
              Effect.map((credential) => sourcedLogin(credentialID, credential)),
              Effect.catchTag("SourceFailed", (error) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  // A failure with a retry time passes on its own (a rate
                  // limit, a busy store); one without needs a sign-in again.
                  yield* refuse(
                    credentialID,
                    error.retryAt === undefined
                      ? { kind: "signin", until: now + SIGNIN_RETRY_MS }
                      : { kind: "rate-limit", until: error.retryAt },
                  )
                  if (error.retryAt === undefined) return yield* new LoginFailed({ message: error.message })
                  const later = yield* Clock.currentTimeMillis
                  return yield* new LoginRefused({
                    message: error.message,
                    retryAfter: retryAfterSeconds(earliestRelease(readings.values(), error.retryAt, later), later),
                  })
                }),
              ),
            )
          }
          const chosen = credentialID === undefined ? yield* logins.active : yield* logins.chosen(credentialID)
          if (chosen === undefined) return undefined
          const id = credentialIDOf(chosen.connection)
          const credential = yield* chosen.credential.pipe(
            Effect.tapError(() =>
              id === undefined
                ? Effect.void
                : Clock.currentTimeMillis.pipe(Effect.flatMap((now) => refuse(id, { kind: "signin", until: now + SIGNIN_RETRY_MS }))),
            ),
          )
          if (credential?.type === "oauth" && credential.methodID === METHOD_ID) {
            if (id !== undefined) credentialExpiry.set(id, credential.expires)
            return { connection: chosen.connection, credentialID: id, access: credential.access, expires: credential.expires }
          }
          if (credentialID !== undefined) {
            return yield* new LoginFailed({ message: "The chosen Anthropic credential is not a Claude Pro/Max login" })
          }
          return undefined
        })

      /**
       * The login a usage read goes out on. A sourced credential is read with
       * the token its source holds now (`peek`), so a sweep doesn't make every
       * source refresh at once. One with no good token is skipped while its
       * reading is recent; one unread for USAGE_REFRESH_AFTER_MS is resolved,
       * since an unread login drops out of the pool's pace.
       */
      const usageLogin = (credentialID: string): Effect.Effect<UsageLogin, LoginFailed | LoginRefused> =>
        Effect.gen(function* () {
          const source = yield* sources.find(credentialID)
          if (source === undefined) {
            const resolved = yield* login(credentialID)
            return resolved === undefined
              ? undefined
              : { type: "read", access: resolved.access, expires: resolved.expires, sourced: false }
          }
          const peeked = source.peek === undefined ? undefined : yield* source.peek
          if (peeked !== undefined) return { type: "read", access: peeked.access, expires: peeked.expires, sourced: true }
          const now = yield* Clock.currentTimeMillis
          const read = readings.get(credentialID)
          const fresh = read !== undefined && read.windows.length > 0 && now - read.at < USAGE_REFRESH_AFTER_MS
          if (fresh || (read?.refusal?.until ?? 0) > now) return { type: "skip" }
          // A failed resolve has published its refusal; the sweep keeps that reading.
          return yield* login(credentialID).pipe(
            Effect.map((resolved): UsageLogin =>
              resolved === undefined
                ? undefined
                : { type: "read", access: resolved.access, expires: resolved.expires, sourced: true },
            ),
            Effect.orElseSucceed((): UsageLogin => ({ type: "skip" })),
          )
        })

      const usage = (credentialID: string) =>
        Effect.gen(function* () {
          const active = yield* usageLogin(credentialID)
          if (active === undefined) return undefined
          if (active.type === "skip") return readings.get(credentialID)
          const answer = yield* usageEndpoint.read(active.access, formatUserAgent(version))
          const now = yield* Clock.currentTimeMillis
          if (answer.status === "unauthorized") {
            const source = yield* sources.find(credentialID)
            if (source !== undefined) yield* source.rejected(active.access)
            yield* refuse(credentialID, {
              kind: "unauthorized",
              // A source refreshes the rejected token on its next resolve.
              until: Math.max(now + MIN_UNAUTHORIZED_HOLD_MS, active.sourced ? 0 : active.expires - HOST_REFRESH_WINDOW_MS),
            })
            return readings.get(credentialID)
          }
          if (answer.status === "unread") return undefined
          const reading = readUsageBody(answer.body, now)
          if (reading === undefined) return undefined
          // A usage read says nothing of a refusal: a held credential stays
          // held until its refusal ends.
          const previous = readings.get(credentialID)?.refusal
          const kept =
            previous && (previous.until === undefined || previous.until > now) ? { ...reading, refusal: previous } : reading
          yield* publish(credentialID, kept)
          return kept
        })

      const refresh = (credential: OAuthCredential): Effect.Effect<OAuthCredential, RefreshFailed> =>
        Effect.gen(function* () {
          sweepRefreshCache(refreshCache, yield* Clock.currentTimeMillis)
          const key = tokenKey(credential.refresh)
          if (key === undefined) return yield* new RefreshFailed({ message: "Anthropic token refresh failed: 400" })
          const cached = refreshCache.get(key)
          if (cached !== undefined) return yield* Deferred.await(cached.deferred)

          const shared = config.refreshes.inFlight.get(key)
          if (shared === undefined) {
            const blocked = config.refreshes.blocked.blocked(key)
            if (blocked !== undefined) return yield* new RefreshFailed({ message: blocked })
            if (config.refreshes.inFlight.size >= MAX_REFRESH_IN_FLIGHT) {
              return yield* new RefreshFailed({ message: "Too many active Anthropic token refreshes" })
            }
          }
          if (refreshCache.size >= MAX_REFRESH_CACHE_ENTRIES) {
            return yield* new RefreshFailed({
              message: "Anthropic token refresh blocked until the consumed-token cache expires",
            })
          }

          const deferred = shared ?? (yield* Deferred.make<OAuthCredential, RefreshFailed>())
          if (shared === undefined) {
            config.refreshes.inFlight.set(key, deferred)
            // The one token request: it runs to its end whoever waits on it,
            // and it is sent before `refresh` yields, as the original sent it.
            yield* tokens.refresh(credential.refresh).pipe(
              Effect.map(toCredential),
              Effect.catchTags({
                TokenRefused: (error) => {
                  if (isAmbiguousRefreshFailure(error.status)) config.refreshes.blocked.block(key, error.status)
                  return Effect.fail(new RefreshFailed({ message: `Anthropic token refresh failed: ${error.status}` }))
                },
                TokenRequestBroken: (error) => {
                  config.refreshes.blocked.block(key, 0)
                  return Effect.fail(new RefreshFailed({ message: error.message }))
                },
              }),
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(deferred, exit)),
              Effect.ensuring(
                Effect.sync(() => {
                  if (config.refreshes.inFlight.get(key) === deferred) config.refreshes.inFlight.delete(key)
                }),
              ),
              Effect.forkDetach({ startImmediately: true }),
            )
          }

          const entry: CachedRefresh<OAuthCredential, RefreshFailed> = { deferred, expiresAt: undefined }
          refreshCache.set(key, entry)
          return yield* Deferred.await(deferred).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Clock.currentTimeMillis.pipe(
                    Effect.map((now) => {
                      if (refreshCache.get(key) === entry) entry.expiresAt = now + REFRESH_CACHE_GRACE_MS
                    }),
                  )
                : Effect.sync(() => {
                    if (refreshCache.get(key) === entry) refreshCache.delete(key)
                  }),
            ),
            Effect.uninterruptible,
          )
        })

      const authorize = Effect.sync((): Authorization => {
        const pkce = pkceFrom(entropy.bytes(64))
        const state = stateFrom(entropy.bytes(16))
        return {
          url: authorizationUrl("max", pkce.challenge, state),
          instructions: AUTHORIZE_INSTRUCTIONS,
          callback: (code) => {
            const callback = exchangeCallback(code, pkce.verifier, CODE_CALLBACK_URL, state)
            return callback === undefined
              ? Effect.fail(new ExchangeFailed({ message: EXCHANGE_FAILED_MESSAGE }))
              : tokens.exchange(callback, pkce.verifier, CODE_CALLBACK_URL).pipe(Effect.map(toCredential))
          },
        }
      })

      return Auth.of({
        login,
        version: Effect.sync(() => version),
        explicitVersion,
        recoverVersion: (required, key) =>
          Effect.sync(() => {
            if (compareClaudeCodeVersions(required, version) === 1) version = required
            if (recoveries.has(key) || recoveries.size >= MAX_VERSION_GATE_RECOVERIES) return false
            recoveries.add(key)
            return true
          }),
        succeeded: publish,
        refused: (input) =>
          Effect.gen(function* () {
            if (input.status === 401 && input.bearer) {
              const source = yield* sources.find(input.credentialID)
              if (source !== undefined) yield* source.rejected(input.bearer)
            }
            const refusal = refusalOf({
              status: input.status,
              category: input.category,
              headers: input.headers,
              quota: input.quota,
              now: input.now,
              expires: credentialExpiry.get(input.credentialID),
            })
            if (refusal === undefined && input.quota === undefined) return
            yield* publish(input.credentialID, {
              ...(input.quota ?? { at: input.now, windows: readings.get(input.credentialID)?.windows ?? [] }),
              ...(refusal ? { refusal } : {}),
            })
          }),
        reading: (credentialID) => Effect.sync(() => readings.get(credentialID)),
        usage,
        claim: (credentialID, grantID, requestID) =>
          login(credentialID).pipe(
            Effect.matchEffect({
              onFailure: (error) => Effect.succeed<ClaimAnswer>({ outcome: "signed-out", message: error.message }),
              onSuccess: (resolved) =>
                resolved === undefined
                  ? Effect.succeed<ClaimAnswer>({ outcome: "signed-out", message: "no Claude Pro/Max login" })
                  : usageEndpoint.reset(resolved.access, formatUserAgent(version), grantID, requestID).pipe(
                      Effect.tap((answer) =>
                        Effect.sync(() => {
                          const held = readings.get(credentialID)
                          if (answer.outcome !== "reset" || held?.refusal === undefined) return
                          const { refusal: _refusal, ...rest } = held
                          readings.set(credentialID, rest)
                        }),
                      ),
                    ),
            }),
          ),
        refresh,
        authorize,
        label: () => createConnectionLabel(entropy.bytes(4)),
        dispose: Effect.sync(() => {
          recoveries.clear()
          refreshCache.clear()
        }),
      })
    }),
  )
