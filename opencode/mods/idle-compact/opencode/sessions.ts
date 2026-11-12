// Sessions as OpenCode's data holds them. `layer` reads the facts from plain
// views of the host's records, so the laws run it over a stand-in host;
// `fromContext` takes the views from the plugin context.
//
// Where each fact comes from, in the fork (packages/schema/src):
// - running: `Session.Info.time.busy` is the start of the latest execution,
//   `time.idle` the end of the last completed one (session.ts:44-50); it runs
//   while busy is later than idle.
// - child: `Session.Info.parentID` (session.ts:34).
// - busy: the session's newest children (`session.list({ parentID })`, a
//   page of `CHILDREN`) that run, for the log.
// - catalog: the location's model, provider and agent lists (`model.list`,
//   `provider.list`, `agent.list`), the fields the reads below take of them,
//   as one key that tells a real catalog change from the host publishing an
//   unchanged one again.
// - last: the newest assistant message with usage after the last compaction
//   (`Session.Message.Assistant`, session-message.ts:222-246): `tokens.input +
//   tokens.cache.read + tokens.cache.write` is the prompt, `time.created` the
//   step's start (the plugin replaces it with the request's exact start when
//   it saw it), `model` the model it ran on.
// - compacted: a compaction message (session-message.ts:248-289), of any
//   status, after that assistant message, or with none after it.
// - onSummary: that assistant message is the only one after the last
//   compaction. The context starts at the latest completed compaction, of any
//   reason (`session.context`, packages/core/src/session/store.ts:194, history
//   "latest"), and the summary request records no assistant message of its own
//   (its usage is the compaction message's `tokens`).
// - ttl and window: the model's catalog entry (`model.list`, schema
//   model.ts:114-140) and its provider's (`provider.get`): `limit`, and
//   `settings.cache.ttl`, the model's over the provider's as the fork merges
//   them for the request (`Provider.mergeOverlay`, packages/core/src/
//   model-resolver.ts:462,487). Then the agent the request ran under
//   (`Session.Message.Assistant.agent`, session-message.ts:224; `agent.get`):
//   its `request.settings.cacheTTL` replaces that lifetime, only when one is
//   configured (the anthropic-auth `http.request` hook writes it over the
//   provider-configured lifetime: `rewriteRequestBody`'s `own` lifetime in
//   mods/anthropic-auth/request-body.ts). When the catalog, the provider or the agent cannot
//   be read, or the catalog no longer has the model, the lifetime is
//   unresolved (`LastRequest.unresolved`) and none is guessed.
// - price: the model's catalog entry's `cost` (schema model.ts:92-104,130),
//   USD per million tokens, an entry per context tier.
//
// Whose session it is: the fork runs one copy of the plugin per location
// (`ctx.location`: directory and workspace), and hands a session's hooks only
// to the copy of its own location: the session's services are its location's
// (`locations.get(session.location)`, packages/core/src/effect/
// app-node-builder.ts:15, the ref made canonical in location-services.ts:73),
// hooks among them (`PluginHooks.node` is a location node, plugin/hooks.ts).
// Its events reach every copy. So a copy serves the sessions whose
// `location` is its own, compared as the fork compares them: the directory
// normalized, with no trailing separator, and the same workspace.
import { posix } from "node:path"
import { Agent, type Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { parseTTL, ttlOf } from "../cache.ts"
import type { Facts, LastRequest } from "../idle.ts"
import type { Rate } from "../price.ts"
import { CatalogUnreadable, CompactionRefused, Sessions, SessionUnreadable } from "../service.ts"

/** Where a session runs, or which sessions a copy of the plugin serves: a directory, within a workspace or not. */
export interface Place {
  readonly directory: string
  readonly workspaceID?: string | undefined
}

/** A directory as the fork keys a location by it: normalized, without a trailing separator. */
const canonical = (directory: string) => {
  const normalized = posix.normalize(directory)
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

/** Whether two places are one location. */
export const samePlace = (a: Place, b: Place): boolean =>
  canonical(a.directory) === canonical(b.directory) && (a.workspaceID ?? undefined) === (b.workspaceID ?? undefined)

/** A session, as idle compaction reads it. Times in epoch ms. */
export interface SessionView extends Place {
  readonly id: string
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly busy?: number | undefined
  readonly idle?: number | undefined
}

/** Token usage as the fork records it. */
export interface Usage {
  readonly input: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** A message of the session's context, as idle compaction reads it. */
export type MessageView =
  | {
      readonly type: "assistant"
      readonly created: number
      readonly tokens?: Usage | undefined
      readonly model: { readonly providerID: string; readonly id: string }
      /** The agent the request ran under. */
      readonly agent: string
    }
  | { readonly type: "compaction" }
  | { readonly type: "other" }

/** A model's catalog entry, as idle compaction reads it. */
export interface ModelView {
  readonly providerID: string
  readonly canonical?: string | undefined
  readonly modelID: string
  /** The model's `cache.ttl`, else its provider's: the lifetime the fork configures for its requests. */
  readonly ttl?: string | undefined
  /** The model's input window in tokens; 0 when unknown. */
  readonly window: number
  /** The model's catalog prices; none or empty when it lists none. */
  readonly rates?: ReadonlyArray<Rate> | undefined
}

/** The host's reads and its compaction, as one copy of the plugin sees them. */
export interface Host {
  /** The location this copy of the plugin runs for. */
  readonly location: Place
  readonly session: (sessionID: string) => Effect.Effect<SessionView, unknown>
  /** The session's whole context: the costly read. */
  readonly messages: (sessionID: string) => Effect.Effect<ReadonlyArray<MessageView>, unknown>
  /** The session's newest children, at most `limit` of them: they are read only to log the ones that run. */
  readonly children: (sessionID: string, limit: number) => Effect.Effect<ReadonlyArray<SessionView>, unknown>
  /**
   * The model the session's request ran on; undefined when the catalog no longer has it. It fails when the catalog
   * or the model's provider cannot be read.
   */
  readonly model: (
    ref: { readonly providerID: string; readonly id: string },
    directory: string,
  ) => Effect.Effect<ModelView | undefined, unknown>
  /** The agent's own cache lifetime (`request.settings.cacheTTL`), undefined when it sets none; fails when the agent cannot be read. */
  readonly agentTTL: (agentID: string, directory: string) => Effect.Effect<string | undefined, unknown>
  /**
   * What this location's catalog says of every model, provider and agent that a decision reads (lifetimes, windows,
   * prices), as plain data: equal data decides alike.
   */
  readonly catalog: Effect.Effect<unknown, unknown>
  /** The recent main sessions, newest first; those of other locations may be among them. */
  readonly roots: Effect.Effect<ReadonlyArray<SessionView>, unknown>
  readonly compact: (sessionID: string) => Effect.Effect<void, unknown>
}

export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

/** Whether it is a subagent's session. */
const isChild = (session: SessionView): boolean => Option.isSome(Option.fromUndefinedOr(session.parentID))

/** The catalog's data as its key: its JSON. */
const encodeKey = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** Whether an execution of the session runs. */
export const running = (session: SessionView): boolean =>
  session.busy !== undefined && (session.idle === undefined || session.busy > session.idle)

/**
 * The newest assistant message with usage, whether a compaction came after it,
 * and whether it is the only one after the last compaction.
 */
export const lastRequest = (messages: ReadonlyArray<MessageView>) => {
  const used = (message: MessageView) => message.type === "assistant" && message.tokens !== undefined
  const boundary = messages.findLastIndex((message) => message.type === "compaction")
  const since = messages.slice(boundary + 1).filter(used).length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === "assistant" && message.tokens !== undefined)
      return { message: Option.some({ ...message, tokens: message.tokens }), compacted: index < boundary, onSummary: boundary >= 0 && since === 1 }
  }
  return { message: Option.none(), compacted: boundary >= 0, onSummary: false }
}

type AssistantView = Extract<MessageView, { readonly type: "assistant" }>

/**
 * The model a request ran on and the `cache.ttl` it was sent with, as the host and the auth plugin resolve it: the
 * model's or its provider's setting, replaced by the agent's own lifetime when there is one to replace
 * (`rewriteRequestBody` in mods/anthropic-auth/request-body.ts). `unresolved` says why it is unknown when a read failed or the
 * catalog lost the model.
 */
const requested = Effect.fn("Sessions.requested")(function* (host: Host, message: AssistantView, directory: string) {
  const read = yield* Effect.result(host.model(message.model, directory))
  if (read._tag === "Failure") return { model: undefined, unresolved: `the catalog cannot be read: ${messageOf(read.failure)}` }
  const model = read.success
  if (model === undefined)
    return { model, unresolved: `the catalog has no ${message.model.providerID}/${message.model.id}` }
  // The fork lets an agent's lifetime replace only one the model or provider configures.
  if (model.ttl === undefined) return { model, configured: undefined }
  const agent = yield* Effect.result(host.agentTTL(message.agent, directory))
  if (agent._tag === "Failure")
    return { model, unresolved: `the agent ${message.agent} cannot be read: ${messageOf(agent.failure)}` }
  const own = agent.success
  return { model, configured: own !== undefined && Option.isSome(parseTTL(own)) ? own : model.ttl }
})

/**
 * How many of a session's newest children it reads, to log those that run: an orchestrator has hundreds, and the
 * ones that run are among its newest.
 */
export const CHILDREN = 20

export const layer = (host: Host) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      standing: (sessionID) =>
        host.session(sessionID).pipe(
          Effect.map((session) => ({
            serves: samePlace(session, host.location),
            child: isChild(session),
            running: running(session),
          })),
          Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })),
        ),
      facts: Effect.fn("Sessions.facts")(function* (sessionID: string) {
        const unreadable = (cause: unknown) => new SessionUnreadable({ sessionID, message: messageOf(cause) })
        const [session, messages, children] = yield* Effect.all(
          [host.session(sessionID), host.messages(sessionID), host.children(sessionID, CHILDREN)],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(unreadable))
        const found = lastRequest(messages)
        const last: Option.Option<LastRequest> = yield* Option.match(found.message, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (message) =>
            requested(host, message, session.directory).pipe(
              Effect.map(({ model, configured, unresolved }) => {
                const { input, cache } = message.tokens
                const rates = model?.rates ?? []
                return Option.some({
                  startedAt: message.created,
                  prompt: input + cache.read + cache.write,
                  cached: cache.read + cache.write > 0,
                  ttl:
                    unresolved === undefined
                      ? ttlOf({
                          providerID: message.model.providerID,
                          modelID: model?.modelID ?? message.model.id,
                          canonical: model?.canonical,
                          configured,
                        })
                      : Option.none(),
                  ...(unresolved === undefined ? {} : { unresolved }),
                  window: model === undefined || model.window <= 0 ? Option.none() : Option.some(model.window),
                  ...(rates.length === 0
                    ? {}
                    : { price: { rates, anthropic: (model?.canonical ?? message.model.providerID) === "anthropic" } }),
                })
              }),
            ),
        })
        return {
          child: isChild(session),
          running: running(session),
          busy: children.filter(running).map((child) => `subagent ${child.title ?? child.id}`),
          last,
          compacted: found.compacted,
          onSummary: found.onSummary,
        } satisfies Facts
      }),
      compact: (sessionID) =>
        host.compact(sessionID).pipe(Effect.mapError((cause) => new CompactionRefused({ sessionID, message: messageOf(cause) }))),
      recent: host.roots.pipe(
        Effect.map((sessions) => sessions.filter((session) => samePlace(session, host.location)).map((session) => session.id)),
        Effect.mapError((cause) => new SessionUnreadable({ sessionID: "*", message: messageOf(cause) })),
      ),
      catalog: host.catalog.pipe(
        Effect.flatMap(encodeKey),
        Effect.mapError((cause) => new CatalogUnreadable({ message: messageOf(cause) })),
      ),
    }),
  )

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type ProviderID = Parameters<Plugin.Context["provider"]["get"]>[0]["providerID"]
type AgentID = Parameters<Plugin.Context["agent"]["get"]>[0]["agentID"]

/** A session's record, as the plugin reads it (`Session.Info`). */
export interface SessionRecord {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly location: Place
  readonly time: { readonly busy?: DateTime.Utc; readonly idle?: DateTime.Utc }
}

/** A cache setting as the catalog holds it (`Provider.Settings`), the lifetime alone. */
interface CacheSettings {
  readonly cache?: { readonly ttl?: string }
}

/** A model's catalog entry, as the plugin reads it (`Model.Info`). */
export interface CatalogModel {
  readonly providerID: string
  readonly id: string
  readonly modelID: string
  readonly canonical?: string
  readonly settings?: CacheSettings
  readonly limit: { readonly context: number; readonly input?: number }
  readonly cost: ReadonlyArray<{
    readonly tier?: { readonly size: number }
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }>
}

/** A provider's catalog entry, as the plugin reads it (`Provider.Info`). */
export interface CatalogProvider {
  readonly id: string
  readonly settings?: CacheSettings
}

/** An agent, as the plugin reads it (`Agent.Info`): its request settings may name its own lifetime. */
export interface CatalogAgent {
  readonly id: string
  readonly request: { readonly settings?: CacheSettings & { readonly cacheTTL?: unknown } }
}

/** Which location a catalog read is for. */
interface At {
  readonly location: { readonly directory: string }
}

/**
 * The plugin context, as far as the plugin reads it: `Plugin.Context` is one. Narrow, so a test can stand in for
 * the reads it checks and nothing else.
 */
export interface Reads {
  readonly location: Pick<Plugin.Context["location"], "directory" | "workspaceID">
  readonly session: Pick<Plugin.Context["session"], "get" | "context" | "compact"> & {
    readonly list: (
      input: Parameters<Plugin.Context["session"]["list"]>[0],
    ) => Effect.Effect<{ readonly data: ReadonlyArray<SessionRecord> }, unknown>
  }
  readonly model: { readonly list: (input: At) => Effect.Effect<{ readonly data: ReadonlyArray<CatalogModel> }, unknown> }
  readonly provider: {
    readonly list: (input: At) => Effect.Effect<{ readonly data: ReadonlyArray<CatalogProvider> }, unknown>
    readonly get: (input: At & { readonly providerID: ProviderID }) => Effect.Effect<{ readonly data: CatalogProvider }, unknown>
  }
  readonly agent: {
    readonly list: (input: At) => Effect.Effect<{ readonly data: ReadonlyArray<CatalogAgent> }, unknown>
    readonly get: (input: At & { readonly agentID: AgentID }) => Effect.Effect<{ readonly data: CatalogAgent }, unknown>
  }
}

/**
 * A model as the decisions read it, from its catalog entry and its provider's: the one projection both the reads
 * and the catalog's key take, so the key holds every field a decision reads.
 */
export const modelViewOf = (model: CatalogModel, provider?: CatalogProvider): ModelView => {
  const { context, input } = model.limit
  return {
    providerID: model.providerID,
    canonical: model.canonical,
    modelID: model.modelID,
    ttl: model.settings?.cache?.ttl ?? provider?.settings?.cache?.ttl,
    // As the fork's compaction reads it: the input limit within the context window.
    window: input && context ? Math.min(input, context) : input || context,
    rates: model.cost.map(
      (cost): Rate => ({
        tier: cost.tier?.size,
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache.read,
        cacheWrite: cost.cache.write,
      }),
    ),
  }
}

/** The agent's own cache lifetime (`request.settings.cacheTTL`), when it sets one as text. */
export const agentTTLOf = (agent: CatalogAgent) => {
  const ttl = agent.request.settings?.cacheTTL
  return typeof ttl === "string" ? ttl : undefined
}

/**
 * What the decisions read of a location's catalog: every model's view under its reference, and every agent's own
 * lifetime. Equal for two catalogs exactly when every read of a model or an agent answers alike.
 */
export const catalogOf = (catalog: {
  readonly models: ReadonlyArray<CatalogModel>
  readonly providers: ReadonlyArray<CatalogProvider>
  readonly agents: ReadonlyArray<CatalogAgent>
}) => ({
  models: catalog.models.map((model) => [
    model.providerID,
    model.id,
    modelViewOf(
      model,
      catalog.providers.find((provider) => provider.id === model.providerID),
    ),
  ]),
  agents: catalog.agents.map((agent) => [agent.id, agentTTLOf(agent)]),
})

const millis = (time: DateTime.Utc | undefined) => (time === undefined ? undefined : DateTime.toEpochMillis(time))

const sessionView = (session: SessionRecord): SessionView => ({
  id: session.id,
  parentID: session.parentID,
  title: session.title,
  directory: session.location.directory,
  workspaceID: session.location.workspaceID,
  busy: millis(session.time.busy),
  idle: millis(session.time.idle),
})

/**
 * The host's `session.compact` with the fork's `reason`, which the compaction
 * message records (packages/schema/src/session-inbox.ts CompactionPayload).
 * Idle compaction asks for `auto`: the plugin compacts on its own, not at the
 * user's word. A host without `reason` ignores the key and records `manual`;
 * the plugin context is taken as this shape so it compiles against either.
 */
interface CompactHost {
  compact(input: { readonly sessionID: SessionID; readonly reason?: "auto" | "manual" }): ReturnType<Plugin.Context["session"]["compact"]>
}

/** How many recent main sessions of its directory the plugin looks at when it starts. */
const RECENT = 50

/** The host's reads and compaction through the plugin context. */
export const hostOf = (ctx: Reads): Host => {
  const location = { directory: ctx.location.directory }
  return {
    location: { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID },
    session: (sessionID) => ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map(sessionView)),
    messages: (sessionID) =>
      ctx.session.context({ sessionID: sessionID as SessionID }).pipe(
        Effect.map((messages) =>
          messages.map((message): MessageView => {
            if (message.type === "compaction") return { type: "compaction" }
            if (message.type !== "assistant") return { type: "other" }
            return {
              type: "assistant",
              created: DateTime.toEpochMillis(message.time.created),
              tokens: message.tokens,
              model: { providerID: message.model.providerID, id: message.model.id },
              agent: message.agent,
            }
          }),
        ),
      ),
    children: (sessionID, limit) =>
      ctx.session
        .list({ parentID: sessionID as SessionID, order: "desc", limit })
        .pipe(Effect.map((page) => page.data.map(sessionView))),
    model: (ref, directory) =>
      Effect.gen(function* () {
        const models = yield* ctx.model.list({ location: { directory } })
        const model = models.data.find((item) => item.providerID === ref.providerID && item.id === ref.id)
        if (model === undefined) return undefined
        // A provider that cannot be read fails the read: its lifetime may be the one the request was sent with.
        const provider = yield* ctx.provider.get({ providerID: ref.providerID as ProviderID, location: { directory } })
        return modelViewOf(model, provider.data)
      }),
    agentTTL: (agentID, directory) =>
      ctx.agent.get({ agentID: Agent.ID.make(agentID), location: { directory } }).pipe(Effect.map((agent) => agentTTLOf(agent.data))),
    // What `model` and `agentTTL` read, for every entry, through the same projections.
    catalog: Effect.all(
      { models: ctx.model.list({ location }), providers: ctx.provider.list({ location }), agents: ctx.agent.list({ location }) },
      { concurrency: "unbounded" },
    ).pipe(Effect.map(({ models, providers, agents }) => catalogOf({ models: models.data, providers: providers.data, agents: agents.data }))),
    roots: ctx.session.list({ parentID: null, directory: ctx.location.directory, order: "desc", limit: RECENT }).pipe(Effect.map((page) => page.data.map(sessionView))),
    compact: (sessionID) => {
      const host: CompactHost = ctx.session
      return host.compact({ sessionID: sessionID as SessionID, reason: "auto" })
    },
  }
}

/** The OpenCode Sessions through the plugin context. */
export const fromContext = (ctx: Reads) => layer(hostOf(ctx))
