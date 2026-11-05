/**
 * The pool as an OpenCode server plugin. The composition root: it decodes the
 * options, builds the pool model (`@dotfiles/opencode-pool/model`) on its
 * outside systems (its `opencode/` and `gent/` implementations), and answers
 * OpenCode's hooks with it.
 *
 * For each pooled provider it chooses the login each request goes out on
 * (`model.request` sets the credential header the provider's auth plugin
 * honours), holds a login its provider refuses, and turns a refused primary
 * request into an immediate retry on another login. Quota comes from the
 * provider's auth plugin over the quota RPC: a reading after each response,
 * the readings it publishes, and a sweep of the usage endpoint every few
 * minutes. Other mods read the pool over its own RPC
 * (`@dotfiles/opencode-pool/status`): `pace`, `status`, `session`, the
 * account one session is on, named by its login's label, `alerts`, and
 * `logins`, the login each of a session's recorded steps went out on (by its
 * assistant message), which the cache mod reads to name a step the pool moved.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `providers`: provider id to integration id, default `{ anthropic: "anthropic" }`.
 * - `sweepMinutes`: how often to read each login's usage; 0 turns it off. Default 10.
 * - `cacheLifeMs`: how long a session's prompt cache lives on the login it last
 *   used, in ms: the provider's cache lifetime (`settings.cache.ttl`). While it
 *   lives the session stays on that login unless the login is held or out of
 *   room. Default 5 minutes, Anthropic's default; `bun run daily` sets it from
 *   the lifetime it gives Claude. A request whose agent sets its own lifetime
 *   (`request.settings.cacheTTL`, read through `ctx.agent.get`) keeps the
 *   session there for that lifetime instead.
 * - `sources`: other stores whose logins join a pool beside OpenCode's own, read
 *   in place, never copied. Default none. `[{ kind: "gent", dir: "~/.local/share/opencode-prime/pool-auth" }]`
 *   adds the Claude accounts gent signed in to (`@dotfiles/opencode-pool/gent/store`) to the
 *   `anthropic` pool as `gent:<label>`; the pool refreshes their tokens under
 *   gent's lock and the auth plugin takes them from it (`registerCredentialSource`).
 *   `tokenURL` points a source's refresh elsewhere, for tests. The `anthropic`
 *   provider is then available without a login of OpenCode's own, as a
 *   configured provider is (unless the config disables it).
 * - `refreshOutageMinutes`: how long every refresh from a source must fail
 *   (a 429, a 5xx, no answer) before the `alerts` method names it as an
 *   outage. Default 10.
 *
 * `alerts` names every gent login whose refresh token the token endpoint
 * refused, with the command that signs it in again, until its file holds
 * another login, and every source whose refreshes are out, with the
 * endpoint's last status, `server` and `retry-after`. The status mod's TUI
 * shows them in the sidebar and as a toast.
 */
import { Agent, Integration, Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { PoolId } from "@dotfiles/opencode-pool/account-pool"
import { CACHE_LIFE_MS, ttlMs } from "@dotfiles/opencode-pool/accounts"
import { OUTAGE_AFTER_MS } from "@dotfiles/opencode-pool/alerts"
import { GentSource, registerCredentialSource } from "@dotfiles/opencode-pool/gent/store"
import * as Model from "@dotfiles/opencode-pool/model"
import * as LedgerLive from "@dotfiles/opencode-pool/opencode/ledger"
import * as LoginsLive from "@dotfiles/opencode-pool/opencode/logins"
import * as QuotaLive from "@dotfiles/opencode-pool/opencode/quota"
import { quotaProtocol } from "@dotfiles/opencode-pool/quota"
import type { Ledger, Logins, Quota } from "@dotfiles/opencode-pool/service"
import { LoginsQuery, POOL_STATUS, SessionQuery } from "@dotfiles/opencode-pool/status"

export { POOL_STATUS } from "@dotfiles/opencode-pool/status"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The request header that names the login a request goes out on. Its auth plugin strips it. */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const GentStoreOption = Schema.Struct({
  kind: Schema.Literal("gent"),
  dir: Schema.NonEmptyString,
  tokenURL: Schema.optional(Schema.String),
})

export const Options = Schema.Struct({
  providers: Schema.Record(Schema.String, PoolId).pipe(
    withDefault<Readonly<Record<string, PoolId>>>({ anthropic: PoolId.make("anthropic") }),
  ),
  sweepMinutes: Schema.Finite.pipe(withDefault(10)),
  cacheLifeMs: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(withDefault(CACHE_LIFE_MS)),
  sources: Schema.Array(GentStoreOption).pipe(withDefault<ReadonlyArray<typeof GentStoreOption.Type>>([])),
  refreshOutageMinutes: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(withDefault(OUTAGE_AFTER_MS / 60_000)),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Logins | Quota | Ledger

/** gent keeps Claude accounts: they join the pool of the `anthropic` provider. */
const gentPool = (options: Options): PoolId | undefined => options.providers.anthropic

/**
 * The gent stores the options name, each read in place. One per directory per
 * process. Each logs its refreshes to the host's log through `context`.
 */
const gentSources = (options: Options, context: Context.Context<never>) =>
  gentPool(options) === undefined
    ? []
    : options.sources.map(
        (source) =>
          new GentSource({ dir: source.dir, context, ...(source.tokenURL === undefined ? {} : { tokenURL: source.tokenURL }) }),
      )

/** The outside systems as OpenCode provides them: its integrations, the auth plugins' quota RPC, the plugin's storage. */
export const live = (ctx: Plugin.Context, options: Options, sources: ReadonlyArray<GentSource>): Layer.Layer<Externals> =>
    Layer.mergeAll(
      LoginsLive.layer(
        {
          connections: (pool) =>
            ctx.integration.get({ integrationID: Integration.ID.make(pool) }).pipe(Effect.map((integration) => integration.data.connections)),
          status: (pool, connection, status) => ctx.integration.connection.status({ integrationID: pool, connection, status }),
        },
        (pool) => (pool === gentPool(options) ? sources.map(LoginsLive.gentStore) : []),
      ),
      QuotaLive.layer((pool) => {
        const client = ctx.rpc(quotaProtocol(pool))
        return {
          reading: (input) => client.reading(input),
          usage: (input) => client.usage(input),
          published: client.events.subscribe("reading"),
        }
      }),
      LedgerLive.layer(ctx.storage),
    )

/** The first sweep waits a moment so the providers' auth plugins have set up. */
const FIRST_SWEEP = "1 second"

/**
 * The plugin on `externals`: the live systems in OpenCode, test layers in the
 * seam tests. `externals` gets the gent sources the options name, so the
 * plugin registers with the auth plugin exactly the sources the pool lists.
 */
export const make = (
  externals: (ctx: Plugin.Context, options: Options, sources: ReadonlyArray<GentSource>) => Layer.Layer<Externals>,
) =>
  Plugin.define({
    id: "dotfiles-opencode.pool",
    effect: Effect.fn("Pool.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.pool: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // The plugin's context carries the host's loggers.
      const sources = gentSources(options, yield* Effect.context<never>())
      const services = yield* Layer.build(
        Model.layer({
          providers: options.providers,
          cacheLifeMs: options.cacheLifeMs,
          refreshOutageMs: options.refreshOutageMinutes * 60_000,
        }).pipe(Layer.provideMerge(externals(ctx, options, sources))),
      )
      const pool = Context.get(services, Model.Pool)

      // The auth plugin takes a gent account's token from its source.
      const gent = gentPool(options)
      if (gent !== undefined)
        for (const source of sources)
          yield* Effect.acquireRelease(
            Effect.sync(() => registerCredentialSource(gent, source)),
            (unregister) => Effect.sync(unregister),
          )

      // OpenCode offers a provider only when it holds a login for it or the config
      // names it: gent's accounts are logins it cannot see, so the pool names it.
      if (sources.length > 0)
        yield* ctx.provider.transform((editor) => {
          if (editor.get("anthropic")?.provider.activation === "auto")
            editor.update("anthropic", (provider) => {
              provider.activation = "enabled"
            })
        })

      // An agent that keeps its own cache lifetime (an orchestration role's 5 minutes, set as its
      // `request.settings.cacheTTL`) holds its session on a login only that long. An agent the
      // host cannot name keeps the provider's lifetime.
      const agentCacheLife = (agentID: string) =>
        ctx.agent.get({ agentID: Agent.ID.make(agentID) }).pipe(
          Effect.map((agent) => ttlMs(agent.data.request.settings?.["cacheTTL"])),
          Effect.orElseSucceed(() => undefined),
        )

      // A fork's requests read its source's cache (the host keys the cache by the source), so a
      // fork with no cache of its own goes where its source's is. A session the host cannot read
      // reads no other's.
      const cacheOf = (sessionID: SessionID) =>
        ctx.session.get({ sessionID }).pipe(
          Effect.map((session) => session.fork?.sessionID),
          Effect.orElseSucceed(() => undefined),
        )

      yield* ctx.session.hook("model.request", (event) =>
        Effect.all([agentCacheLife(event.agent), cacheOf(event.sessionID)]).pipe(
          Effect.flatMap(([cacheLifeMs, source]) =>
            pool.place({
              providerID: event.model.providerID,
              sessionID: event.sessionID,
              kind: event.kind,
              ...(cacheLifeMs === undefined ? {} : { cacheLifeMs }),
              ...(source === undefined ? {} : { cacheOf: source }),
            }),
          ),
          Effect.map((credentialID) => {
            if (credentialID !== undefined) event.headers[CREDENTIAL_HEADER] = credentialID
          }),
        ),
      )

      yield* ctx.session.hook("http.response", (event) =>
        pool.responded({
          providerID: event.model.providerID,
          sessionID: event.sessionID,
          kind: event.kind,
          status: event.response.status,
        }),
      )

      yield* ctx.session.hook("retry", (event) =>
        pool.retry({ providerID: event.model.providerID, sessionID: event.sessionID }).pipe(
          Effect.map((failOver) => {
            if (failOver) event.decision = { retry: true, delay: 0 }
          }),
        ),
      )

      yield* ctx.session.hook("experimental.idle", (event) => pool.release(event.sessionID))

      // A session going idle ends its run; a step's price counts on its account.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.step.ended", "session.idle"] }).pipe(
          Stream.runForEach((event) =>
            event.type === "session.idle"
              ? pool.release(event.data.sessionID)
              : pool.stepEnded(event.data.sessionID, Number(event.data.cost), event.data.assistantMessageID),
          ),
          Effect.ignoreCause,
        ),
      )

      yield* Effect.forkScoped(pool.follow)

      if (options.sweepMinutes > 0)
        yield* Effect.forkScoped(
          pool.sweep.pipe(Effect.repeat(Schedule.spaced(`${options.sweepMinutes} minutes`)), Effect.delay(FIRST_SWEEP)),
        )

      // The pool's own RPC has no error to answer with: a pool whose logins
      // cannot be read fails the call, and its caller goes on without it. An
      // RPC that cannot be registered stops the plugin.
      yield* ctx.rpc
        .register(POOL_STATUS, {
          pace: (input) => pool.pace(providerOf(input)).pipe(Effect.orDie),
          status: () => pool.status.pipe(Effect.orDie),
          // A malformed question names no session: it has no account to name.
          session: (input) =>
            Option.match(decodeSessionQuery(input), { onNone: () => Effect.succeed({}), onSome: pool.session }),
          alerts: () => pool.alerts,
          // A malformed question names no session: it has no steps.
          logins: (input) => Option.match(decodeLoginsQuery(input), { onNone: () => Effect.succeed({ steps: [] }), onSome: pool.logins }),
        })
        .pipe(Effect.orDie)
    }),
  })

const decodeSessionQuery = Schema.decodeUnknownOption(SessionQuery)
const decodeLoginsQuery = Schema.decodeUnknownOption(LoginsQuery)

const providerOf = (input: unknown) =>
  typeof input === "object" && input !== null && "providerID" in input ? String(input.providerID) : ""

export default make(live)
