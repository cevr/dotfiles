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
// - an assistant message names the `agent` that ran it (session-message.ts,
//   `Assistant.agent`); an agent (agent.ts, `Info`) carries
//   `request.settings.cacheTTL` when a plugin gave it its own cache lifetime
//   (the orchestration roles' "5m", cmd/orchestrate/server.ts), which the
//   auth plugin applies only over a lifetime the model's or provider's settings
//   name (`rewriteRequestBody` in mods/anthropic-auth/request-body.ts);
// - a completed `compaction` message rewrote the context; it carries its
//   summary request's `model` and `tokens` (`CompactionCompleted`) and when it
//   started (`time.created`);
// - a session (session.ts) carries `tokens`, every step's usage summed, and
//   `location`; a model (model.ts, `Info`) carries `cost` (USD per million
//   tokens, by context tier) and `settings.cache.ttl`, as a provider
//   (provider.ts) carries `settings.cache.ttl`.
import { Option, Schema } from "effect"
import type { Hits } from "../line.ts"
import type { ModelTerms } from "../ledger.ts"
import type { Compaction, Opener, Span, Step, Timeline } from "../miss.ts"
import type { Rate } from "../price.ts"
import { familyOf, lifetimeMs, parseTtl } from "../ttl.ts"

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
    readonly agent: { list(location?: Location): ReadonlyArray<unknown> | undefined }
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
  agent: Schema.optional(Schema.String),
  model: Schema.Struct({ providerID: Schema.String, id: Schema.String }),
  content: Schema.Array(Schema.Unknown),
  finish: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
  retry: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Tokens),
  time: Schema.Struct({ created: Schema.Number, streamed: Schema.optional(Schema.Number), completed: Schema.optional(Schema.Number) }),
})
const decodeAssistant = Schema.decodeUnknownOption(Assistant)

/** A completed compaction with its summary request's usage. */
const Compacted = Schema.Struct({
  type: Schema.Literal("compaction"),
  id: Schema.String,
  status: Schema.Literal("completed"),
  model: Schema.Struct({ providerID: Schema.String, id: Schema.String }),
  tokens: Tokens,
  time: Schema.Struct({ created: Schema.Number }),
})
const decodeCompacted = Schema.decodeUnknownOption(Compacted)

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

const promptOf = (tokens: typeof Tokens.Type) => ({
  promptTokens: tokens.input + tokens.cache.read + tokens.cache.write,
  cacheReadTokens: tokens.cache.read,
  cacheWriteTokens: tokens.cache.write,
})

/** A step as one message reads, before its place in the session gives it an opener and a login. */
export type StepReading = Omit<Step, "opener" | "login">

/**
 * What one message brings to the timeline, read from it alone: a step (an
 * assistant message), a compaction's summary request and the compaction, a
 * compaction without one, an idle marker, an input that may open a turn, or
 * nothing. A TUI keeps one per message (tui/ledger.tsx), so a change to one
 * message reads that message again and no other.
 */
export type Reading =
  | { readonly kind: "step"; readonly step: StepReading }
  | { readonly kind: "summary"; readonly step: Omit<StepReading, "agent"> }
  | { readonly kind: "compaction" }
  | { readonly kind: "idle"; readonly opener: Opener }
  | { readonly kind: "input"; readonly opener: Opener }
  | { readonly kind: "none" }

const NONE: Reading = { kind: "none" }
const COMPACTION: Reading = { kind: "compaction" }

/** One message's reading (`Reading`). */
export const reading = (value: unknown): Reading => {
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
    return {
      kind: "step",
      step: {
        type: "step",
        id: message.id,
        model: modelKey(message.model.providerID, message.model.id),
        startedAt: message.time.created,
        endedAt: message.time.streamed ?? message.time.completed ?? message.time.created,
        ...(tokens === undefined ? {} : { usage: promptOf(tokens) }),
        tools,
        closes: (message.finish !== undefined && !OPEN_FINISHES.has(message.finish)) || message.error !== undefined || message.retry !== undefined,
        ...(message.agent === undefined ? {} : { agent: message.agent }),
      },
    }
  }
  const compacted = decodeCompacted(value)
  if (Option.isSome(compacted)) {
    const { id, model, tokens, time } = compacted.value
    return {
      kind: "summary",
      step: {
        type: "step",
        id,
        model: modelKey(model.providerID, model.id),
        startedAt: time.created,
        endedAt: time.created,
        usage: promptOf(tokens),
        tools: [],
        closes: false,
        compaction: true,
      },
    }
  }
  const other = decodeOther(value)
  if (Option.isNone(other)) return NONE
  const { type, id, status, metadata } = other.value
  if (type === "idle") return { kind: "idle", opener: { id, kind: "other" } }
  if (type === "compaction") return status === "completed" ? COMPACTION : NONE
  if (INPUTS.has(type))
    return { kind: "input", opener: { id, kind: type === "user" ? "prompt" : type === "synthetic" && metadata?.source === "subagent" ? "subagent" : "other" } }
  return NONE
}

const START: Opener = { id: "start", kind: "other" }
const COMPACTED = { type: "compaction" } as const

/**
 * Each reading's step as last placed: a reading is never changed, so the
 * same reading with the same opener, login and agent is the same step, and a
 * timeline put together again allocates only the steps whose place changed.
 */
const placed = new WeakMap<object, { readonly opener: Opener; readonly login: string | undefined; readonly agent: string | undefined; readonly step: Step }>()
const place = (read: StepReading, opener: Opener, login: string | undefined, agent: string | undefined, make: () => Step): Step => {
  const last = placed.get(read)
  if (last !== undefined && last.opener === opener && last.login === login && last.agent === agent) return last.step
  const step = make()
  placed.set(read, { opener, login, agent, step })
  return step
}

/**
 * A session's steps and compactions, oldest first, from its messages'
 * readings in order. `logins` names the pool login each assistant message
 * went out on, by its id, as far as the pool recorded it. A compaction's
 * summary request runs as the agent of the step before it.
 */
export const assemble = (readings: Iterable<Reading>, logins: ReadonlyMap<string, string> = new Map()): Timeline => {
  let opener = START
  let opening = true
  let agent: string | undefined
  const entries: Array<Step | Compaction> = []
  for (const read of readings)
    switch (read.kind) {
      case "step": {
        const { step } = read
        const login = logins.get(step.id)
        agent = step.agent ?? agent
        entries.push(place(step, opener, login, undefined, () => ({ ...step, opener, ...(login === undefined ? {} : { login }) })))
        opening = false
        break
      }
      case "summary": {
        const { step } = read
        const by = agent
        entries.push(place(step, opener, undefined, by, () => ({ ...step, opener, ...(by === undefined ? {} : { agent: by }) })), COMPACTED)
        break
      }
      case "compaction":
        entries.push(COMPACTED)
        break
      case "idle":
        opening = true
        opener = read.opener
        break
      case "input":
        if (opening) {
          opening = false
          opener = read.opener
        }
        break
    }
  return entries
}

/** A session's steps and compactions, oldest first, from the messages the TUI holds (`assemble` of each one's `reading`). */
export const timeline = (messages: ReadonlyArray<unknown>, logins: ReadonlyMap<string, string> = new Map()): Timeline =>
  assemble(messages.map(reading), logins)

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
      const configured = [modelTtl, fromProvider].some((ttl) => ttl !== undefined && parseTtl(ttl) !== undefined)
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
        ...(configured ? { configured } : {}),
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

const AgentInfo = Schema.Struct({
  id: Schema.String,
  request: Schema.optional(Schema.Struct({ settings: Schema.optional(Schema.Struct({ cacheTTL: Schema.optional(Schema.Unknown) })) })),
})
const decodeAgent = Schema.decodeUnknownOption(AgentInfo)

/** Each agent's own cache lifetime (`request.settings.cacheTTL`), by its id; an agent that sets none is absent. */
export const agentTtls = (agents: ReadonlyArray<unknown>): ReadonlyMap<string, string> =>
  new Map(
    agents.flatMap((value) => {
      const agent = decodeAgent(value)
      const ttl = Option.isSome(agent) ? agent.value.request?.settings?.cacheTTL : undefined
      return Option.isSome(agent) && typeof ttl === "string" ? [[agent.value.id, ttl] as const] : []
    }),
  )

/** The agents' own cache lifetimes in the location a session runs in. */
export const sessionAgentTtls = <Location>(reads: Reads<Location>, sessionID: string): ReadonlyMap<string, string> =>
  agentTtls(reads.location.agent.list(reads.session.get(sessionID)?.location) ?? [])
