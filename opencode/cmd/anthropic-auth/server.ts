/**
 * The Anthropic auth plugin as an OpenCode server plugin: Claude Pro/Max
 * logins for the `anthropic` integration (vendored from
 * @ex-machina/opencode-anthropic-auth, MIT; see mods/anthropic-auth/README.md).
 * The composition root: it reads the environment once, builds the auth model
 * (`@dotfiles/opencode-anthropic-auth/model`) on its outside systems, and
 * answers OpenCode's hooks with it.
 *
 * - The `claude-max` OAuth method signs a login in, refreshes its token (a
 *   refresh token is sent at most once) and labels it with a random name.
 * - `http.request` sends each `anthropic` request on its login as Claude Code
 *   does: the login another plugin chose (`x-opencode-credential-id`), else
 *   the active one; a credential another plugin keeps comes from it
 *   (`Symbol.for('opencode.credential-sources')`). Its cache breakpoints go
 *   out for the lifetime another plugin named (`x-opencode-cache-ttl`, the
 *   pool's), else the agent's own `request.settings.cacheTTL` over a lifetime
 *   the provider configures.
 * - `http.response` turns tool names back, recovers once from a Claude Code
 *   version rejection, names a 429 for what it is and records the quota each
 *   response carries.
 * - The quota RPC (`credential-quota.anthropic`) answers each login's newest
 *   reading and reads its usage endpoint, and publishes each new reading;
 *   its `claim` claims one of a login's `cedar_ember` reset grants for the
 *   pool (the organization from `/api/oauth/profile`, then
 *   `POST /api/organizations/<org>/reset_rate_limits` with the pool's
 *   request id as the idempotency key). Only the pool's decision calls it.
 *
 * Environment: `ANTHROPIC_BASE_URL` (a custom endpoint OAuth may go to),
 * `ANTHROPIC_INSECURE` (warned about: a plugin cannot turn TLS off) and
 * `ANTHROPIC_CLAUDE_CODE_VERSION` (the version reported), read at setup.
 */
import { Agent, Credential, Integration, Plugin } from "@opencode/plugin/effect"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { makeEndpoint } from "@dotfiles/opencode-anthropic-auth/endpoint"
import { makeAliasLeases, makeConnections, makeOwnership, type Ownership } from "@dotfiles/opencode-anthropic-auth/fetch/ownership"
import { onRequest, onResponse } from "@dotfiles/opencode-anthropic-auth/fetch/exchange"
import * as TokenLive from "@dotfiles/opencode-anthropic-auth/fetch/token"
import * as UsageLive from "@dotfiles/opencode-anthropic-auth/fetch/usage"
import * as Model from "@dotfiles/opencode-anthropic-auth/model"
import * as EntropyLive from "@dotfiles/opencode-anthropic-auth/node/entropy"
import { INTEGRATION_ID, METHOD_ID, METHOD_LABEL, type OAuthCredential } from "@dotfiles/opencode-anthropic-auth/oauth"
import * as IntegrationLive from "@dotfiles/opencode-anthropic-auth/opencode/integration"
import * as QuotaLive from "@dotfiles/opencode-anthropic-auth/opencode/quota"
import { quotaProtocol } from "@dotfiles/opencode-anthropic-auth/quota"
import { isCacheTTL } from "@dotfiles/opencode-anthropic-auth/request-body"
import { makeRefreshes, type Refreshes } from "@dotfiles/opencode-anthropic-auth/refresh"
import * as SourcesLive from "@dotfiles/opencode-anthropic-auth/registry/credential-sources"
import { Entropy, type RefreshFailed } from "@dotfiles/opencode-anthropic-auth/service"
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from "@dotfiles/opencode-anthropic-auth/version"

export const PLUGIN_ID = "ex-machina.anthropic-auth"

/** How the plugin reaches Anthropic: `fetch`, or a stand-in in the seam tests. */
export type Fetch = TokenLive.Fetch

/** The environment the plugin reads, as raw values. */
export interface Env {
  /** `ANTHROPIC_BASE_URL`. */
  readonly baseUrl: string | undefined
  /** `ANTHROPIC_INSECURE`. */
  readonly insecure: string | undefined
  /** `ANTHROPIC_CLAUDE_CODE_VERSION`. */
  readonly versionOverride: string | undefined
}

/**
 * What every setup in the process shares. OpenCode can dispose and recreate a
 * setup while a request is in flight, and the credential store is
 * process-wide: a response may reach a newer setup than the one that sent
 * its request, and a refresh token in flight must not be sent again.
 */
export interface Shared {
  readonly ownership: Ownership
  readonly refreshes: Refreshes<OAuthCredential, RefreshFailed>
}

export const makeShared = (): Shared => ({ ownership: makeOwnership(), refreshes: makeRefreshes() })

export interface Options {
  readonly fetch: Fetch
  /** Read once per setup. */
  readonly env: () => Env
  readonly shared: Shared
  /** Where the credential sources other plugins register are read: the process's registry, or a test's own. */
  readonly registry: SourcesLive.RegistryRead
}

export const INSECURE_WARNING =
  `${Model.LOG_PREFIX} ANTHROPIC_INSECURE is set, but OpenCode v2 ` +
  "plugin request hooks cannot disable TLS verification for a custom " +
  "ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — " +
  "requests to an untrusted/self-signed endpoint will fail."

/** A credential as OpenCode keeps it. */
const toHost = (credential: OAuthCredential): Credential.OAuth => ({
  type: "oauth",
  methodID: Integration.MethodID.make(credential.methodID),
  refresh: credential.refresh,
  access: credential.access,
  expires: credential.expires,
})

/** A claim as the pool asks for it. */
const decodeClaim = Schema.decodeUnknownOption(
  Schema.Struct({ credentialID: Schema.NonEmptyString, creditID: Schema.NonEmptyString, requestID: Schema.NonEmptyString }),
)

/** The credential an RPC call names; a call that names none fails. */
const credentialOf = (input: unknown) => {
  const id = typeof input === "object" && input !== null && "credentialID" in input ? input.credentialID : undefined
  return typeof id === "string" && id !== "" ? Effect.succeed(id) : Effect.die(new Error("credentialID is required"))
}

export const make = (options: Options) =>
  Plugin.define({
    id: PLUGIN_ID,
    effect: Effect.fn("AnthropicAuth.plugin")(function* (ctx) {
      const env = options.env()
      const endpoint = makeEndpoint({ baseUrl: env.baseUrl, insecure: env.insecure })
      if (endpoint.insecure) yield* Effect.logWarning(INSECURE_WARNING)

      const emit = QuotaLive.makeEmitCell()
      const integrationID = Integration.ID.make(INTEGRATION_ID)
      const services = yield* Layer.build(
        Model.layer({ versionOverride: env.versionOverride, refreshes: options.shared.refreshes }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              EntropyLive.layer,
              TokenLive.layer(options.fetch),
              UsageLive.layer(options.fetch, endpoint),
              SourcesLive.layer(INTEGRATION_ID, options.registry),
              QuotaLive.layer(emit),
              IntegrationLive.layer({
                connections: ctx.integration.get({ integrationID }).pipe(Effect.map((integration) => integration.data.connections)),
                active: ctx.integration.connection.active(INTEGRATION_ID),
                resolve: (connection) => ctx.integration.connection.resolve(connection),
              }),
            ),
          ),
        ),
      )
      const auth = Context.get(services, Model.Auth)

      yield* ctx.integration.transform((draft) => {
        draft.method.update({
          integrationID: INTEGRATION_ID,
          method: { id: METHOD_ID, type: "oauth", label: METHOD_LABEL },
          authorize: () =>
            auth.authorize.pipe(
              Effect.map((authorization) => ({
                url: authorization.url,
                instructions: authorization.instructions,
                mode: "code" as const,
                callback: (code: string) => authorization.callback(code).pipe(Effect.map(toHost)),
              })),
            ),
          refresh: (credential) => auth.refresh(credential).pipe(Effect.map(toHost)),
          label: () => auth.label(),
        })
      })

      // The quota RPC has no error to answer with: a read that fails fails the call.
      const quota = yield* ctx.rpc
        .register(quotaProtocol(INTEGRATION_ID), {
          reading: (input) =>
            credentialOf(input).pipe(
              Effect.flatMap(auth.reading),
              Effect.map((reading) => ({ reading: reading ?? null })),
            ),
          usage: (input) =>
            credentialOf(input).pipe(
              Effect.flatMap(auth.usage),
              Effect.map((reading) => ({ reading: reading ?? null })),
              Effect.orDie,
            ),
          // A claim the pool decided on (never a read's side effect); a malformed one claims nothing.
          claim: (input) =>
            Option.match(decodeClaim(input), {
              onNone: () => Effect.succeed({ outcome: "failed", message: "malformed claim" }),
              onSome: ({ credentialID, creditID, requestID }) => auth.claim(credentialID, creditID, requestID),
            }),
        })
        .pipe(Effect.orDie)
      emit.current = (credentialID, reading) => quota.events.emit("reading", { credentialID, reading })

      let active = true
      const leases = makeAliasLeases(Context.get(services, Entropy).bytes(32))
      const connections = makeConnections()
      const exchange = {
        auth,
        endpoint,
        ownership: options.shared.ownership,
        leases,
        connections,
        clock: yield* Clock.Clock,
        ownCacheTTL: (agentID: string) =>
          ctx.agent.get({ agentID: Agent.ID.make(agentID) }).pipe(
            Effect.map((agent) => {
              const ttl = agent.data.request.settings?.["cacheTTL"]
              return isCacheTTL(ttl) ? ttl : undefined
            }),
            Effect.orElseSucceed(() => undefined),
          ),
        active: () => active,
      }
      // A request the plugin cannot send fails, as the host's fetch would.
      yield* ctx.session.hook("http.request", (event) => onRequest(exchange)(event).pipe(Effect.orDie))
      yield* ctx.session.hook("http.response", (event) => onResponse(exchange)(event).pipe(Effect.orDie))

      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          active = false
          emit.current = undefined
          leases.retireAll()
          connections.clear()
          return auth.dispose
        }),
      )
    }),
  })

/** The environment as the process holds it. */
const processEnv = (): Env => ({
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  insecure: process.env.ANTHROPIC_INSECURE,
  versionOverride: process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR],
})

export default make({ fetch: (input, init) => fetch(input, init), env: processEnv, shared: makeShared(), registry: SourcesLive.processRegistry })
