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
 *   lives the session stays on that login unless the login is held. Default 5 minutes, Anthropic's default; `bun run daily` sets it from
 *   the lifetime it gives Claude. A request whose agent sets its own lifetime
 *   (`request.settings.cacheTTL`, read through `ctx.agent.get`) keeps the
 *   session there for that lifetime instead, until the session comes back
 *   after that lifetime but within this one: its requests from that one on ask for
 *   this lifetime (`CACHE_TTL_HEADER`, which the auth plugin writes on the
 *   request's cache breakpoints) while each follows the last within it.
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
 * - `paced`: providers the pool measures without placing their requests, provider
 *   id to integration id, default none. `{ openai: "openai" }` paces OpenAI's
 *   agents on the ChatGPT account's Codex quota, as the provider measures it
 *   across every place the account is used (`@dotfiles/opencode-pool/chatgpt/usage`):
 *   the usage endpoint Codex CLI's /status reads, and the `x-codex-*` headers
 *   and `codex.rate_limits` frames on its responses. A paced pool that is not
 *   also placed reads its quota there, not from an auth plugin's RPC.
 *   `usageURL` points it elsewhere, for tests.
 * - `fleet`: this host among the owner's others. `host` names it in its
 *   reports (default the machine's host name); `peers` are the other hosts,
 *   each `{ name, ssh }` with `ssh` the destination (`bite-workbox`,
 *   `cvr@cristians-macbook-pro`) that runs `@dotfiles/opencode-pool/ssh/report`
 *   there over SSH (`command` replaces the whole command, for tests);
 *   `pollSeconds` (default 30) is how often each is read (OpenCode runs the
 *   plugin once per directory it serves; the instances share one fleet in the
 *   plugin's storage, and each peer is read by one of them); an agent `started`
 *   counts `startCost` (default 0.005, half a percentage point of one account's
 *   week) on the pace here and on every peer for `settleMinutes` (default 10),
 *   until its spend shows in a reading. Default no peers.
 * - `resets`: work the accounts' rate-limit resets (`@dotfiles/opencode-pool/resets`).
 *   Default true. When a start is held and every account of a ChatGPT pool is
 *   held by a spent window, the pool claims one Codex reset credit (and one
 *   about to expire unused on a half-spent week); for the `anthropic` pool it
 *   never claims unasked: it asks the owner once per hold in the waiting
 *   session's root (the questions plugin's `askFor`), with the days left before
 *   the account's weekly reset, and claims only on a yes. After a claim it reads
 *   the account again and records whether the weekly reset moved. `resets`
 *   answers what is being worked and the claims made, for the /pool pane.
 *
 * `started` records a new agent (orchestrate calls it once a subagent starts),
 * `report` answers a peer with this host's starts and its readings (never a
 * token), and `fleet` names each peer, its starts and, while it cannot be read,
 * since when and why, for the /pool pane. A peer's reading of a login this
 * pool lists replaces an older one held here. A peer that cannot be read is
 * logged once, and the pace goes on without it.
 *
 * `alerts` names every gent login whose refresh token the token endpoint
 * refused, with the command that signs it in again, until its file holds
 * another login, and every source whose refreshes are out, with the
 * endpoint's last status, `server` and `retry-after`. The status mod's TUI
 * shows them in the sidebar and as a toast.
 */
import { hostname } from "node:os"
import { Agent, Integration, Plugin } from "@opencode/plugin/effect"
import { Clock, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { PoolId } from "@dotfiles/opencode-pool/account-pool"
import { CACHE_LIFE_MS, ttlMs, ttlOf } from "@dotfiles/opencode-pool/accounts"
import { OUTAGE_AFTER_MS } from "@dotfiles/opencode-pool/alerts"
import * as ChatGPT from "@dotfiles/opencode-pool/chatgpt/usage"
import { GentSource, registerCredentialSource } from "@dotfiles/opencode-pool/gent/store"
import * as Model from "@dotfiles/opencode-pool/model"
import * as FleetStoreLive from "@dotfiles/opencode-pool/opencode/fleet"
import * as LedgerLive from "@dotfiles/opencode-pool/opencode/ledger"
import * as LoginsLive from "@dotfiles/opencode-pool/opencode/logins"
import * as OwnerLive from "@dotfiles/opencode-pool/opencode/owner"
import * as QuotaLive from "@dotfiles/opencode-pool/opencode/quota"
import * as ResetsStoreLive from "@dotfiles/opencode-pool/opencode/resets"
import { quotaProtocol, type QuotaReading } from "@dotfiles/opencode-pool/quota"
import type { ResetProvider } from "@dotfiles/opencode-pool/resets"
import type { FleetStore, Ledger, Logins, Owner, Peers, Quota, ResetsStore } from "@dotfiles/opencode-pool/service"
import * as PeersLive from "@dotfiles/opencode-pool/ssh/peers"
import { LoginsQuery, POOL_STATUS, SessionQuery, StartedQuery } from "@dotfiles/opencode-pool/status"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"

export { POOL_STATUS } from "@dotfiles/opencode-pool/status"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The request header that names the login a request goes out on. Its auth plugin strips it. */
export const CREDENTIAL_HEADER = "x-opencode-credential-id"

/**
 * The request header that names the lifetime a request's cache is written for
 * ("1h") when it is not the one its agent keeps: the provider's, once the
 * session has outlived its agent's own. Its auth plugin strips it and sets the
 * lifetime on the request's cache breakpoints.
 */
export const CACHE_TTL_HEADER = "x-opencode-cache-ttl"

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

const PeerOption = Schema.Struct({
  name: Schema.NonEmptyString,
  ssh: Schema.NonEmptyString,
  command: Schema.optional(Schema.Array(Schema.String)),
})

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

const FleetOption = Schema.Struct({
  host: Schema.NonEmptyString.pipe(withDefault(hostname())),
  peers: Schema.Array(PeerOption).pipe(withDefault<ReadonlyArray<typeof PeerOption.Type>>([])),
  pollSeconds: Positive.pipe(withDefault(30)),
  settleMinutes: Positive.pipe(withDefault(Model.DEFAULT_FLEET.settleMs / 60_000)),
  startCost: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(withDefault(Model.DEFAULT_FLEET.startCost)),
})

export const Options = Schema.Struct({
  providers: Schema.Record(Schema.String, PoolId).pipe(
    withDefault<Readonly<Record<string, PoolId>>>({ anthropic: PoolId.make("anthropic") }),
  ),
  sweepMinutes: Schema.Finite.pipe(withDefault(10)),
  cacheLifeMs: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(withDefault(CACHE_LIFE_MS)),
  sources: Schema.Array(GentStoreOption).pipe(withDefault<ReadonlyArray<typeof GentStoreOption.Type>>([])),
  refreshOutageMinutes: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(withDefault(OUTAGE_AFTER_MS / 60_000)),
  paced: Schema.Record(Schema.String, PoolId).pipe(withDefault<Readonly<Record<string, PoolId>>>({})),
  usageURL: Schema.optional(Schema.String),
  fleet: FleetOption.pipe(withDefault<typeof FleetOption.Type>(Schema.decodeSync(FleetOption)({}))),
  resets: Schema.Boolean.pipe(withDefault(true)),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Logins | Quota | Ledger | Peers | FleetStore | ResetsStore | Owner

/**
 * Whose rate-limit resets each pool holds, when `resets` is on: the pool of
 * the `anthropic` provider holds Claude grants, which are asked about; a
 * ChatGPT pool holds Codex credits, which are claimed.
 */
export const resetsOf = (options: Options): Readonly<Record<string, ResetProvider>> => {
  if (!options.resets) return {}
  const resets: Record<string, ResetProvider> = {}
  if (options.providers.anthropic !== undefined) resets[options.providers.anthropic] = "claude"
  for (const pool of chatgptPools(options)) resets[pool] = "codex"
  return resets
}

/** The pools paced only, never placed: each reads the ChatGPT account's quota. */
const chatgptPools = (options: Options): ReadonlyArray<PoolId> => {
  const placed = new Set(Object.values(options.providers))
  return [...new Set(Object.values(options.paced))].filter((pool) => !placed.has(pool))
}

/**
 * A ChatGPT login of the pool's integration, as its access token and account,
 * refreshed by the host when it is about to expire. Another kind of login, or
 * one the integration does not list, is none.
 */
const chatgptLogin = (ctx: Plugin.Context, pool: PoolId) => (credentialID: string) =>
  ctx.integration.get({ integrationID: Integration.ID.make(pool) }).pipe(
    Effect.flatMap((integration) => {
      const connection = integration.data.connections.find((found) => found.type === "credential" && found.id === credentialID)
      return connection === undefined ? Effect.succeed(undefined) : ctx.integration.connection.resolve(connection)
    }),
    Effect.map((credential): ChatGPT.Login | undefined => {
      if (credential?.type !== "oauth") return undefined
      const accountID = credential.metadata?.["accountID"]
      return { access: credential.access, ...(typeof accountID === "string" ? { accountID } : {}) }
    }),
  )

/** The ChatGPT quota sources of the paced pools, by pool. */
const chatgptSources = (ctx: Plugin.Context, options: Options) =>
  Effect.gen(function* () {
    const sources = new Map<PoolId, ChatGPT.Source>()
    for (const pool of chatgptPools(options))
      sources.set(
        pool,
        yield* ChatGPT.make({ login: chatgptLogin(ctx, pool), ...(options.usageURL === undefined ? {} : { url: options.usageURL }) }),
      )
    return sources
  })

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
export const live = (
  ctx: Plugin.Context,
  options: Options,
  sources: ReadonlyArray<GentSource>,
  chatgpt: ReadonlyMap<PoolId, ChatGPT.Source>,
): Layer.Layer<Externals> =>
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
        const paced = chatgpt.get(pool)
        if (paced !== undefined) return paced.rpc
        const client = ctx.rpc(quotaProtocol(pool))
        return {
          reading: (input) => client.reading(input),
          usage: (input) => client.usage(input),
          claim: (input) => client.claim(input),
          published: client.events.subscribe("reading"),
        }
      }),
      LedgerLive.layer(ctx.storage),
      PeersLive.layer(options.fleet.peers),
      // The plugin's storage is the host's: every instance of the plugin reads the same fleet.
      FleetStoreLive.layer(ctx.storage),
      // And the same resets, so a hold is worked once on the host.
      ResetsStoreLive.layer(ctx.storage),
      OwnerLive.layer(questionsHost(ctx)),
    )

/** The questions plugin's RPC and the host's sessions, as the pool asks the owner through them. */
const questionsHost = (ctx: Plugin.Context): OwnerLive.Host => {
  // Reached at each call, not at setup: the questions plugin may start after the pool.
  const client = () => ctx.rpc(QUESTIONS)
  return {
    askFor: (input) => Effect.suspend(() => client().askFor({ ...input, options: [...input.options] })),
    asked: (input) => Effect.suspend(() => client().asked(input)),
    withdrawFor: (input) => Effect.suspend(() => client().withdrawFor(input)),
    changed: Stream.suspend(() => client().events.subscribe("changed")),
    parentOf: (sessionID) => ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map((session) => session.parentID)),
  }
}

/** The first sweep waits a moment so the providers' auth plugins have set up. */
const FIRST_SWEEP = "1 second"

/**
 * The plugin on `externals`: the live systems in OpenCode, test layers in the
 * seam tests. `externals` gets the gent sources the options name, so the
 * plugin registers with the auth plugin exactly the sources the pool lists.
 */
export const make = (
  externals: (
    ctx: Plugin.Context,
    options: Options,
    sources: ReadonlyArray<GentSource>,
    chatgpt: ReadonlyMap<PoolId, ChatGPT.Source>,
  ) => Layer.Layer<Externals>,
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
      const chatgpt = yield* chatgptSources(ctx, options)
      const services = yield* Layer.build(
        Model.layer({
          providers: options.providers,
          cacheLifeMs: options.cacheLifeMs,
          refreshOutageMs: options.refreshOutageMinutes * 60_000,
          paced: options.paced,
          fleet: {
            host: options.fleet.host,
            settleMs: options.fleet.settleMinutes * 60_000,
            startCost: options.fleet.startCost,
            pollMs: options.fleet.pollSeconds * 1000,
          },
          resets: resetsOf(options),
        }).pipe(Layer.provideMerge(externals(ctx, options, sources, chatgpt))),
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
      // `request.settings.cacheTTL`) holds its session on a login only that long, until the session
      // outlives it: the pool then gives it the provider's lifetime, which the request asks for
      // through CACHE_TTL_HEADER. An agent the host cannot name keeps the provider's lifetime.
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
            pool
              .place({
                providerID: event.model.providerID,
                sessionID: event.sessionID,
                kind: event.kind,
                ...(cacheLifeMs === undefined ? {} : { cacheLifeMs }),
                ...(source === undefined ? {} : { cacheOf: source }),
              })
              .pipe(
                Effect.map((placed) => {
                  if (placed === undefined) return
                  event.headers[CREDENTIAL_HEADER] = placed.credentialID
                  if (placed.cacheLifeMs !== undefined && placed.cacheLifeMs !== cacheLifeMs)
                    event.headers[CACHE_TTL_HEADER] = ttlOf(placed.cacheLifeMs)
                }),
              ),
          ),
        ),
      )

      // What a paced provider's response showed of the account's quota belongs
      // to the login OpenCode sends it on: the integration's active one.
      const observe = (providerID: string, read: (now: number) => QuotaReading | undefined) => {
        const paced = Object.hasOwn(options.paced, providerID) ? options.paced[providerID] : undefined
        const source = paced === undefined ? undefined : chatgpt.get(paced)
        if (paced === undefined || source === undefined) return Effect.void
        return Clock.currentTimeMillis.pipe(
          Effect.map(read),
          Effect.flatMap((reading) =>
            reading === undefined
              ? Effect.void
              : ctx.integration.connection
                  .active(paced)
                  .pipe(Effect.flatMap((connection) => (connection?.type === "credential" ? source.observe(connection.id, reading) : Effect.void))),
          ),
        )
      }

      yield* ctx.session.hook("http.response", (event) =>
        pool
          .responded({
            providerID: event.model.providerID,
            sessionID: event.sessionID,
            kind: event.kind,
            status: event.response.status,
          })
          .pipe(
            Effect.andThen(
              observe(event.model.providerID, (now) => ChatGPT.fromHeaders((name) => event.response.headers.get(name), now)),
            ),
          ),
      )

      if (chatgpt.size > 0)
        yield* ctx.session.hook("experimental.ws.receive", (event) =>
          observe(event.model.providerID, (now) => ChatGPT.fromFrame(event.frame, now)),
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

      // The owner's answer to a reset's question is read as soon as the questions change.
      if (Object.keys(resetsOf(options)).length > 0) yield* Effect.forkScoped(pool.followAnswers)

      if (options.sweepMinutes > 0)
        yield* Effect.forkScoped(
          pool.sweep.pipe(Effect.repeat(Schedule.spaced(`${options.sweepMinutes} minutes`)), Effect.delay(FIRST_SWEEP)),
        )

      if (options.fleet.peers.length > 0)
        yield* Effect.forkScoped(pool.poll.pipe(Effect.repeat(Schedule.spaced(`${options.fleet.pollSeconds} seconds`))))

      // The pool's own RPC has no error to answer with: a pool whose logins
      // cannot be read fails the call, and its caller goes on without it. An
      // RPC that cannot be registered stops the plugin.
      yield* ctx.rpc
        .register(POOL_STATUS, {
          pace: (input) => pool.pace(providerOf(input), modelOf(input), sessionOf(input)).pipe(Effect.orDie),
          status: () => pool.status.pipe(Effect.orDie),
          // A malformed question names no session: it has no account to name.
          session: (input) =>
            Option.match(decodeSessionQuery(input), { onNone: () => Effect.succeed({}), onSome: pool.session }),
          alerts: () => pool.alerts,
          // A malformed question names no session: it has no steps.
          logins: (input) => Option.match(decodeLoginsQuery(input), { onNone: () => Effect.succeed({ steps: [] }), onSome: pool.logins }),
          // A malformed question names no provider: nothing started.
          started: (input) =>
            Option.match(decodeStartedQuery(input), {
              onNone: () => Effect.succeed({}),
              onSome: ({ providerID }) => pool.started(providerID).pipe(Effect.as({})),
            }),
          report: () => pool.report,
          fleet: () => pool.fleet,
          resets: () => pool.resets,
        })
        .pipe(Effect.orDie)
    }),
  })

const decodeSessionQuery = Schema.decodeUnknownOption(SessionQuery)
const decodeLoginsQuery = Schema.decodeUnknownOption(LoginsQuery)
const decodeStartedQuery = Schema.decodeUnknownOption(StartedQuery)

const providerOf = (input: unknown) =>
  typeof input === "object" && input !== null && "providerID" in input ? String(input.providerID) : ""

/** The model a pace question names, if it names one as a string. */
const modelOf = (input: unknown) =>
  typeof input === "object" && input !== null && "model" in input && typeof input.model === "string" ? input.model : undefined

/** The session a pace question comes from, if it names one: the one whose start waits when the pace holds it. */
const sessionOf = (input: unknown) =>
  typeof input === "object" && input !== null && "sessionID" in input && typeof input.sessionID === "string" && input.sessionID !== ""
    ? input.sessionID
    : undefined

export default make(live)
