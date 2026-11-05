// What the cache mod reads from the TUI's own data: a session's steps as a
// timeline (its assistant messages, the turns its idle markers close, its
// compactions), its family, the family's token totals, and each model's cache
// terms from the location's model catalog. Read inside a Solid computation,
// every read here is reactive.
//
// The fork's shapes (packages/schema/src):
// - an assistant message (session-message.ts, `Assistant`) carries `model`
//   ({ providerID, id }), `tokens` (token-usage.ts: `input` is the uncached
//   input only, packages/core/src/session/usage.ts:13, so the prompt is
//   `input + cache.read + cache.write`), `time.created` (the request went
//   out), `time.streamed` (the response ended), `finish`, `error`, `retry`,
//   and its tool calls (`AssistantTool`: `name`, `time.ran` when the call
//   was issued, `time.completed` when it settled);
// - an `idle` message marks the session going idle: every step since the
//   previous marker belongs to one turn (session-message.ts, `Idle`);
// - a `synthetic` message whose `metadata.source` is `subagent` is a
//   background subagent's report;
// - a completed `compaction` message rewrote the context;
// - a session (session.ts) carries `tokens`, every step's usage summed, and
//   `location`; a model (model.ts, `Info`) carries `cost` (USD per million
//   tokens, by context tier) and `settings.cache.ttl`, as a provider
//   (provider.ts) carries `settings.cache.ttl`.
import { Option, Schema } from "effect"
import type { Hits } from "../line.ts"
import type { ModelTerms } from "../ledger.ts"
import type { Opener, Span, Step, Timeline } from "../miss.ts"
import type { Rate } from "../price.ts"
import { familyOf, lifetimeMs } from "../ttl.ts"

const Tokens = Schema.Struct({
  input: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})

/** A session as `context.data.session.get` returns it, narrowed to what the mod reads. */
export interface SessionInfo<Location> {
  readonly parentID?: string | null
  readonly location?: Location
  readonly tokens?: { readonly input: number; readonly cache: { readonly read: number; readonly write: number } }
}

/**
 * The reads the mod needs from the TUI plugin's `context.data`, narrowed so a
 * test can supply them; `context.data` satisfies it.
 */
export interface Reads<Location> {
  readonly session: {
    get(sessionID: string): SessionInfo<Location> | undefined
    family(sessionID: string): ReadonlyArray<string>
    readonly message: { list(sessionID: string): ReadonlyArray<unknown> }
  }
  readonly location: {
    readonly model: { list(location?: Location): ReadonlyArray<unknown> | undefined }
    readonly provider: { list(location?: Location): ReadonlyArray<unknown> | undefined }
  }
}

const Tool = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  time: Schema.Struct({ created: Schema.Number, ran: Schema.optional(Schema.Number), completed: Schema.optional(Schema.Number) }),
})
const decodeTool = Schema.decodeUnknownOption(Tool)

const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  id: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, id: Schema.String }),
  content: Schema.Array(Schema.Unknown),
  finish: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
  retry: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Tokens),
  time: Schema.Struct({ created: Schema.Number, streamed: Schema.optional(Schema.Number), completed: Schema.optional(Schema.Number) }),
})
const decodeAssistant = Schema.decodeUnknownOption(Assistant)

const Other = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  status: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Struct({ source: Schema.optional(Schema.Unknown) })),
})
const decodeOther = Schema.decodeUnknownOption(Other)

/** The messages that bring input to a turn; the first one after an idle marker opens the turn. */
const INPUTS = new Set(["user", "synthetic", "shell", "skill"])

/** The finishes after which the host closes a turn with its footer (packages/tui/src/routes/session/rows.ts:410). */
const OPEN_FINISHES = new Set(["tool-calls", "unknown"])

const modelKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

/** A session's steps and compactions, oldest first, from the messages the TUI holds. */
export const timeline = (messages: ReadonlyArray<unknown>): Timeline => {
  let opener: Opener = { id: "start", kind: "other" }
  let opening = true
  return messages.flatMap((value): Timeline => {
    const assistant = decodeAssistant(value)
    if (Option.isSome(assistant)) {
      const message = assistant.value
      const tools = message.content.flatMap((part): ReadonlyArray<Span> => {
        const tool = decodeTool(part)
        if (Option.isNone(tool) || tool.value.time.completed === undefined) return []
        const at = tool.value.time.ran ?? tool.value.time.created
        return [{ name: tool.value.name, at, ms: Math.max(0, tool.value.time.completed - at) }]
      })
      const tokens = message.tokens
      const step: Step = {
        type: "step",
        id: message.id,
        model: modelKey(message.model.providerID, message.model.id),
        startedAt: message.time.created,
        endedAt: message.time.streamed ?? message.time.completed ?? message.time.created,
        ...(tokens === undefined
          ? {}
          : {
              usage: {
                promptTokens: tokens.input + tokens.cache.read + tokens.cache.write,
                cacheReadTokens: tokens.cache.read,
                cacheWriteTokens: tokens.cache.write,
              },
            }),
        tools,
        opener,
        closes: (message.finish !== undefined && !OPEN_FINISHES.has(message.finish)) || message.error !== undefined || message.retry !== undefined,
      }
      opening = false
      return [step]
    }
    const other = decodeOther(value)
    if (Option.isNone(other)) return []
    const { type, id, status, metadata } = other.value
    if (type === "idle") {
      opening = true
      opener = { id, kind: "other" }
      return []
    }
    if (type === "compaction") return status === "completed" ? [{ type: "compaction" }] : []
    if (opening && INPUTS.has(type)) {
      opening = false
      opener = { id, kind: type === "user" ? "prompt" : type === "synthetic" && metadata?.source === "subagent" ? "subagent" : "other" }
    }
    return []
  })
}

/** `sessionID` and every session under it in its family. */
export const descendants = <Location>(reads: Reads<Location>, sessionID: string): ReadonlyArray<string> => {
  const family = reads.session.family(sessionID)
  const under = (id: string): boolean => {
    if (id === sessionID) return true
    const parent = reads.session.get(id)?.parentID
    return typeof parent === "string" && parent !== id && under(parent)
  }
  return [sessionID, ...family.filter((id) => id !== sessionID && under(id))]
}

/** Every step's prompt tokens of the sessions, and the part the cache served or stored. */
export const hits = <Location>(reads: Reads<Location>, ids: ReadonlyArray<string>): Hits =>
  ids.reduce<Hits>(
    (total, id) => {
      const tokens = reads.session.get(id)?.tokens
      if (tokens === undefined) return total
      return {
        promptTokens: total.promptTokens + tokens.input + tokens.cache.read + tokens.cache.write,
        cacheReadTokens: total.cacheReadTokens + tokens.cache.read,
        cacheWriteTokens: total.cacheWriteTokens + tokens.cache.write,
      }
    },
    { promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )

const Ttl = Schema.optional(Schema.Struct({ cache: Schema.optional(Schema.Struct({ ttl: Schema.optional(Schema.String) })) }))

const Model = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  settings: Ttl,
  cost: Schema.Array(
    Schema.Struct({
      tier: Schema.optional(Schema.Struct({ size: Schema.Number })),
      input: Schema.Number,
      cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
    }),
  ),
})
const decodeModel = Schema.decodeUnknownOption(Model)

const Provider = Schema.Struct({ id: Schema.String, settings: Ttl })
const decodeProvider = Schema.decodeUnknownOption(Provider)

/** Each model of the catalog's cache terms, by `providerID/modelID`. */
export const catalog = (models: ReadonlyArray<unknown>, providers: ReadonlyArray<unknown>): ReadonlyMap<string, ModelTerms> => {
  const providerTtl = new Map(
    providers.flatMap((value) => {
      const provider = decodeProvider(value)
      const ttl = Option.isSome(provider) ? provider.value.settings?.cache?.ttl : undefined
      return Option.isSome(provider) && ttl !== undefined ? [[provider.value.id, ttl] as const] : []
    }),
  )
  return new Map(
    models.flatMap((value) => {
      const decoded = decodeModel(value)
      if (Option.isNone(decoded)) return []
      const model = decoded.value
      const modelTtl = model.settings?.cache?.ttl
      const fromProvider = providerTtl.get(model.providerID)
      const lifetime = lifetimeMs({
        providerID: model.providerID,
        modelID: model.id,
        ...(modelTtl === undefined ? {} : { modelTtl }),
        ...(fromProvider === undefined ? {} : { providerTtl: fromProvider }),
      })
      const family = familyOf(model.providerID, model.id)
      const rates = model.cost.map(
        (cost): Rate => ({
          ...(cost.tier === undefined ? {} : { tier: cost.tier.size }),
          input: cost.input,
          cacheRead: cost.cache.read,
          cacheWrite: cost.cache.write,
        }),
      )
      const terms: ModelTerms = {
        ...(family === undefined ? {} : { family }),
        ...(lifetime === undefined ? {} : { lifetimeMs: lifetime }),
        rates,
      }
      return [[modelKey(model.providerID, model.id), terms] as const]
    }),
  )
}

/** The catalog of the location a session runs in. */
export const sessionCatalog = <Location>(reads: Reads<Location>, sessionID: string): ReadonlyMap<string, ModelTerms> => {
  const location = reads.session.get(sessionID)?.location
  return catalog(reads.location.model.list(location) ?? [], reads.location.provider.list(location) ?? [])
}
