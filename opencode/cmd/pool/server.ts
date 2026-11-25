/**
 * The pool as an OpenCode server plugin. The composition root: it decodes the
 * options, builds the pool model (`@dotfiles/opencode-pool/model`) on its
 * outside systems (its `opencode/` and `store/` implementations), and answers
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
 *   Only `anthropic` has an auth plugin that signs and confirms a placement.
 *   Other keys track the host's OAuth login; they cannot switch its credential.
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
 *   in place, never copied. Default none. `[{ kind: "store", dir: "~/.local/share/opencode-prime/pool-auth" }]`
 *   adds the Claude accounts signed in to that login store (`@dotfiles/opencode-pool/store/store`) to the
 *   `anthropic` pool as `store:<label>`; the pool refreshes their tokens under
 *   the store's lock and the auth plugin takes them from it (`registerCredentialSource`).
 *   `tokenURL` points a source's refresh elsewhere, for tests. The `anthropic`
 *   provider is then available without a login of OpenCode's own, as a
 *   configured provider is (unless the config disables it).
 * - `refreshOutageMinutes`: how long every refresh from a source must fail
 *   (a 429, a 5xx, no answer) before the `alerts` method names it as an
 *   outage. Default 10.
 *
 * - `paced`: providers whose active login the pool admits at the final send hook, provider
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
 *   until its spend shows in a reading. Default no peers. No host is the
 *   master of the resets: before a claim, a host asks each peer for the
 *   provider's lease over SSH (`@dotfiles/opencode-pool/ssh/lease`, the
 *   peer's `lease`). A claim the pool decided on its own is sent only once
 *   every peer granted it; with a peer that does not answer in 10 s, it is
 *   not sent (the claim's record says so) and goes again later, as any claim
 *   that did not go through. A push's claim passes over such a peer: the
 *   owner approved it with the push. A host just started lends nothing for 5 minutes, and none claims on
 *   a reading taken less than 5 minutes after a claim it sent or was told of.
 * - `resets`: work the accounts' rate-limit resets (`@dotfiles/opencode-pool/resets`).
 *   Default true. The owner approved every reset in hand ahead of time: the
 *   pool spends them on its own, Claude's and Codex's alike, and never asks
 *   (`@dotfiles/opencode-pool/claim-rule`): first a reset about to expire
 *   unused (one expiring within a day is just used, on a spent window or at
 *   its last call), then the work goes to a fresh account while one can take
 *   it, and only then a reset for held work, when the work would spend at
 *   least half of what it gives back before the window resets by itself;
 *   never for a window that resets by itself soon anyway (5-hour within 30
 *   minutes, a week within a day), at most one claim per window period per
 *   account. After a claim it reads the account again, records whether the
 *   weekly reset moved, and tells the owner once in the tray of the session
 *   that waited last (`Claimed the 5h reset on …`). `resets` answers what is
 *   being worked and the claims made, for the /pool pane. The pace raises an
 *   account's line by what a reset in hand gives back, and starts it again
 *   from a claim. A claim the pool decides on its own is made only on the account's fields read in the last 15
 *   minutes and after its last claim (a window carried over from an older
 *   reading counts as unread), one at a time per account (its login, in any
 *   pool). Every claim, a push's too, is sent under one lock per provider
 *   after reading the account again, and only if that reading still finds it
 *   worth it; else it is recorded as not sent.
 *   `{ "auto": false }` works resets but claims none on its own; a push's
 *   approved resets still go. `true` is `{ "auto": true }`.
 *
 * - `unitCost`: what one queued orchestrate unit is taken to cost, as a share
 *   of one account's week, for a push's plan (`@dotfiles/opencode-pool/push`).
 *   Default 0.1.
 *
 * A push (`@dotfiles/opencode-pool/push`) is an owner-approved, time-boxed
 * spend plan: the `pool_push` tool (start, status, end, plan) starts one from
 * the owner's session, and the `push` RPC takes the same request, so a push
 * for a peer (`host`) runs there over SSH (`@dotfiles/opencode-pool/ssh/push`).
 * While one is active in its scope (a host, and a session's tree or a run),
 * the spend-evenly hold does not hold a start there until its approved resets
 * are spent; an account whose week is spent, or a start held for lack of
 * quota, has one of its resets claimed (the owner's approval: the fleet's
 * lease and the read before the send still apply). The sweep ends pushes past
 * their end or whose run closed (the status plugin's runs). The pool never
 * asks to start one. `resets` answers the forecast and the pushes on, for
 * the /pool pane.
 *
 * `started` records a new agent (orchestrate calls it once a subagent starts),
 * `report` answers a peer with this host's starts and its readings (never a
 * token), and `fleet` names each peer, its starts and, while it cannot be read,
 * since when and why, for the /pool pane. A peer's reading of a login this
 * pool lists replaces an older one held here. A peer that cannot be read is
 * logged once, and the pace goes on without it.
 *
 * - `limitsFile`: where the limit tally is kept (`@dotfiles/opencode-pool/limits`):
 *   what each model family costs in points of one account's limit per million
 *   tokens. Default `$XDG_STATE_HOME/opencode-pool/limits.json`. Each step's
 *   tokens count on the login it went out on (a paced provider's: the
 *   integration's active login), each reading closes a window period's row,
 *   each sweep writes the tally there, and a peer's report adds the tokens it
 *   sent on the same logins. `limits` answers the tally and its line.
 *
 * `alerts` names every store login whose refresh token the token endpoint
 * refused, with the slot file to sign it in to again, until its file holds
 * another login, and every source whose refreshes are out, with the
 * endpoint's last status, `server` and `retry-after`. The status mod's TUI
 * shows them in the sidebar and as a toast.
 */
import { hostname } from "node:os"
import { Agent, Integration, Plugin, Tool } from "@opencode/plugin/effect"
import { Cause, Clock, Context, Deferred, Effect, Exit, type FileSystem, Layer, Option, type Path, Schedule, Schema, type Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { heldMessage, PoolId } from "@dotfiles/opencode-pool/account-pool"
import { type HoldReason, type Pace, RequestHeld, requestHeldMessage, storeHeld, nextRetryAt } from "@dotfiles/opencode-pool/pace"
import { deferRoute, HeldSend, refuseSend, type SendHold, sendHoldMessage, stepIDOf } from "@dotfiles/opencode-pool/refuse"
import { HANDOFF_HEADER, HOLD_STORE_RETRY_MS, Handoff, HandoffInput, sentPlacementOf } from "@dotfiles/opencode-pool/handoff"
import { CACHE_LIFE_MS, ttlMs, ttlOf } from "@dotfiles/opencode-pool/accounts"
import { OUTAGE_AFTER_MS } from "@dotfiles/opencode-pool/alerts"
import * as AgyLive from "@dotfiles/opencode-pool/antigravity/live"
import type * as AgySource from "@dotfiles/opencode-pool/antigravity/source"
import * as AgyWiring from "@dotfiles/opencode-pool/antigravity/wiring"
import * as ChatGPT from "@dotfiles/opencode-pool/chatgpt/usage"
import { StoreSource, type StoreSourceOptions, registerCredentialSource } from "@dotfiles/opencode-pool/store/store"
import * as Model from "@dotfiles/opencode-pool/model"
import * as FleetStoreLive from "@dotfiles/opencode-pool/opencode/fleet"
import * as LedgerLive from "@dotfiles/opencode-pool/opencode/ledger"
import * as LoginsLive from "@dotfiles/opencode-pool/opencode/logins"
import { migrate } from "@dotfiles/opencode-pool/opencode/migrate"
import * as OwnerLive from "@dotfiles/opencode-pool/opencode/owner"
import * as PushStoreLive from "@dotfiles/opencode-pool/opencode/pushes"
import * as WorkloadLive from "@dotfiles/opencode-pool/opencode/workload"
import { PUSH_DESCRIPTION, PushRequest, PushToolInput } from "@dotfiles/opencode-pool/push"
import * as QuotaLive from "@dotfiles/opencode-pool/opencode/quota"
import * as ResetsStoreLive from "@dotfiles/opencode-pool/opencode/resets"
import * as Records from "@dotfiles/opencode-pool/opencode/records"
import { quotaProtocol, type QuotaReading } from "@dotfiles/opencode-pool/quota"
import type { ResetProvider } from "@dotfiles/opencode-pool/resets"
import { LeaseMessage } from "@dotfiles/opencode-pool/lease"
import type { Tokens } from "@dotfiles/opencode-pool/limits"
import * as LimitsLive from "@dotfiles/opencode-pool/opencode/limits"
import { AntigravityReporter, FleetStore, type Ledger, type Limits, type Logins, type Owner, type Peers, type PushStore, type Quota, type ResetsStore, type Workload } from "@dotfiles/opencode-pool/service"
import * as FleetModel from "@dotfiles/opencode-pool/fleet"
import * as PeersLive from "@dotfiles/opencode-pool/ssh/peers"
import { LoginsQuery, POOL_STATUS, SessionQuery, StartedQuery } from "@dotfiles/opencode-pool/status"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { STATUS } from "@dotfiles/opencode-status/status"

export { POOL_STATUS } from "@dotfiles/opencode-pool/status"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
const HostSessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))

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

const LoginStoreOption = Schema.Struct({
  kind: Schema.Literal("store"),
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
  sources: Schema.Array(LoginStoreOption).pipe(withDefault<ReadonlyArray<typeof LoginStoreOption.Type>>([])),
  refreshOutageMinutes: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(withDefault(OUTAGE_AFTER_MS / 60_000)),
  paced: Schema.Record(Schema.String, PoolId).pipe(withDefault<Readonly<Record<string, PoolId>>>({})),
  usageURL: Schema.optional(Schema.String),
  fleet: FleetOption.pipe(withDefault<typeof FleetOption.Type>(Schema.decodeSync(FleetOption)({}))),
  resets: Schema.Union([Schema.Boolean, Schema.Struct({ auto: Schema.Boolean.pipe(withDefault(true)) })]).pipe(
    withDefault<boolean | { readonly auto: boolean }>(true),
  ),
  limitsFile: Schema.optional(Schema.String),
  unitCost: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  antigravity: AgyLive.PoolOption.pipe(withDefault<AgyLive.PoolOption>({})),
})
export type Options = typeof Options.Type

const SEND_HOLD_PREFIX = "held-send/"
const SEND_HOLD_RETENTION_MS = 24 * 60 * 60 * 1000
const sendHoldKey = (sessionID: string) => `${SEND_HOLD_PREFIX}${sessionID}`
const decodeSendHold = Schema.decodeUnknownEffect(HeldSend)
const sendHoldOf = Schema.decodeUnknownOption(HeldSend)
const frameType = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.String })))
type SendScope = { readonly sessionID: string; readonly providerID: string; readonly kind: Model.PlaceInput["kind"]; readonly stepID?: string }

/** The outside systems the model runs on. */
export type Externals = Logins | Quota | Ledger | Peers | FleetStore | ResetsStore | Owner

/**
 * Whose rate-limit resets each pool holds, when `resets` is on: the pool of
 * the `anthropic` provider holds Claude grants; a ChatGPT pool holds Codex
 * credits. The pool claims both on its own.
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
const chatgptSources = (ctx: Plugin.Context, options: Options, host: StoreHost) =>
  Effect.gen(function* () {
    const sources = new Map<PoolId, ChatGPT.Source>()
    for (const pool of chatgptPools(options))
      sources.set(
        pool,
        yield* ChatGPT.make({
          login: chatgptLogin(ctx, pool),
          ...(options.usageURL === undefined ? {} : { url: options.usageURL }),
          ...Option.match(Option.fromNullishOr(host.source.fetch), { onNone: () => ({}), onSome: (send) => ({ fetch: send }) }),
        }),
      )
    return sources
  })

/** A login store keeps Claude accounts: they join the pool of the `anthropic` provider. */
const storePool = (options: Options): PoolId | undefined => options.providers.anthropic

/**
 * The login stores the options name, each read in place. One per directory per
 * process. Each logs its refreshes to the host's log through `context`.
 */
const storeSources = (options: Options, context: Context.Context<never>, host: StoreHost) =>
  storePool(options) === undefined
    ? []
    : options.sources.map(
        (source) =>
          new StoreSource({
            dir: source.dir,
            context,
            ...(source.tokenURL === undefined ? {} : { tokenURL: source.tokenURL }),
            ...host.source,
          }),
      )

/**
 * What the login stores reach outside the plugin: in OpenCode the disk, this
 * process, the network and the process-wide registry the auth plugin reads
 * (`LIVE_STORE_HOST`); on the simulated world, the world's.
 */
export interface StoreHost {
  /** What each source reaches: its files and lock, its process, its fetch (the ChatGPT usage endpoint's too). */
  readonly source: Pick<StoreSourceOptions, "files" | "process" | "fetch">
  /** Registers a source with the auth plugin for an integration; the returned function removes it. */
  readonly register: (integrationID: string, source: StoreSource) => () => void
}

export const LIVE_STORE_HOST: StoreHost = { source: {}, register: registerCredentialSource }

/**
 * Antigravity's quota source for the `antigravity` option (`@dotfiles/opencode-pool/antigravity/live`):
 * in OpenCode, one authority per state file in the process, built with no I/O, which reads only when asked
 * (the keychain only with a consent, once); none in a
 * test's pool, so no test reads a real profile or keychain. Its files and paths are the host's: the fork's plugin
 * host gives a server plugin FileSystem and Path (`@opencode/plugin/effect` `Plugin.Environment`), so the pool
 * imports no platform implementation.
 */
export type AntigravityRoot<R = never> = (option: AgyLive.PoolOption, fleet?: AgySource.FleetContext) => Effect.Effect<Option.Option<AgySource.Source>, never, Scope.Scope | R>
export const NO_ANTIGRAVITY: AntigravityRoot = () => Effect.succeed(Option.none())

/** What the live Antigravity root needs of the host: its files and paths, as the fork's plugin host provides them. */
export type AntigravityHost = FileSystem.FileSystem | Path.Path

/** The live root: one authority per state file in the process (`AgyLive.poolSource`), Google over fetch. */
export const liveAntigravity: AntigravityRoot<AntigravityHost> = (option, fleet) =>
  AgyLive.poolSource(option, fleet).pipe(Effect.provide(FetchHttpClient.layer))

/**
 * The outside systems as OpenCode provides them: its integrations, the auth plugins' quota RPC, the plugin's
 * storage; the fleet's peers as `peers` reaches them (over SSH in OpenCode, `PeersLive.layer`).
 */
export const liveWith = (
  peers: (configured: Options["fleet"]["peers"]) => Layer.Layer<Peers>,
  holds = LedgerLive.holdAuthority(),
) => {
  // The priced steps and the tally's requests, read and decoded once for every copy of the plugin in this process,
  // and written by one writer of its own (opencode/records.ts).
  const records = Records.make()
  return (
    ctx: Plugin.Context,
    options: Options,
    sources: ReadonlyArray<StoreSource>,
    chatgpt: ReadonlyMap<PoolId, ChatGPT.Source>,
  ): Layer.Layer<Externals | Limits | PushStore | Workload> => {
    const pools = new Set([...Object.values(options.providers), ...Object.values(options.paced)])
    const storage = ctx.storage
    const stores = records(storage)
    // State an older pool wrote names store logins by their legacy id: renamed before anything reads it.
    return Layer.unwrap(Effect.as(migrate(storage), Layer.mergeAll(
      // An older pool's one key per step or request is folded into chunks in the background, a page at a time.
      Layer.effectDiscard(Effect.forkScoped(stores.fold([...pools]))),
      LimitsLive.layer(storage, options.limitsFile ?? LimitsLive.defaultPath(), stores.uses),
      LoginsLive.layer(
        {
          connections: (pool) =>
            ctx.integration.get({ integrationID: Integration.ID.make(pool) }).pipe(Effect.map((integration) => integration.data.connections)),
          status: (pool, connection, status) => ctx.integration.connection.status({ integrationID: pool, connection, status }),
        },
        (pool) => (pool === storePool(options) ? sources.map(LoginsLive.storeSource) : []),
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
      LedgerLive.layer(storage, stores.steps, holds),
      peers(options.fleet.peers),
      // The plugin's storage is the host's: every instance of the plugin reads the same fleet.
      FleetStoreLive.layer(ctx.storage),
      // And the same resets, so a hold is worked once on the host.
      ResetsStoreLive.layer(ctx.storage),
      OwnerLive.layer(questionsHost(ctx)),
      // The pushes are the host's too: a push started in one project covers its scope in all of them.
      PushStoreLive.layer(ctx.storage),
      // The host's load, and the orchestrate runs of this directory from the status plugin (reached at each call: it may start after the pool).
      WorkloadLive.layer(() => Effect.suspend(() => ctx.rpc(STATUS).status({}))),
    )))
  }
}

/** The outside systems as OpenCode provides them, the peers over SSH. */
export const live = liveWith(PeersLive.layer, LedgerLive.processHoldAuthority())

/** The questions plugin's RPC and the host's sessions, as the pool tells the owner through them. */
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

/** How many started steps' models are held at most until their steps end. */
const STEP_MODELS = 1_000

/** The events that end a session's execution: the session goes idle on each, but an interruption for a shutdown. */
const EXECUTION_ENDED = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)

/** A step's tokens as the host's event carries them (`TokenUsage.Info`), output with its reasoning; none when it carries none. */
export const tokensOf = (tokens: unknown): Tokens | undefined => {
  if (!isRecord(tokens)) return undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  return {
    input: count(tokens.input),
    output: count(tokens.output) + count(tokens.reasoning),
    cacheRead: count(cache.read),
    cacheWrite: count(cache.write),
  }
}

/** The first sweep waits a moment so the providers' auth plugins have set up. */
const FIRST_SWEEP = "1 second"

/**
 * The plugin on `externals`: the live systems in OpenCode, test layers in the
 * seam tests. `externals` gets the store sources the options name, so the
 * plugin registers with the auth plugin exactly the sources the pool lists.
 */
export const make = <R = never,>(
  externals: (
    ctx: Plugin.Context,
    options: Options,
    sources: ReadonlyArray<StoreSource>,
    chatgpt: ReadonlyMap<PoolId, ChatGPT.Source>,
  ) => Layer.Layer<Externals>,
  storeHost: StoreHost = LIVE_STORE_HOST,
  sendRecords = LedgerLive.holdAuthority().lock,
  antigravity: AntigravityRoot<R> = NO_ANTIGRAVITY,
) =>
  Plugin.define({
    id: "dotfiles-opencode.pool",
    effect: Effect.fn("Pool.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.pool: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // The established Anthropic signing path supplies its own final decision.
      // Every other tracked route (including aliases) uses the host hooks.
      const signed = (providerID: string) => providerID === "anthropic" && Object.hasOwn(options.providers, providerID)
      const tracked = (providerID: string) => Option.orElse(
        Option.filter(Option.fromUndefinedOr(options.providers[providerID]), () => Object.hasOwn(options.providers, providerID)),
        () => Option.filter(Option.fromUndefinedOr(options.paced[providerID]), () => Object.hasOwn(options.paced, providerID)),
      )
      const lastLogin = new Map<string, string>()
      const noLogin = { ok: true, measured: false, tracking: "not-tracked-no-pool-login", reason: "not tracked: no pool login" } satisfies Pace
      const loginOf = (integrationID: string) => ctx.integration.connection.active(integrationID).pipe(
        Effect.map((connection) => {
          const selected = Option.fromUndefinedOr(connection)
          if (Option.isNone(selected)) return { active: false, id: Option.fromUndefinedOr(lastLogin.get(integrationID)) }
          const value = selected.value
          if (value.type === "credential" && value.method === "oauth") {
            lastLogin.set(integrationID, value.id)
            return { active: true, id: Option.some<string>(value.id) }
          }
          lastLogin.delete(integrationID)
          return { active: false, id: Option.none<string>() }
        }),
      )
      // The plugin's context carries the host's loggers.
      const sources = storeSources(options, yield* Effect.context<never>(), storeHost)
      const chatgpt = yield* chatgptSources(ctx, options, storeHost)
      // Antigravity's quota: built with no I/O, read only when asked; its rows come from the merged fleet record, and no
      // failure of its code reaches the pool (AgyWiring is the one boundary). What the root needs of the host (the live
      // one: its files and paths) is this plugin's requirement, so a host that does not give it is a compile error.
      const agyFleetStore = Context.get(yield* Layer.build(FleetStoreLive.layer(ctx.storage)), FleetStore)
      const agyFleet: AgySource.FleetContext = {
        read: Effect.gen(function* () {
          const state = yield* agyFleetStore.read
          const now = yield* Clock.currentTimeMillis
          const settleMs = options.fleet.settleMinutes * 60_000
          return {
            host: options.fleet.host,
            peers: state.peers,
            peerNames: options.fleet.peers.map((peer) => peer.name),
            starts: FleetModel.inflight(state, now, settleMs),
            ownStarts: FleetModel.ownStarts(state, now, settleMs),
            settleMs,
          }
        }),
        recordStart: (providerID) => withPool((pool) => pool.started(providerID)).pipe(Effect.ignoreCause),
      }
      const agy = AgyWiring.wire(yield* AgyWiring.availability(antigravity(options.antigravity, agyFleet)))

      // The pool model starts from its ledger, a week of priced steps (~190k entries on the workbox, a scan of tens
      // of seconds at its load, in each location). The host activates a location's plugins one after another and
      // serves no provider or model until all have, so the model builds off that path: the plugin's hooks, tools and
      // RPCs are in place at once and each waits for the model, a request's placement too. A model that cannot be
      // built fails every one of them.
      const ready = yield* Deferred.make<Model.Pool["Service"]>()
      let active = true
      yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
      const withPool = <A, E, R>(use: (pool: Model.Pool["Service"]) => Effect.Effect<A, E, R>) =>
        Deferred.await(ready).pipe(Effect.flatMap(use))
      const routeTracking = (integration: string, input: Model.PlaceInput) => Effect.gen(function* () {
        const login = yield* loginOf(integration)
        if (login.active) return Option.none<Pace>()
        if (Option.isNone(login.id)) return Option.some<Pace>(noLogin)
        const candidate = login.id.value
        return yield* withPool((pool) => pool.admitActive(input, candidate, "signed-out")).pipe(
          Effect.as(Option.some<Pace>(noLogin)),
          Effect.catchTag("RequestHeld", (hold) => Clock.currentTimeMillis.pipe(Effect.map((now) => Option.some<Pace>({
            ok: false, measured: true, reason: requestHeldMessage(hold), reasonCode: hold.reasonCode, retryAt: nextRetryAt(now, [hold.retryAt]),
          })))),
        )
      })
      // The deadline changes what the record says, not whether it exists.
      // Reading from storage and the current clock also works after a restart,
      // without a timer, an activation scan, or a missed expiry to recover.
      const heldSend = (sessionID: string) => Effect.gen(function* () {
        const raw = Option.fromUndefinedOr(yield* ctx.storage.get(sendHoldKey(sessionID)))
        if (Option.isNone(raw)) return {}
        const hold = yield* decodeSendHold(raw.value).pipe(Effect.orDie)
        const now = yield* Clock.currentTimeMillis
        if (now >= hold.retryAt) return { state: "ended" as const, hold }
        return { state: "held" as const, hold }
      })
      const recordHeld = (scope: SendScope, reason: string, reasonCode: HoldReason, retry: number) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => {
          const retryAt = nextRetryAt(now, [retry])
          const hold = HeldSend.make({
            sessionID: scope.sessionID, providerID: scope.providerID, reasonCode, retryAt,
            ...Option.match(Option.fromUndefinedOr(scope.stepID), { onNone: () => ({}), onSome: (stepID) => ({ stepID }) }),
          })
          const refusal = { ...hold, reason }
          if (scope.kind !== "primary") return Effect.succeed(refusal)
          // No successful/typed refusal is published before this commit.
          return sendRecords.withPermits(1)(ctx.storage.set(sendHoldKey(scope.sessionID), hold)).pipe(Effect.as(refusal))
        }))
      const removeHeld = (sessionID: string) => Effect.gen(function* () {
        const key = sendHoldKey(sessionID)
        if (Option.isSome(Option.fromUndefinedOr(yield* ctx.storage.get(key)))) yield* ctx.storage.remove(key)
      })
      const pruneHeldSends = Effect.gen(function* () {
        const cutoff = (yield* Clock.currentTimeMillis) - SEND_HOLD_RETENTION_MS
        const expired = (hold: Option.Option<HeldSend>) => Option.exists(hold, (entry) => entry.retryAt <= cutoff)
        let after = Option.none<string>()
        do {
          const page = yield* ctx.storage.scan({
            prefix: SEND_HOLD_PREFIX,
            ...Option.match(after, { onNone: () => ({}), onSome: (after) => ({ after }) }),
          })
          for (const { key, value } of page.entries) {
            if (!expired(sendHoldOf(value))) continue
            // Admission or a new refusal may have changed the row since the scan.
            yield* sendRecords.withPermits(1)(Effect.gen(function* () {
              if (expired(sendHoldOf(yield* ctx.storage.get(key)))) yield* ctx.storage.remove(key)
            }))
          }
          after = Option.fromUndefinedOr(page.next)
        } while (Option.isSome(after))
      }).pipe(Effect.withSpan("Pool.pruneHeldSends"))
      yield* Effect.forkScoped(
        Effect.gen(function* () {
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
              autoClaims: typeof options.resets === "boolean" || options.resets.auto,
              ...(options.unitCost === undefined ? {} : { unitCost: options.unitCost }),
            }).pipe(
              Layer.provideMerge(externals(ctx, options, sources, chatgpt)),
              Layer.provideMerge(Layer.succeed(AntigravityReporter, AntigravityReporter.of({ report: agy.report }))),
            ),
          )
          const pool = Context.get(services, Model.Pool)
          yield* Deferred.succeed(ready, pool)

          yield* Effect.forkScoped(pool.follow)

          // A notice read leaves the tray as soon as the questions change.
          if (Object.keys(resetsOf(options)).length > 0) yield* Effect.forkScoped(pool.followAnswers)

          if (options.sweepMinutes > 0)
            yield* Effect.forkScoped(
              pool.sweep.pipe(
                Effect.andThen(pruneHeldSends.pipe(Effect.catchDefect((cause) => Effect.logWarning("pool held-send cleanup failed", cause)))),
                Effect.repeat(Schedule.spaced(`${options.sweepMinutes} minutes`)),
                Effect.delay(FIRST_SWEEP),
              ),
            )

          if (options.fleet.peers.length > 0)
            yield* Effect.forkScoped(pool.poll.pipe(Effect.repeat(Schedule.spaced(`${options.fleet.pollSeconds} seconds`))))
        }).pipe(
          Effect.withSpan("Pool.start"),
          Effect.onExit(
            Exit.match({
              onSuccess: () => Effect.void,
              // A start the plugin's end interrupted is no failure to report; its waiters end all the same.
              onFailure: (cause) =>
                Effect.when(Effect.logError(`dotfiles-opencode.pool: the pool did not start: ${Cause.pretty(cause)}`), Effect.sync(() => !Cause.hasInterruptsOnly(cause))).pipe(
                  Effect.andThen(Deferred.die(ready, Cause.squash(cause))),
                ),
            }),
          ),
        ),
      )

      // The auth plugin takes a store account's token from its source.
      const anthropic = storePool(options)
      if (anthropic !== undefined)
        for (const source of sources)
          yield* Effect.acquireRelease(
            Effect.sync(() => storeHost.register(anthropic, source)),
            (unregister) => Effect.sync(unregister),
          )

      // OpenCode offers a provider only when it holds a login for it or the config
      // names it: a store's accounts are logins it cannot see, so the pool names it.
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

      // The old host has no concrete unsent-Step result. New hosts expose
      // the Step during routing and again at the final send hook.
      let canDeferPrimary = false
      const failProposal = (scope: SendScope, reason: string, code: HoldReason, at: number) =>
        recordHeld(scope, reason, code, at).pipe(
          Effect.flatMap((hold) => Effect.die(new Error(hold.reason))),
        )
      yield* ctx.session.hook("model.request", (event) => {
        if (!signed(event.model.providerID)) {
          if (canDeferPrimary && event.kind === "primary") return Effect.void
          return gateActive(event, "known-hold", (hold) => Effect.die(new Error(sendHoldMessage(hold.reason, hold.until))))
        }
        return Effect.all([agentCacheLife(event.agent), cacheOf(event.sessionID)]).pipe(
          Effect.flatMap(([cacheLifeMs, source]) =>
            withPool((pool) =>
              pool.place({
                providerID: event.model.providerID,
                sessionID: event.sessionID,
                kind: event.kind,
                model: event.model.id,
                ...(cacheLifeMs === undefined ? {} : { cacheLifeMs }),
                ...(source === undefined ? {} : { cacheOf: source }),
              }),
            ).pipe(
                Effect.map((placed) => {
                  if (placed === undefined) return
                  event.headers[CREDENTIAL_HEADER] = placed.credentialID
                  event.headers[HANDOFF_HEADER] = "1"
                  if (placed.cacheLifeMs !== undefined && placed.cacheLifeMs !== cacheLifeMs)
                    event.headers[CACHE_TTL_HEADER] = ttlOf(placed.cacheLifeMs)
                }),
                // Every account held: the request goes out on none. The host ends the turn on the pool's own words
                // and when the first account opens; a hook declares no failure, so the refusal is its defect.
                Effect.catchTag("AccountsHeld", (held) =>
                  failProposal({ ...event, providerID: event.model.providerID }, heldMessage(held), "account-held", held.retryAt)),
                // Held by the pace at its dispatch: nothing goes out and no credential is set; the turn ends on why and when.
                Effect.catchTag("RequestHeld", (held) =>
                  failProposal({ ...event, providerID: event.model.providerID }, requestHeldMessage(held), held.reasonCode, held.retryAt)),
              ),
          ),
        )
      })

      type SendEvent = { readonly kind: Model.PlaceInput["kind"]; readonly sessionID: string;
        readonly model: { readonly providerID: string; readonly id: string } }
      const gateActive = (event: SendEvent, phase: "known-hold" | "send",
        bind: (held: SendHold) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          const admitted = Option.match(Option.filter(Option.some(event.sessionID), () => phase === "send" && event.kind === "primary"),
            { onNone: () => Effect.void, onSome: removeHeld })
          const poolID = tracked(event.model.providerID)
          if (Option.isNone(poolID)) return yield* sendRecords.withPermits(1)(admitted)
          const input = { providerID: event.model.providerID, sessionID: event.sessionID, kind: event.kind, model: event.model.id }
          const scope = { ...input, ...Option.match(stepIDOf(event), { onNone: () => ({}), onSome: (stepID) => ({ stepID }) }) }
          const refuse = (reason: string, code: HoldReason, at: number) => recordHeld(scope, reason, code, at).pipe(
            Effect.flatMap((hold) => bind({ reason: hold.reason, until: hold.retryAt })),
          )
          const login = yield* loginOf(poolID.value)
          if (Option.isNone(login.id)) return yield* sendRecords.withPermits(1)(admitted)
          const id = login.id.value
          const check = Option.getOrElse(Option.filter(Option.some(phase), () => login.active), () => "signed-out" as const)
          return yield* withPool((pool) => pool.admitActive(input, id, check, admitted)).pipe(
            Effect.catchTag("RequestHeld", (held) => refuse(requestHeldMessage(held), held.reasonCode, held.retryAt)))
        })
      yield* ctx.session.hook("experimental.model.resolve", (event) => Effect.suspend(() => {
        if (Option.isNone(stepIDOf(event))) return Effect.void
        canDeferPrimary = true
        if (signed(event.model.providerID)) return Effect.void
        return gateActive(event, "known-hold", (hold) => deferRoute(event, hold))
      }))
      // A concrete check belongs to this callback's one send. The host
      // consumes success when it forwards that request or response.create;
      // no permit survives to another send, even on the same Step or socket.
      const gateSend = (event: SendEvent) => gateActive(event, "send", (hold) => refuseSend(event, hold))
      yield* ctx.session.hook("http.request", (event) => {
        if (signed(event.model.providerID)) return Effect.void
        return gateSend(event)
      })
      yield* ctx.session.hook("experimental.ws.send", (event) => Effect.suspend(() => {
        if (!event.frame.startsWith('{"type":"response.create"') && !Option.exists(frameType(event.frame), ({ type }) => type === "response.create")) return Effect.void
        return gateSend(event)
      }))

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
        withPool((pool) =>
          pool.responded({
            providerID: event.model.providerID,
            sessionID: event.sessionID,
            kind: event.kind,
            status: event.response.status,
            credentialID: Option.getOrUndefined(Option.map(sentPlacementOf(event.request), (sent) => sent.credentialID)),
          }),
        ).pipe(
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
        withPool((pool) => pool.retry({ providerID: event.model.providerID, sessionID: event.sessionID, error: event.error.type })).pipe(
          Effect.map((failOver) => {
            if (failOver) event.decision = { retry: true, delay: 0 }
          }),
        ),
      )

      // The model each step runs, by its assistant message, from its start until it ends: the end names none.
      const stepModels = new Map<string, { readonly providerID: string; readonly id: string }>()

      /** What an ended step used, for the limit tally: a paced provider's step went out on the integration's active login. */
      const usageOf = (data: { readonly assistantMessageID?: string; readonly tokens?: unknown }): Effect.Effect<Model.StepUsage | undefined> => {
        const model = data.assistantMessageID === undefined ? undefined : stepModels.get(data.assistantMessageID)
        if (data.assistantMessageID !== undefined) stepModels.delete(data.assistantMessageID)
        const tokens = tokensOf(data.tokens)
        if (model === undefined || tokens === undefined) return Effect.succeed(undefined)
        const usage = { providerID: model.providerID, model: model.id, tokens }
        const paced = Object.hasOwn(options.paced, model.providerID) ? options.paced[model.providerID] : undefined
        if (paced === undefined || Object.hasOwn(options.providers, model.providerID)) return Effect.succeed<Model.StepUsage>(usage)
        return ctx.integration.connection.active(paced).pipe(
          Effect.map((connection): Model.StepUsage => (connection?.type === "credential" ? { ...usage, credentialID: connection.id } : usage)),
          Effect.orElseSucceed((): Model.StepUsage => usage),
        )
      }

      // A session going idle ends its run; a step's price counts on its account, and its tokens in the limit tally.
      // The host has no idle event: an execution that succeeded, failed or was interrupted is the session going
      // idle, as the host's own Idle message reads it. A shutdown is not: the resumed execution goes on with the run.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted", "session.step.started", "session.step.ended", ...EXECUTION_ENDED] }).pipe(
          Stream.runForEach((event) => {
            if (event.type === "session.deleted") return sendRecords.withPermits(1)(removeHeld(event.data.sessionID)).pipe(Effect.ignoreCause)
            if (event.type === "session.execution.interrupted") {
              if (event.data.reason === "shutdown") return Effect.void
              return withPool((pool) => pool.release(event.data.sessionID))
            }
            if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed")
              return withPool((pool) => pool.release(event.data.sessionID))
            if (event.type === "session.step.started") {
              // A step that never ends leaves its entry: past a bound, the oldest go.
              if (stepModels.size >= STEP_MODELS) stepModels.delete(stepModels.keys().next().value ?? "")
              if (event.data.model === undefined) return Effect.void
              stepModels.set(event.data.assistantMessageID, event.data.model)
              // The session is busy, an agent running for the reset forecast, until it goes idle.
              const providerID = event.data.model.providerID
              return withPool((pool) => pool.stepStarted(event.data.sessionID, providerID))
            }
            return usageOf(event.data).pipe(
              Effect.flatMap((usage) =>
                withPool((pool) => pool.stepEnded(event.data.sessionID, Number(event.data.cost), event.data.assistantMessageID, usage)),
              ),
            )
          }),
          Effect.ignoreCause,
        ),
      )

      // The owner's session starts, reads, ends or plans a push; the calling session scopes one that names `session`.
      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "pool_push",
          description: PUSH_DESCRIPTION,
          input: PushToolInput,
          // A direct tool beside the others, so it is offered without code mode and reached from a kernel cell.
          options: { codemode: false },
          execute: (input, context) =>
            withPool((pool) => pool.push({ ...input, sessionID: context.sessionID })).pipe(
              // A status names Antigravity's quota too, as last read.
              Effect.flatMap((answer) => Effect.map(agy.pushText(input.action, answer.text), (text) => ({ ...answer, text }))),
              Effect.flatMap((answer) =>
                answer.ok
                  ? Effect.succeed({ content: [{ type: "text" as const, text: answer.text }] })
                  : Effect.fail(new Tool.Error({ message: answer.text, error: answer })),
              ),
            ),
        })
        editor.add({ ...agy.tool, name: AgyWiring.TOOL_NAME })
      })

      // The pool's own RPC has no error to answer with: a pool whose logins
      // cannot be read fails the call, and its caller goes on without it. An
      // RPC that cannot be registered stops the plugin.
      const decodeHandoff = Schema.decodeUnknownOption(HandoffInput)
      const handoffUnavailable = (sessionID: string) => Clock.currentTimeMillis.pipe(Effect.map((now) =>
        Handoff.cases.Held.make({ message: requestHeldMessage(RequestHeld.make({
          sessionID, ...storeHeld(now + HOLD_STORE_RETRY_MS, now),
        })) }),
      ))
      const handoff = (decoded: Option.Option<HandoffInput>) => Effect.gen(function* () {
        if (Option.isNone(decoded)) return yield* handoffUnavailable("")
        const { candidate, agent, stepID, ...request } = decoded.value
        const scope = { ...request, ...Option.match(Option.fromUndefinedOr(stepID), { onNone: () => ({}), onSome: (stepID) => ({ stepID }) }) }
        const refused = (reason: string, reasonCode: HoldReason, retryAt: number) =>
          recordHeld(scope, reason, reasonCode, retryAt).pipe(
            Effect.as(Handoff.cases.Held.make({ message: reason })),
          )
        const decision = yield* withPool((pool) => Effect.gen(function* () {
          if (!active) return yield* handoffUnavailable(request.sessionID)
          const admitted = Effect.suspend(() => {
            if (!active || request.keepalive === true || scope.kind !== "primary") return Effect.void
            return removeHeld(scope.sessionID)
          })
          if (yield* pool.confirmed(request, candidate, admitted)) {
            if (active) return Handoff.cases.Send.make({})
            return yield* handoffUnavailable(request.sessionID)
          }
          if (request.keepalive === true) return Handoff.cases.Held.make({ message: "the keepalive's prepared login is held or no longer registered" })
          const cacheLife = Option.fromUndefinedOr(yield* agentCacheLife(agent))
          const source = Option.fromUndefinedOr(yield* cacheOf(HostSessionID.make(request.sessionID)))
          const placed = yield* pool.place({
            ...request,
            ...Option.match(cacheLife, { onNone: () => ({}), onSome: (cacheLifeMs) => ({ cacheLifeMs }) }),
            ...Option.match(source, { onNone: () => ({}), onSome: (cacheOf) => ({ cacheOf }) }),
          })
          const placement = Option.fromUndefinedOr(placed)
          if (Option.isNone(placement)) return yield* handoffUnavailable(request.sessionID)
          const ttl = Option.filter(Option.fromUndefinedOr(placement.value.cacheLifeMs), (life) => !Option.contains(cacheLife, life))
          return Handoff.cases.Prepare.make({
            credentialID: placement.value.credentialID,
            ...Option.match(ttl, { onNone: () => ({}), onSome: (life) => ({ cacheTTL: ttlOf(life) }) }),
          })
        })).pipe(Effect.catchTags({
          AccountsHeld: (held) => refused(heldMessage(held), "account-held", held.retryAt),
          RequestHeld: (held) => refused(requestHeldMessage(held), held.reasonCode, held.retryAt),
        }))
        return decision
      })
      yield* ctx.rpc
        .register(POOL_STATUS, {
          pace: (input) => Effect.gen(function* () {
            const provider = providerOf(input)
            const integration = Option.filter(tracked(provider), () => !signed(provider))
            if (Option.isSome(integration)) {
              const tracking = yield* routeTracking(integration.value, {
                providerID: provider, sessionID: Option.getOrElse(Option.fromUndefinedOr(sessionOf(input)), () => ""),
                kind: "primary", model: modelOf(input) ?? "",
              })
              if (Option.isSome(tracking)) return tracking.value
            }
            return yield* withPool((pool) => pool.pace(provider, modelOf(input), sessionOf(input), dispatchOf(input)))
          }).pipe(Effect.orDie),
          heldSend: ({ sessionID }) => heldSend(sessionID),
          handoff: (input) => handoff(decodeHandoff(input)),
          status: () => Effect.gen(function* () {
            const status = { ...yield* withPool((pool) => pool.status) }
            for (const providerID of new Set([...Object.keys(options.providers), ...Object.keys(options.paced)])) {
              const id = Option.filter(tracked(providerID), () => !signed(providerID))
              if (Option.isNone(id)) continue
              const entry = Option.fromUndefinedOr(status[id.value])
              if (Option.isNone(entry)) continue
              const tracking = yield* routeTracking(id.value, { providerID, sessionID: "", kind: "primary", model: "" })
              if (Option.exists(tracking, (answer) => answer.tracking === noLogin.tracking))
                status[id.value] = { ...entry.value, untrackedRoutes: { ...entry.value.untrackedRoutes, [providerID]: noLogin.tracking } }
            }
            return status
          }).pipe(Effect.orDie),
          // A malformed question names no session: it has no account to name.
          session: (input) =>
            Option.match(decodeSessionQuery(input), { onNone: () => Effect.succeed({}), onSome: (query) => withPool((pool) => pool.session(query)) }),
          alerts: () => withPool((pool) => pool.alerts),
          // A malformed question names no session: it has no steps.
          logins: (input) => Option.match(decodeLoginsQuery(input), { onNone: () => Effect.succeed({ steps: [] }), onSome: (query) => withPool((pool) => pool.logins(query)) }),
          // A malformed question names no provider: nothing started.
          started: (input) =>
            Option.match(decodeStartedQuery(input), {
              onNone: () => Effect.succeed({}),
              onSome: ({ providerID }) => withPool((pool) => pool.started(providerID)).pipe(Effect.as({})),
            }),
          report: () => withPool((pool) => pool.report),
          fleet: () => withPool((pool) => pool.fleet),
          resets: () => withPool((pool) => pool.resets),
          // A malformed lease message is refused: no lease is lent on it.
          lease: (input) =>
            Option.match(decodeLease(input), {
              onNone: () => Effect.succeed({ granted: false, reason: "not a lease message" }),
              onSome: (message) => withPool((pool) => pool.lease(message)),
            }),
          limits: () => withPool((pool) => pool.limits),
          // A malformed push request changes nothing.
          push: (input) =>
            Option.match(decodePush(input), {
              onNone: () => Effect.succeed({ ok: false, text: "not a push request", pushes: [] }),
              onSome: (request) => withPool((pool) => pool.push(request)),
            }),
          antigravity: (input) => agy.rpc(Option.getOrUndefined(decodeAgyRpc(input))),
        })
        .pipe(Effect.orDie)
    }),
  })

const decodeSessionQuery = Schema.decodeUnknownOption(SessionQuery)
const decodeLoginsQuery = Schema.decodeUnknownOption(LoginsQuery)
const decodeStartedQuery = Schema.decodeUnknownOption(StartedQuery)
const decodeLease = Schema.decodeUnknownOption(LeaseMessage)
const decodePush = Schema.decodeUnknownOption(PushRequest)
const decodeAgyRpc = Schema.decodeUnknownOption(AgyWiring.RpcInput)

const providerOf = (input: unknown) =>
  typeof input === "object" && input !== null && "providerID" in input ? String(input.providerID) : ""

/** The model a pace question names, if it names one as a string. */
const modelOf = (input: unknown) =>
  typeof input === "object" && input !== null && "model" in input && typeof input.model === "string" ? input.model : undefined

/** Whether a pace question is a request's at its dispatch (a send outside the host's hooks, the cache's keepalive), not a start's. */
const dispatchOf = Schema.is(Schema.Struct({ dispatch: Schema.Literal(true) }))

/** The session a pace question comes from, if it names one: the one whose start waits when the pace holds it. */
const sessionOf = (input: unknown) =>
  typeof input === "object" && input !== null && "sessionID" in input && typeof input.sessionID === "string" && input.sessionID !== ""
    ? input.sessionID
    : undefined

export default make(live, LIVE_STORE_HOST, LedgerLive.processHoldAuthority().lock, liveAntigravity)
