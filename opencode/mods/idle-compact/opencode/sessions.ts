// Sessions as OpenCode's data holds them. `layer` reads the facts from plain
// views of the host's records, so the laws run it over a stand-in host;
// `fromContext` takes the views from the plugin context.
//
// Where each fact comes from, in the fork (packages/schema/src):
// - running: `Session.Info.time.busy` is the start of the latest execution,
//   `time.idle` the end of the last completed one (session.ts:44-50); it runs
//   while busy is later than idle.
// - child: `Session.Info.parentID` (session.ts:34).
// - busy: the session's children (`session.list({ parentID })`) that run,
//   for the log.
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
//   configured (packages/core/src/session/agent-cache.ts:17-20, applied at
//   session/context.ts:170). When the catalog, the provider or the agent cannot
//   be read, or the catalog no longer has the model, the lifetime is
//   unresolved (`LastRequest.unresolved`) and none is guessed.
// - price: the model's catalog entry's `cost` (schema model.ts:92-104,130),
//   USD per million tokens, an entry per context tier.
import { Agent, type Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Layer, Option } from "effect"
import { parseTTL, ttlOf } from "../cache.ts"
import type { Facts, LastRequest } from "../idle.ts"
import type { Rate } from "../price.ts"
import { CompactionRefused, Sessions, SessionUnreadable } from "../service.ts"

/** A session, as idle compaction reads it. Times in epoch ms. */
export interface SessionView {
  readonly id: string
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly directory: string
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

/** The host's reads and its compaction. */
export interface Host {
  readonly session: (sessionID: string) => Effect.Effect<SessionView, unknown>
  readonly messages: (sessionID: string) => Effect.Effect<ReadonlyArray<MessageView>, unknown>
  readonly children: (sessionID: string) => Effect.Effect<ReadonlyArray<SessionView>, unknown>
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
  readonly roots: Effect.Effect<ReadonlyArray<SessionView>, unknown>
  readonly compact: (sessionID: string) => Effect.Effect<void, unknown>
}

export const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

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
 * The model a request ran on and the `cache.ttl` it was sent with, as the fork resolves it: the model's or its
 * provider's setting, replaced by the agent's own lifetime when there is one to replace
 * (packages/core/src/session/agent-cache.ts:17-20). `unresolved` says why it is unknown when a read failed or the
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

export const layer = (host: Host) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      facts: Effect.fn("Sessions.facts")(function* (sessionID: string) {
        const unreadable = (cause: unknown) => new SessionUnreadable({ sessionID, message: messageOf(cause) })
        const [session, messages, children] = yield* Effect.all(
          [host.session(sessionID), host.messages(sessionID), host.children(sessionID)],
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
          child: session.parentID !== undefined,
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
        Effect.map((sessions) => sessions.map((session) => session.id)),
        Effect.mapError((cause) => new SessionUnreadable({ sessionID: "*", message: messageOf(cause) })),
      ),
    }),
  )

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SessionInfo = Effect.Success<ReturnType<Plugin.Context["session"]["get"]>>
type ProviderID = Parameters<Plugin.Context["provider"]["get"]>[0]["providerID"]

const millis = (time: DateTime.Utc | undefined) => (time === undefined ? undefined : DateTime.toEpochMillis(time))

const sessionView = (session: SessionInfo): SessionView => ({
  id: session.id,
  parentID: session.parentID,
  title: session.title,
  directory: session.location.directory,
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

/** How many recent main sessions the plugin looks at when it starts. */
const RECENT = 50

/** The host's reads and compaction through the plugin context. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
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
    children: (sessionID) =>
      ctx.session.list({ parentID: sessionID as SessionID }).pipe(Effect.map((page) => page.data.map(sessionView))),
    model: (ref, directory) =>
      Effect.gen(function* () {
        const models = yield* ctx.model.list({ location: { directory } })
        const model = models.data.find((item) => item.providerID === ref.providerID && item.id === ref.id)
        if (model === undefined) return undefined
        // A provider that cannot be read fails the read: its lifetime may be the one the request was sent with.
        const provider = yield* ctx.provider.get({ providerID: ref.providerID as ProviderID, location: { directory } })
        const { context, input } = model.limit
        return {
          providerID: model.providerID,
          canonical: model.canonical,
          modelID: model.modelID,
          ttl: model.settings?.cache?.ttl ?? provider.data.settings?.cache?.ttl,
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
      }),
    agentTTL: (agentID, directory) =>
      ctx.agent.get({ agentID: Agent.ID.make(agentID), location: { directory } }).pipe(
        Effect.map((agent) => {
          const ttl = agent.data.request.settings?.["cacheTTL"]
          return typeof ttl === "string" ? ttl : undefined
        }),
      ),
    roots: ctx.session.list({ parentID: null, order: "desc", limit: RECENT }).pipe(Effect.map((page) => page.data.map(sessionView))),
    compact: (sessionID) => {
      const host: CompactHost = ctx.session
      return host.compact({ sessionID: sessionID as SessionID, reason: "auto" })
    },
  })
