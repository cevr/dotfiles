// The simulated host's state and its rules: sessions and their inbox, the
// executions that run them, the model, the shell, background compaction, the
// event bus, the hooks, the tool registry, RPC and storage. sim/context.ts
// gives a plugin its context onto it; sim/world.ts drives it.
//
// Each rule comes from the fork's source and is held to real OpenCode by a law
// in host-laws.ts:
// - Sessions and their inbox (packages/core/src/session/inbox.ts,
//   session.ts). Every admission publishes `session.inbox.enqueued`, and the
//   first admission of an id wins. A prompt, a synthetic message with
//   `resume`, or a compaction wakes an idle session. A synthetic message
//   without `resume` waits for the next execution. A running execution takes
//   the pending messages at its next step and publishes
//   `session.inbox.delivered` for each one.
// - An execution publishes `session.execution.started`, makes one model
//   request per step (the `model.request` hook, of the session's location's
//   copies only, in the order they registered), runs a step's tool call and
//   steps again, runs `experimental.idle` with the background shells still
//   running, then publishes `session.execution.succeeded`. `time.busy` is
//   its start and `time.idle` its end.
// - A compaction is an inbox item, one pending per session. It runs as an
//   execution of its own: a `compaction` request (or the summary the host
//   held from a background compaction, with no request), then a completed
//   compaction message. The context starts at the newest completed one.
// - A tool call runs the host's input repair first (packages/core/src/plugin/
//   tool-input-repair.ts: `bash` runs as `shell` when no `bash` tool is
//   offered, its answer then naming `shell`; an input sent as a JSON string of
//   an object is parsed), then the registry's `execute.before` hooks of the
//   session's location's copies in the order they registered, each on the
//   call as the one before left it (packages/core/src/tool.ts); a failure
//   refuses the call and is what the model reads.
// - The shell runs its `create.before` hooks on each command it spawns, each
//   seeing the program the one before left (packages/core/src/shell.ts
//   `create`); the command runs as they leave it, with that program.
// - A background shell's end steers a notice into its session, which wakes it.
// - Plugin storage is the host's, per plugin id, and outlives a restart.
// - Events reach every copy, hooks only the session's location's.
import { Tool } from "@opencode/schema/tool"
import type { SimulationProtocol } from "@opencode/simulation/protocol"
import { Agent } from "@opencode/schema/agent"
import type { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Array as Arr, type Cause, Data, DateTime, Effect, Exit, type Fiber, Option, Predicate, Queue, Result, Schema } from "effect"
import * as Http from "./http.ts"
import { below, type JsonObject, line, plain, record as recordOf, type Runtime, type SimError } from "./runtime.ts"

// ── The model ──

/** A reply's items, in the simulated provider's own wire form (`@opencode/simulation`'s `Backend.Item`). */
export type Item = SimulationProtocol.Backend.Item

/** What a reply reports it used: the prompt's tokens, those read from the cache and those written to it. */
export interface Usage {
  readonly input: number
  readonly read: number
  readonly write: number
}

/** The model's answer to one request: text, or one tool call, and its usage. */
export interface Reply {
  readonly items: ReadonlyArray<Item>
  readonly usage?: Usage
}

export type Kind = "primary" | "compaction" | "title"

/** One model request, as the script reads it. */
export interface Request {
  readonly sessionID: string
  readonly kind: Kind
  readonly agent: string
  /** The conversation the request carries, as text: each message in order. */
  readonly text: string
  /** The tool names the request offers. */
  readonly tools: ReadonlyArray<string>
}

export type Script = (request: Request) => Reply

/** An HTTP request, as the fetch API has it (this module's `Request` is a model request). */
type WebRequest = globalThis.Request

/** A request as the world kept it: when it started, ms since the world's start. */
export interface Asked {
  readonly at: number
  readonly sessionID: string
  readonly kind: Kind
  readonly text: string
}

/** The usage a reply reports when it names none: 100 prompt tokens, 400 read from the cache, 500 written. */
export const USAGE: Usage = { input: 100, read: 400, write: 500 }

export const say = (text: string, usage: Usage = USAGE): Reply => ({ items: [{ type: "textDelta", text }], usage })
export const call = (id: string, name: string, input: Schema.Json, usage: Usage = USAGE): Reply => ({
  items: [{ type: "toolCall", index: 0, id, name, input }],
  usage,
})

// ── Sessions ──

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: Schema.Json
}

export type Message =
  | { readonly type: "user"; readonly id: string; readonly created: number; readonly text: string }
  | {
      readonly type: "synthetic"
      readonly id: string
      readonly created: number
      readonly text: string
      readonly description: string
      readonly metadata: JsonObject
    }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly created: number
      readonly text: string
      readonly call: Option.Option<ToolCall>
      readonly tokens: { readonly input: number; readonly cache: { readonly read: number; readonly write: number } }
      readonly model: { readonly providerID: string; readonly id: string }
      readonly agent: string
    }
  | {
      readonly type: "tool"
      readonly id: string
      readonly created: number
      readonly callID: string
      readonly name: string
      readonly output: string
      readonly error: boolean
    }
  | {
      readonly type: "compaction"
      readonly id: string
      readonly created: number
      readonly status: "completed"
      readonly summary: string
      readonly reason: Reason
    }
  | {
      /** A step that failed and was not retried: the error the transcript shows. */
      readonly type: "error"
      readonly id: string
      readonly created: number
      readonly tag: string
      readonly message: string
    }

export type Reason = "auto" | "manual"

export type InboxItem =
  | { readonly id: string; readonly type: "prompt"; readonly text: string; readonly resume: true }
  | {
      readonly id: string
      readonly type: "synthetic"
      readonly text: string
      readonly description: string
      readonly metadata: JsonObject
      readonly resume: boolean
    }
  | { readonly id: string; readonly type: "compaction"; readonly reason: Option.Option<Reason>; readonly resume: true }

export interface Shell {
  readonly id: string
  readonly command: string
}

export interface Session {
  readonly id: string
  readonly parentID: Option.Option<string>
  /** None until the first execution asks for one; then the title request's answer. */
  title: Option.Option<string>
  readonly directory: string
  metadata: JsonObject
  busy: Option.Option<number>
  idle: Option.Option<number>
  /**
   * The last update, as the fork's projector bumps `time_updated` (packages/core/src/session/projector.ts):
   * at creation, an inbox admission, a step's start and end, a rename and a metadata update; never for an
   * execution's start or end or a compaction. `session.list` orders by it.
   */
  updated: number
  readonly messages: Array<Message>
  readonly inbox: Array<InboxItem>
  /** Every inbox id ever admitted: the first admission of an id wins. */
  readonly admitted: Set<string>
  running: boolean
  /** A summary a background compaction holds for the next compaction. */
  held: Option.Option<string>
  readonly shells: Array<Shell>
}

/** What a command run in the world's shell prints, by its text and the virtual time. */
export interface Process {
  readonly exitCode: number
  readonly stdout: string
  /** How long it runs, ms of virtual time. */
  readonly ms: number
}

/** `sleep N` sleeps N seconds; `true` and `echo` are themselves; anything else is not found. */
export const PROCESSES = (command: string): Process => {
  const sleep = /^sleep (\d+(?:\.\d+)?)$/.exec(command.trim())
  if (sleep) return { exitCode: 0, stdout: "", ms: Number(sleep[1]) * 1_000 }
  if (command.trim() === "true") return { exitCode: 0, stdout: "", ms: 10 }
  const echo = /^echo (.*)$/.exec(command.trim())
  if (echo) return { exitCode: 0, stdout: `${echo[1]}\n`, ms: 10 }
  return { exitCode: 127, stdout: `sh: ${command}: not found\n`, ms: 10 }
}

// ── The catalog ──

export interface CatalogModel {
  readonly providerID: string
  readonly id: string
  readonly modelID: string
  readonly limit: { readonly context: number; readonly input?: number }
  readonly cost: ReadonlyArray<{ readonly input: number; readonly output: number; readonly cache: { readonly read: number; readonly write: number } }>
  readonly settings?: { readonly cache?: { readonly ttl?: string } }
}

export const SIM_MODEL: CatalogModel = { providerID: "sim", id: "sim-model", modelID: "sim-model", limit: { context: 128_000 }, cost: [] }

// ── Failures, as the fork tags them ──

export class SessionNotFound extends Data.TaggedError("Session.NotFoundError")<{ readonly sessionID: string; readonly message: string }> {}
export class CatalogNotFound extends Data.TaggedError("NotFoundError")<{ readonly message: string }> {}
export class RpcNotFound extends Data.TaggedError("RpcNotFoundError")<{ readonly message: string }> {}

/** An HTTP hook that died, as the request carries it out of the hooks: its message, as an error's or the value's own. */
class HookDied extends Data.TaggedError("HookDied")<{ readonly name: string; readonly message: string }> {}

// ── The host's registrations ──

export interface HostEvent {
  readonly type: string
  readonly data: JsonObject
}

export interface Subscriber {
  readonly types: Option.Option<ReadonlySet<string>>
  readonly queue: Queue.Queue<HostEvent>
}

export interface ModelRequestInput {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly kind: Kind
  readonly headers: { readonly [key: string]: string }
}

export interface IdleInput {
  readonly sessionID: string
  readonly background: ReadonlyArray<{ readonly kind: "shell"; readonly sessionID: string; readonly shellID: string; readonly command: string }>
}

export interface HttpRequestInput {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly kind: Kind
  request: WebRequest
}

export interface HttpResponseInput {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly kind: Kind
  readonly request: WebRequest
  response: Response
}

export type RetryDecision = { readonly retry: false } | { readonly retry: true; readonly delay: number }

export interface RetryInput {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly error: { readonly type: string; readonly message: string }
  readonly attempt: number
  decision: RetryDecision
}

/** A tool call as the registry's `execute.before` hooks see it (`@opencode/plugin/effect/tool` `ToolHooks`): a hook may rename the tool and replace its input. */
export interface ToolBeforeInput {
  tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

/** A command the shell is about to spawn, as its `create.before` hooks see it (`@opencode/plugin/effect/shell` `ShellCreateBefore`). */
export interface ShellCreateInput {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string>
}

export type HookInput = ModelRequestInput | IdleInput | HttpRequestInput | HttpResponseInput | RetryInput | ToolBeforeInput | ShellCreateInput

/** The hook names of the tool registry and the shell, as the world keeps them beside the session's. */
export const TOOL_BEFORE = "tool:execute.before"
export const SHELL_CREATE = "shell:create.before"

/** A command the world's shell spawned: the session, the command as it ran, the program it ran with, where. */
export interface Spawned {
  readonly at: number
  readonly sessionID: string
  readonly command: string
  readonly shell: string
  readonly cwd: string
}

export interface Hook {
  readonly instance: number
  readonly directory: string
  readonly name: string
  readonly callback: (input: HookInput) => Effect.Effect<void, unknown>
}

/** An RPC method as the host calls it: its input and answer cross the wire as JSON. */
export type Handler = (input: Schema.Json) => Effect.Effect<unknown, unknown>

export interface Options {
  readonly seed: number
  /** The epoch ms the clock starts at. */
  readonly start?: number
  /** The model. */
  readonly script: Script
  /** How long a model request streams, ms of virtual time: the seed picks within it. */
  readonly latency?: readonly [number, number]
  /** What the shell and a monitor's checks run. */
  readonly processes?: (command: string, now: number) => Process
  /** The program the shell spawns a command with before any `create.before` hook (the config's shell); default `/bin/zsh`. */
  readonly shell?: string
  /** The fork records a compaction's `reason`; a host without it records every compaction `manual`. */
  readonly compactionReason?: boolean
  /** Background compaction: a session idle with a prompt at or past `trigger` and under `ceiling` gets a summary written ahead. */
  readonly backgroundCompaction?: { readonly trigger: number; readonly ceiling: number }
  /** `experimental.schedules` on: the schedule tools are built in. */
  readonly schedules?: boolean
  readonly models?: ReadonlyArray<CatalogModel>
  /** The model sessions run on; default `sim/sim-model`, answered by `script`. */
  readonly model?: { readonly providerID: string; readonly id: string }
  /** The world's provider for `model`'s provider: its requests go over HTTP to it, through the HTTP hooks (sim/http.ts). */
  readonly provider?: { readonly id: string; readonly baseURL: string; readonly handle: (request: WebRequest) => Effect.Effect<Response, SimError> }
  /** The logins OpenCode holds, by integration: each connection with its credential, the first one active. */
  readonly integrations?: { readonly [integrationID: string]: ReadonlyArray<Login> }
}

/** A login OpenCode holds for an integration: its connection and its OAuth credential. */
export interface Login {
  readonly id: string
  readonly label: string
  readonly access: string
  readonly refresh: string
  /** Epoch ms. */
  readonly expires: number
  /** The sign-in method that made it. Default `claude-max`. */
  readonly methodID?: string
  /** What the method kept beside the tokens (a ChatGPT login's `accountID`). Default none. */
  readonly metadata?: JsonObject
}

/** 2001-09-09T01:46:40Z: every world's clock starts here unless told otherwise, years from any wall-clock reading. */
export const START = 1_000_000_000_000

/** The built-in tool the registry starts with (real OpenCode has more; our plugins reach only the shell). */
export const BUILTIN = ["shell"]

/** OpenCode's schedule tools: built in only under `experimental.schedules` (real OpenCode's default is off). */
export const SCHEDULES = [
  "opencode_schedule_create",
  "opencode_schedule_list",
  "opencode_schedule_pause",
  "opencode_schedule_resume",
  "opencode_schedule_delete",
]

const ShellInput = Schema.Struct({ command: Schema.String, workdir: Schema.optional(Schema.String), background: Schema.optional(Schema.Boolean) })

/** The program the shell runs a command with when the options name none. */
export const SHELL = "/bin/zsh"

/**
 * Tool names a model carries over from other harnesses, run as the host's own tool when no tool has that name, as the
 * fork's input repair does (packages/core/src/plugin/tool-input-repair.ts `aliases`).
 */
const ALIASES: ReadonlyMap<string, string> = new Map([["bash", "shell"]])

/** An input a model sent as a JSON string of an object, which the repair parses (its "stringified root object"). */
const decodeObjectText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

/** The note the repair adds to an aliased call's answer, in the fork's words. */
export const aliasNote = (called: string, ran: string) => `There is no "${called}" tool, so this ran as "${ran}". Call "${ran}" directly.`

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const AGENT = "build"
const MODEL = { providerID: "sim", id: "sim-model" }
/** Where the host sends a provider's model requests before a hook moves them: Anthropic's API, as the fork's catalog names it. */
const BASE_URL = "https://api.anthropic.com/v1"

/** A tool's answer as the model reads it. */
export interface Answer {
  readonly output: string
  readonly error: boolean
}

/** The text of a tool's result: its content, a string or the text parts. */
const resultText = (result: Tool.Result) => {
  if (Schema.is(Schema.String)(result.content)) return result.content
  return (result.content ?? []).flatMap(contentText).join("\n")
}

/** A content part's text: a text part's, none of a file's. */
const contentText = (part: Tool.Content): ReadonlyArray<string> => {
  if (part.type === "text") return [part.text]
  return []
}

/** A reply item's text: a text delta's, none of a tool call's. */
const itemText = (item: Item): ReadonlyArray<string> => {
  if (item.type === "textDelta") return [item.text]
  return []
}

/** A reply's tool call, as the conversation keeps it. */
const callOf = (reply: Reply): Option.Option<ToolCall> => {
  for (const item of reply.items) if (item.type === "toolCall") return Option.some({ id: item.id, name: item.name, input: plain(item.input) })
  return Option.none()
}

/** What an inbox item carries as text: a compaction none. */
const inboxText = (item: InboxItem) => {
  if (item.type === "compaction") return ""
  return item.text
}

/** A failed tool's message: its first failure's, else the cause's text. */
const causeText = <E>(cause: Cause.Cause<E>) => {
  for (const reason of cause.reasons) if (reason._tag === "Fail") return failureText(reason.error)
  return String(cause)
}

/** A session's busy and idle times, as `session.get` answers them. */
interface SessionTime {
  busy?: DateTime.Utc
  idle?: DateTime.Utc
}

/** A session as `session.get` answers it. */
interface SessionInfo {
  readonly id: string
  parentID?: string
  title?: string
  readonly location: { readonly directory: string }
  readonly metadata: JsonObject
  readonly time: SessionTime
}

/** A tool failure's message. */
const failureText = (cause: unknown) => {
  const message = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(cause)
  return Option.getOrElse(
    Option.map(message, (value) => value.message),
    () => String(cause),
  )
}

/** The host: its state, its rules, and the trace of what happened. */
export const makeHost = (options: Options, runtime: Runtime, start: number) => {
  const trace: Array<string> = []
  const asked: Array<Asked> = []
  const sessions = new Map<string, Session>()
  const storage = new Map<string, Map<string, Schema.Json>>()
  const hooks: Array<Hook> = []
  const tools = new Map<number, Map<string, Tool.Info>>()
  const removed = new Map<number, Set<string>>()
  const rpcs = new Map<string, { readonly [method: string]: Handler }>()
  const subscribers = new Set<Subscriber>()
  const directories = new Map<number, string>()
  const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  const processes = options.processes ?? PROCESSES
  const shellProgram = options.shell ?? SHELL
  /** Every command the shell spawned, in order. */
  const spawned: Array<Spawned> = []
  const latency = options.latency ?? [100, 2_000]
  const models = options.models ?? [SIM_MODEL]
  const model = options.model ?? MODEL
  const state = { up: true, counter: 0 }
  /** What a plugin reached for that the world does not model: the world's next operation fails naming it. */
  const unmodelled: Array<string> = []
  /** The logins OpenCode holds, by integration, in order, and the active one's id. */
  const integrations = new Map(
    Object.entries(options.integrations ?? {}).map(([id, logins]) => [id, { logins: [...logins], active: Option.fromNullishOr(logins[0]?.id), marks: new Map<string, Schema.Json>() }] as const),
  )
  /** Each RPC's event subscribers, by its id: a registered handler's `events.emit` reaches them. */
  const rpcEvents = new Map<string, Set<{ readonly name: string; readonly queue: Queue.Queue<Schema.Json> }>>()
  /** What plugins changed in the catalog and the integrations' methods: recorded, as a transform's effect. */
  const activations = new Map<string, Provider.Activation>([
    ["anthropic", "auto"],
    ["openai", "auto"],
  ])
  const catalogNotFound = (what: string) => new CatalogNotFound({ message: `${what} not found` })

  /** Appends one trace line: its virtual time, its kind, its data as JSON. */
  const record = <A>(kind: string, data: A) => {
    trace.push(line({ t: runtime.now() - start, kind, ...recordOf(data) }))
  }

  /**
   * An id in the host's shape: the prefix, a counter, then letters the seed picks. A session id's counter
   * descends, as the fork's session ids do (packages/schema/src/session-id.ts `descending()`); every other
   * id's ascends.
   */
  const mint = (prefix: string) => {
    state.counter += 1
    const letters = Array.from({ length: 6 }, () => ALPHABET[below(runtime.world, ALPHABET.length)]).join("")
    let counter = state.counter
    if (prefix === "ses_") counter = 99_999 - state.counter
    return `${prefix}${counter.toString().padStart(5, "0")}${letters}`
  }

  /** Marks the session updated now, where the fork's projector bumps its `time_updated`. */
  const touch = (session: Session) => {
    session.updated = runtime.now()
  }

  /** A host fiber (an execution, a background shell, a title): it lives until it ends or the host goes down. */
  const spawn = <A, E>(effect: Effect.Effect<A, E>) => {
    const fiber = runtime.fork(effect.pipe(Effect.catchCause((cause) => Effect.sync(() => record("host-failure", { cause: String(cause) })))))
    fibers.add(fiber)
    fiber.addObserver(() => fibers.delete(fiber))
  }

  const publish = (event: HostEvent) =>
    Effect.gen(function* () {
      record("event", { type: event.type, data: event.data })
      for (const subscriber of subscribers)
        if (Option.match(subscriber.types, { onNone: () => true, onSome: (types) => types.has(event.type) })) yield* Queue.offer(subscriber.queue, event)
    })

  /**
   * Runs a request's hook (`model.request`, `http.request`, `http.response`) of the session's location's copies on
   * one event, in the order they registered: each sees what the one before left. A hook that fails fails the
   * request, as the host's `hooks.trigger` does in the model request's build and its HTTP call.
   */
  const runRequestHooks = (
    name: "model.request" | "http.request" | "http.response",
    session: Session,
    event: ModelRequestInput | HttpRequestInput | HttpResponseInput,
    detail: JsonObject = {},
  ) =>
    Effect.gen(function* () {
      record("hook", { name, sessionID: session.id, ...detail })
      for (const hook of hooks.filter((entry) => entry.name === name && entry.directory === session.directory))
        yield* Effect.orDie(hook.callback(event)).pipe(
          Effect.catchDefect((defect) =>
            Effect.die(
              new HookDied({
                name,
                message: Option.getOrElse(
                  Option.map(Option.liftPredicate(defect, (value): value is Error => value instanceof Error), (error) => error.message),
                  () => String(defect),
                ),
              }),
            ),
          ),
        )
    })

  /** Runs the hook `name` of the session's location's copies, in the order they registered; a failing hook is the host's log, not the turn's end. */
  const runHooks = (name: string, session: Session, input: HookInput, detail: JsonObject = {}) =>
    Effect.gen(function* () {
      record("hook", { name, sessionID: session.id, ...detail })
      for (const hook of hooks.filter((entry) => entry.name === name && entry.directory === session.directory))
        yield* hook.callback(input).pipe(Effect.catchCause((cause) => Effect.sync(() => record("hook-failure", { name, cause: String(cause) }))))
    })

  const renderOf = (message: Message): string => {
    switch (message.type) {
      case "user":
        return `user: ${message.text}`
      case "synthetic":
        return `synthetic: ${message.text}`
      case "assistant":
        return Option.match(message.call, {
          onNone: () => `assistant: ${message.text}`,
          onSome: (used) => `assistant call ${used.id} ${used.name} ${line(used.input)}`,
        })
      case "tool":
        return `tool ${message.callID} ${message.name}: ${message.output}`
      case "compaction":
        return `compaction: ${message.summary}`
      case "error":
        return `error ${message.tag}: ${message.message}`
    }
  }

  /** The session's context: from its newest completed compaction on. */
  const contextOf = (session: Session) =>
    session.messages.slice(
      Math.max(
        0,
        session.messages.findLastIndex((message) => message.type === "compaction"),
      ),
    )

  /** The tools a request in `directory` offers: the built-ins, then each copy's transform there, in load order. */
  const builtIn = [...BUILTIN, ...Arr.filter(SCHEDULES, () => options.schedules === true)]
  const toolsOf = (directory: string) => {
    const offered = new Map<string, Option.Option<Tool.Info>>(builtIn.map((name) => [name, Option.none()]))
    for (const [instance, at] of directories) {
      if (at !== directory) continue
      for (const name of removed.get(instance) ?? []) offered.delete(name)
      for (const [name, tool] of tools.get(instance) ?? []) offered.set(name, Option.some(tool))
    }
    return offered
  }

  const textOf = (reply: Reply) => reply.items.flatMap(itemText).join("")

  /** The stream's time: the seed picks within the latency. */
  const streaming = Effect.suspend(() => {
    const [low, high] = latency
    return Effect.sleep(low + below(runtime.world, Math.max(1, high - low + 1)))
  })

  /** The conversation as Anthropic's messages API carries it. */
  const wireOf = (message: Message): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Schema.Json> }> => {
    switch (message.type) {
      case "user":
      case "synthetic":
        return [{ role: "user", content: [{ type: "text", text: message.text }] }]
      case "compaction":
        return [{ role: "user", content: [{ type: "text", text: message.summary }] }]
      case "error":
        return []
      case "tool":
        return [{ role: "user", content: [{ type: "tool_result", tool_use_id: message.callID, content: message.output }] }]
      case "assistant":
        return Option.match(message.call, {
          onNone: () => [{ role: "assistant" as const, content: [{ type: "text", text: message.text }] }],
          onSome: (used) => [{ role: "assistant" as const, content: [{ type: "tool_use", id: used.id, name: used.name, input: used.input }] }],
        })
    }
  }

  /** A request over HTTP to the world's provider, through the HTTP hooks of the session's location's copies: the reply, or the failure. */
  const overHttp = (
    session: Session,
    provider: NonNullable<Options["provider"]>,
    event: { readonly kind: Kind; readonly baseURL: string; readonly headers: { readonly [key: string]: string } },
    tools: ReadonlyArray<string>,
    extra: string,
  ) =>
    Effect.gen(function* () {
      const scope = { sessionID: session.id, agent: AGENT, model }
      const conversation = contextOf(session).flatMap(wireOf)
      const messages = [...conversation, ...Arr.filter([{ role: "user" as const, content: [{ type: "text", text: extra }] }], () => extra !== "")]
      const sent = new Request(`${event.baseURL}/messages`, {
        method: "POST",
        headers: { ...event.headers, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: Http.bodyOf({ model: model.id, system: "You are OpenCode.", messages, tools }),
      })
      const before: HttpRequestInput = { ...scope, kind: event.kind, request: sent }
      yield* runRequestHooks("http.request", session, before)
      // The answer arrives at once: a refusal is whole then; an answer streams for the seed's latency before it is read.
      // A data: URL is answered in the process, as the host's fetch reads one, never by the provider.
      const answered = yield* Effect.exit(
        Option.match(Http.dataOf(before.request.url), { onNone: () => provider.handle(before.request), onSome: Effect.succeed }),
      )
      if (Exit.isFailure(answered)) return Result.fail(Http.unreachable(String(answered.cause)))
      const after: HttpResponseInput = { ...scope, kind: event.kind, request: before.request, response: answered.value }
      yield* runRequestHooks("http.response", session, after)
      const text = yield* Http.textOf(after.response)
      if (!after.response.ok) return Result.fail(Http.classify(after.response.status, after.response.headers, text))
      yield* streaming
      const streamed = Http.readStream(text)
      const items = streamed.items.map((item): Item => {
        if (item.type === "text") return { type: "textDelta", text: item.text }
        return { type: "toolCall", index: 0, id: item.id, name: item.name, input: item.input }
      })
      return Result.succeed<Reply>({ items, usage: streamed.usage })
    })

  /** One model request: the hook, the request in the trace, the stream's time, the reply (the script's, or the provider's over HTTP), or its failure. */
  const attempt = (session: Session, kind: Kind, extra = "") =>
    Effect.gen(function* () {
      const event = { sessionID: session.id, agent: AGENT, model, kind, baseURL: options.provider?.baseURL ?? BASE_URL, headers: {} }
      yield* runRequestHooks("model.request", session, event, { requestKind: kind })
      const startedAt = runtime.now()
      const text = [...contextOf(session).map(renderOf), extra].filter((part) => part !== "").join("\n")
      record("request", { sessionID: session.id, requestKind: kind })
      asked.push({ at: startedAt - start, sessionID: session.id, kind, text })
      const tools = Arr.filter([...toolsOf(session.directory).keys()], () => kind === "primary")
      const outcome = yield* Option.match(
        Option.filter(Option.fromNullishOr(options.provider), (provider) => provider.id === model.providerID),
        {
          onNone: () =>
            streaming.pipe(
              Effect.andThen(
                Effect.sync((): Result.Result<Reply, Http.Failure> => Result.succeed(options.script({ sessionID: session.id, kind, agent: AGENT, text, tools: [...toolsOf(session.directory).keys()] }))),
              ),
            ),
          onSome: (provider) => overHttp(session, provider, event, tools, extra),
        },
      )
      Result.match(outcome, {
        onSuccess: (reply) => record("reply", { sessionID: session.id, requestKind: kind, items: reply.items }),
        onFailure: (failure) => record("request-failed", { sessionID: session.id, requestKind: kind, ...failure }),
      })
      return { outcome, startedAt }
    })

  /** One model request that must answer (a compaction's, a title's): a failure answers nothing, a hook that died too. */
  const request = (session: Session, kind: Kind, extra = "") =>
    attempt(session, kind, extra).pipe(
      Effect.map(({ outcome, startedAt }) => ({ reply: Result.getOrElse(outcome, (): Reply => ({ items: [] })), startedAt })),
      Effect.catchDefect((defect) => {
        if (!(defect instanceof HookDied)) return Effect.die(defect)
        record("request-failed", { sessionID: session.id, requestKind: kind, tag: "Unknown", message: defect.message })
        return Effect.succeed({ reply: { items: [] } satisfies Reply, startedAt: runtime.now() })
      }),
    )

  /**
   * A primary request and its retries: each failure goes to the `retry` hook with the policy's decision
   * (sim/http.ts), and a retry waits its gap and asks again, the `model.request` hook running again.
   */
  const primary = (session: Session) =>
    Effect.gen(function* () {
      for (let retries = 0; ; retries += 1) {
        const { outcome, startedAt } = yield* attempt(session, "primary")
        if (Result.isSuccess(outcome)) return Result.succeed({ reply: outcome.success, startedAt })
        const failure = outcome.failure
        const gap = Http.gapOf(runtime, retries, failure)
        if (Option.isNone(gap)) return Result.fail(failure)
        const event: RetryInput = {
          sessionID: session.id,
          agent: AGENT,
          model,
          error: { type: failure.tag, message: failure.message },
          attempt: retries + 2,
          decision: Option.match(Option.liftPredicate(gap.value, () => failure.retryable), {
            onNone: (): RetryDecision => ({ retry: false }),
            onSome: (delay): RetryDecision => ({ retry: true, delay }),
          }),
        }
        yield* runHooks("retry", session, event, { attempt: event.attempt })
        const decision = event.decision
        record("retry-decision", { sessionID: session.id, ...decision })
        if (!decision.retry) return Result.fail(failure)
        let delay = gap.value
        if (Number.isFinite(decision.delay) && decision.delay >= 0) delay = Math.ceil(decision.delay)
        yield* publish({ type: "session.retry.scheduled", data: { sessionID: session.id, attempt: event.attempt, at: runtime.now() + delay } })
        yield* Effect.sleep(delay)
      }
    })

  /** A background shell: it runs on its own; its end steers a notice into the session, which wakes it. */
  const background = (session: Session, command: string) => {
    const shell = { id: mint("sh_"), command }
    session.shells.push(shell)
    const run = processes(command, runtime.now())
    spawn(
      Effect.gen(function* () {
        yield* Effect.sleep(run.ms)
        session.shells.splice(session.shells.indexOf(shell), 1)
        yield* admit(session, {
          id: mint("msg_"),
          type: "synthetic",
          text: `Background shell ${shell.id} finished (exit ${run.exitCode}): \`${command}\`\n${run.stdout}`,
          description: `shell ${shell.id} finished`,
          metadata: { source: "shell", shellID: shell.id },
          resume: true,
        })
      }),
    )
    return shell
  }

  /**
   * The shell's spawn: its `create.before` hooks of the session's location's copies, in the order they registered, on
   * one invocation, each seeing what the one before left (packages/core/src/shell.ts `create`); then the command as the
   * hooks left it runs with the program they left, in the trace. The hooks may not fail (the shell domain has no failures).
   */
  const spawnShell = (session: Session, command: string, workdir: Option.Option<string>) =>
    Effect.gen(function* () {
      const invocation: ShellCreateInput = {
        command,
        cwd: Option.match(workdir, {
          onNone: () => session.directory,
          onSome: (dir) => Option.getOrElse(Option.liftPredicate(dir, (absolute) => absolute.startsWith("/")), () => `${session.directory}/${dir}`),
        }),
        timeout: 0,
        shell: shellProgram,
        env: { TERM: "xterm-256color", OPENCODE_TERMINAL: "1" },
      }
      for (const hook of hooks.filter((entry) => entry.name === SHELL_CREATE && entry.directory === session.directory)) yield* Effect.orDie(hook.callback(invocation))
      const ran: Spawned = { at: runtime.now() - start, sessionID: session.id, command: invocation.command, shell: invocation.shell, cwd: invocation.cwd }
      spawned.push(ran)
      record("spawned", { sessionID: session.id, command: ran.command, shell: ran.shell, cwd: ran.cwd })
      return ran
    })

  /** The built-in shell: foreground runs it and answers its output; background starts it and answers at once. */
  const shellTool = (session: Session, call: ToolBeforeInput) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(ShellInput)(call.input)
      if (Exit.isFailure(decoded)) return { output: "Error: invalid shell input", error: true }
      const { command } = yield* spawnShell(session, decoded.value.command, Option.fromNullishOr(decoded.value.workdir))
      if (decoded.value.background === true) return { output: `Started ${background(session, command).id} in the background: \`${command}\``, error: false }
      const run = processes(command, runtime.now())
      yield* Effect.sleep(run.ms)
      return { output: `exit ${run.exitCode}\n${run.stdout}`, error: run.exitCode !== 0 }
    })

  /** A plugin's tool: its input decoded with its own schema, then its execute on the call's context. */
  const pluginTool = (session: Session, messageID: string, used: { readonly id: string; readonly name: string; readonly input: unknown }, tool: Tool.Info) =>
    Effect.gen(function* () {
      if (!Schema.isSchema(tool.input)) return yield* Effect.die(new Error(`sim: ${used.name}'s input is not an Effect schema; the world decodes only those`))
      const decoded = Schema.decodeUnknownExit(tool.input)(used.input)
      if (Exit.isFailure(decoded)) return { output: `Error: invalid input for ${used.name}: ${String(decoded.cause)}`, error: true }
      const context: Tool.Context = {
        sessionID: SessionID.make(session.id),
        agent: Agent.ID.make(AGENT),
        messageID: SessionMessage.ID.make(messageID),
        id: Tool.CallID.make(used.id),
        progress: () => Effect.void,
      }
      const result = yield* Effect.exit(tool.execute(decoded.value, context))
      if (Exit.isSuccess(result)) return { output: resultText(result.value), error: false }
      return { output: `Error: ${causeText(result.cause)}`, error: true }
    })

  /**
   * The host's input repair, the first `execute.before` hook (the fork's `ToolInputRepairPlugin` is first among the
   * internal plugins, before any config plugin): a name with no tool runs as its alias's tool when that is offered, and
   * an input sent as a JSON string of an object is parsed. Its other repairs (numeric and boolean strings, nested
   * fields) are not modelled: such an input reaches the tool as the model sent it.
   */
  const repair = (session: Session, event: ToolBeforeInput) => {
    const offered = toolsOf(session.directory)
    const alias = ALIASES.get(event.tool)
    if (!offered.has(event.tool) && alias !== void 0 && offered.has(alias)) event.tool = alias
    if (!offered.has(event.tool)) return
    if (Predicate.isString(event.input)) event.input = Option.getOrElse(decodeObjectText(event.input), () => event.input)
  }

  /**
   * The registry's `execute.before` hooks of the session's location's copies, after the repair, in the order they
   * registered, on one event (packages/core/src/tool.ts `beforeExecute`): the call as they leave it, or the first
   * failure's message, which refuses it before the tool runs. A hook that dies is not modelled: it dies here.
   */
  const beforeTool = (session: Session, messageID: string, used: ToolCall) =>
    Effect.gen(function* () {
      const event: ToolBeforeInput = { tool: used.name, sessionID: session.id, agent: AGENT, messageID, id: used.id, input: used.input }
      repair(session, event)
      for (const hook of hooks.filter((entry) => entry.name === TOOL_BEFORE && entry.directory === session.directory)) {
        const exit = yield* Effect.exit(hook.callback(event))
        if (Exit.isFailure(exit)) {
          if (!exit.cause.reasons.some((reason) => reason._tag === "Fail")) return yield* Effect.failCause(exit.cause).pipe(Effect.orDie)
          return Result.fail(causeText(exit.cause))
        }
      }
      return Result.succeed(event)
    })

  /** One tool call: its answer, in the trace with its input. */
  const runTool = (session: Session, messageID: string, used: ToolCall) =>
    Effect.gen(function* () {
      record("tool", { sessionID: session.id, name: used.name, input: used.input })
      const before = yield* beforeTool(session, messageID, used)
      let answer: Answer = { output: "", error: true }
      if (Result.isFailure(before)) {
        answer = { output: `Error: ${before.failure}`, error: true }
        record("tool-refused", { sessionID: session.id, name: used.name, message: before.failure })
      } else {
        const { tool: name, input } = before.success
        if (name !== used.name || input !== used.input) record("tool-hooked", { sessionID: session.id, name, input: plain(input) })
        const offered = toolsOf(session.directory).get(name)
        answer = { output: `Error: unknown tool ${name}`, error: true }
        if (offered !== void 0 && Option.isSome(offered)) answer = yield* pluginTool(session, messageID, { id: used.id, name, input }, offered.value)
        else if (offered !== void 0 && name === "shell") answer = yield* shellTool(session, before.success)
        else if (offered !== void 0) answer = { output: `Error: ${name} is not modelled in the world`, error: true }
        // The repair's `execute.after`: an aliased call's answer names the tool that ran.
        if (name !== used.name) answer = { ...answer, output: `${answer.output}\n\n${aliasNote(used.name, name)}` }
      }
      record("tool-answer", { sessionID: session.id, name: used.name, output: answer.output, error: answer.error })
      return answer
    })

  /** A compaction: the held summary, else a `compaction` request; then its completed message. */
  const compaction = (session: Session, item: Extract<InboxItem, { type: "compaction" }>) =>
    Effect.gen(function* () {
      const held = session.held
      session.held = Option.none()
      let summary = ""
      if (Option.isSome(held)) {
        summary = held.value
        record("held-summary-used", { sessionID: session.id })
      } else summary = textOf((yield* request(session, "compaction", "summarize the conversation above")).reply)
      let reason: Reason = "manual"
      if (options.compactionReason !== false) reason = Option.getOrElse(item.reason, (): Reason => "manual")
      session.messages.push({ type: "compaction", id: item.id, created: runtime.now(), status: "completed", summary, reason })
      record("compacted", { sessionID: session.id })
    })

  /** Takes the inbox up to its first compaction into the conversation, each one delivered. */
  const deliver = (session: Session) =>
    Effect.gen(function* () {
      const compaction = session.inbox.findIndex((item) => item.type === "compaction")
      let count = session.inbox.length
      if (compaction !== -1) count = compaction
      const taken = session.inbox.splice(0, count)
      for (const item of taken) {
        if (item.type === "prompt") session.messages.push({ type: "user", id: item.id, created: runtime.now(), text: item.text })
        if (item.type === "synthetic")
          session.messages.push({
            type: "synthetic",
            id: item.id,
            created: runtime.now(),
            text: item.text,
            description: item.description,
            metadata: item.metadata,
          })
        yield* publish({ type: "session.inbox.delivered", data: { sessionID: session.id, inboxID: item.id } })
      }
      return taken.length
    })

  /** The title, asked once for a root session as its first execution starts, on a fiber of its own. */
  const title = (session: Session) => {
    if (Option.isSome(session.title) || Option.isSome(session.parentID)) return
    session.title = Option.some("")
    spawn(
      request(session, "title").pipe(
        Effect.map(({ reply }) => {
          session.title = Option.some(textOf(reply))
          touch(session)
        }),
      ),
    )
  }

  /** One step: a primary request, its assistant message, and its tool call's answer; whether the turn goes on, or it failed. */
  const step = (session: Session) =>
    Effect.gen(function* () {
      title(session)
      session.held = Option.none()
      touch(session)
      // An HTTP hook that died ends the execution failed, past the retry policy, its message the session's error (the
      // fork's `toSessionError` of the squashed cause: `unknown`).
      const answered = yield* primary(session).pipe(
        Effect.catchDefect((defect) => {
          if (!(defect instanceof HookDied)) return Effect.die(defect)
          return Effect.succeed(Result.fail<Http.Failure>({ tag: "Unknown", status: 0, message: defect.message, retryable: false, retryAfterMs: 0 }))
        }),
      )
      // A step's end bumps the session's update time, failed or not (the projector's Step.Ended and Step.Failed).
      touch(session)
      if (Result.isFailure(answered)) {
        const failure = answered.failure
        session.messages.push({ type: "error", id: mint("msg_"), created: runtime.now(), tag: failure.tag, message: failure.message })
        record("step-failed", { sessionID: session.id, tag: failure.tag })
        return "failed" as const
      }
      const { reply, startedAt } = answered.success
      const usage = reply.usage ?? USAGE
      const used = callOf(reply)
      const messageID = mint("msg_")
      session.messages.push({
        type: "assistant",
        id: messageID,
        created: startedAt,
        text: textOf(reply),
        call: used,
        tokens: { input: usage.input, cache: { read: usage.read, write: usage.write } },
        model,
        agent: AGENT,
      })
      if (Option.isNone(used)) return "answered" as const
      const answer = yield* runTool(session, messageID, used.value)
      session.messages.push({
        type: "tool",
        id: mint("msg_"),
        created: runtime.now(),
        callID: used.value.id,
        name: used.value.name,
        output: answer.output,
        error: answer.error,
      })
      return "called" as const
    })

  /** The turn: compactions and steps until a step answers with text; whether it did model work (not only control work), or a step failed. */
  const turn = (session: Session) =>
    Effect.gen(function* () {
      for (let stepped: "control" | "model" = "control"; ;) {
        const first = session.inbox[0]
        if (first?.type === "compaction") {
          session.inbox.shift()
          yield* publish({ type: "session.inbox.delivered", data: { sessionID: session.id, inboxID: first.id } })
          yield* compaction(session, first)
          if (!session.inbox.some((item) => item.resume)) return stepped
          continue
        }
        const taken = yield* deliver(session)
        if (taken === 0 && stepped === "control") return stepped
        stepped = "model"
        const outcome = yield* step(session)
        if (outcome === "failed") return outcome
        if (outcome === "answered") return stepped
      }
    })

  /**
   * The execution of a session: its turn; then, after model work (not after control work such as a compaction),
   * `experimental.idle` with the background still running, and the same execution goes on with what the hooks
   * admitted; then idle, and a new execution when resumable work came meanwhile.
   */
  const execute = (session: Session): Effect.Effect<void> =>
    Effect.gen(function* () {
      session.running = true
      session.busy = Option.some(runtime.now())
      yield* publish({ type: "session.execution.started", data: { sessionID: session.id } })
      let ended: "control" | "model" | "failed" = yield* turn(session)
      while (ended === "model") {
        yield* runHooks("experimental.idle", session, {
          sessionID: session.id,
          background: session.shells.map((shell) => ({ kind: "shell", sessionID: session.id, shellID: shell.id, command: shell.command })),
        })
        if (!session.inbox.some((item) => item.resume)) break
        ended = yield* turn(session)
      }
      session.idle = Option.some(runtime.now())
      session.running = false
      // A failed step ends the execution failed: `experimental.idle` does not run after a failure.
      if (ended === "failed") yield* publish({ type: "session.execution.failed", data: { sessionID: session.id } })
      else yield* publish({ type: "session.execution.succeeded", data: { sessionID: session.id } })
      precompute(session)
      wake(session)
    })

  /** Background compaction: a summary written ahead for a session idle near its window's ceiling. */
  const precompute = (session: Session) => {
    const window = options.backgroundCompaction
    // The context since the newest compaction: a compacted session has no prompt to summarize ahead.
    const last = contextOf(session).findLast((message) => message.type === "assistant")
    if (window === void 0 || last?.type !== "assistant" || Option.isSome(session.held)) return
    const prompt = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
    if (prompt < window.trigger || prompt >= window.ceiling) return
    spawn(
      request(session, "compaction", "summarize the conversation above").pipe(
        Effect.map(({ reply }) => {
          if (!session.running) session.held = Option.some(textOf(reply))
          record("held-summary", { sessionID: session.id })
        }),
      ),
    )
  }

  /** Starts an execution for an idle session with resumable work waiting, while the host is up. */
  const wake = (session: Session) => {
    if (!state.up || session.running || !sessions.has(session.id)) return
    if (!session.inbox.some((item) => item.resume)) return
    session.running = true
    spawn(execute(session))
  }

  /** An inbox admission: the first of an id wins; each publishes `session.inbox.enqueued`; a resumable one wakes the session. */
  const admit = (session: Session, item: InboxItem) =>
    Effect.gen(function* () {
      if (session.admitted.has(item.id)) return record("admission-repeated", { sessionID: session.id, id: item.id })
      session.admitted.add(item.id)
      touch(session)
      session.inbox.push(item)
      record("admitted", { sessionID: session.id, id: item.id, type: item.type, resume: item.resume, text: inboxText(item) })
      yield* publish({ type: "session.inbox.enqueued", data: { sessionID: session.id, inboxID: item.id } })
      if (item.resume) wake(session)
    })

  const sessionOr = (sessionID: string): Effect.Effect<Session, SessionNotFound> => {
    const session = sessions.get(sessionID)
    if (session === void 0) return Effect.fail(new SessionNotFound({ sessionID, message: `Session not found: ${sessionID}` }))
    return Effect.succeed(session)
  }

  /** A compaction asked for: the pending one's id when one waits, else a new one admitted. */
  const compact = (session: Session, reason: Option.Option<Reason>) => {
    const pending = session.inbox.find((item) => item.type === "compaction")
    if (pending !== void 0) return Effect.succeed({ id: pending.id })
    const id = mint("msg_")
    return admit(session, { id, type: "compaction", reason, resume: true }).pipe(Effect.as({ id }))
  }

  const createSession = (input: {
    readonly id?: string
    readonly directory: string
    readonly parentID?: string
    readonly title?: string
    readonly metadata?: JsonObject
  }) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.id ?? "")
      if (existing !== void 0) return existing
      const session: Session = {
        id: input.id ?? mint("ses_"),
        parentID: Option.fromNullishOr(input.parentID),
        title: Option.fromNullishOr(input.title),
        directory: input.directory,
        metadata: { ...input.metadata },
        busy: Option.none(),
        idle: Option.none(),
        updated: runtime.now(),
        messages: [],
        inbox: [],
        admitted: new Set(),
        running: false,
        held: Option.none(),
        shells: [],
      }
      sessions.set(session.id, session)
      record("session-created", { sessionID: session.id, directory: session.directory, parentID: Option.getOrElse(session.parentID, () => "") })
      yield* publish({ type: "session.created", data: { sessionID: session.id } })
      return session
    })

  /** The session as `session.get` answers it. */
  const infoOf = (session: Session) => {
    const time: SessionTime = {}
    if (Option.isSome(session.busy)) time.busy = DateTime.makeUnsafe(session.busy.value)
    if (Option.isSome(session.idle)) time.idle = DateTime.makeUnsafe(session.idle.value)
    const info: SessionInfo = {
      id: session.id,
      location: { directory: session.directory },
      metadata: { ...session.metadata },
      time,
    }
    if (Option.isSome(session.parentID)) info.parentID = session.parentID.value
    if (Option.isSome(session.title)) info.title = session.title.value
    return info
  }

  /** A message as `session.context` answers it. */
  const viewOf = (message: Message) => {
    const created = { created: DateTime.makeUnsafe(message.created) }
    if (message.type !== "assistant") return { ...message, time: created }
    const { call: used, ...rest } = message
    return Option.match(used, { onNone: () => ({ ...rest, time: created }), onSome: (value) => ({ ...rest, call: value, time: created }) })
  }

  /** The catalog's providers: one per provider the models name. */
  const providers = () =>
    [...new Set([...models.map((entry) => entry.providerID), ...[...activations].flatMap(([id, activation]) => Arr.filter([id], () => activation === "enabled"))])].map(
      (id) => ({ id }),
    )

  /** Calls an RPC method across the wire: JSON in, JSON out. */
  const callRpc = (id: string, method: string, input: Schema.Json) =>
    Effect.suspend(() => {
      record("rpc-call", { id, method })
      const handler = rpcs.get(id)?.[method]
      if (handler === void 0) return Effect.fail(new RpcNotFound({ message: `no RPC ${id}.${method}` }))
      return handler(plain(input)).pipe(Effect.map(plain))
    })

  /** Stops every host fiber: the server is gone. */
  const stop = () => {
    state.up = false
    for (const fiber of fibers) fiber.interruptUnsafe()
  }

  /** The server is back: sessions with resumable work start. */
  const resume = () => {
    state.up = true
    for (const session of sessions.values()) {
      session.running = false
      wake(session)
    }
  }

  return {
    trace,
    asked,
    touch,
    sessions,
    storage,
    hooks,
    tools,
    removed,
    rpcs,
    subscribers,
    directories,
    models,
    state,
    unmodelled,
    integrations,
    rpcEvents,
    activations,
    catalogNotFound,
    processes,
    spawned,
    record,
    mint,
    publish,
    admit,
    sessionOr,
    compact,
    createSession,
    infoOf,
    viewOf,
    contextOf,
    toolsOf,
    runTool,
    providers,
    callRpc,
    stop,
    resume,
  }
}

export type Host = ReturnType<typeof makeHost>
