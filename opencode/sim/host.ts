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
// - A background shell's end steers a notice into its session, which wakes it.
// - Plugin storage is the host's, per plugin id, and outlives a restart.
// - Events reach every copy, hooks only the session's location's.
import { Tool } from "@opencode/schema/tool"
import type { SimulationProtocol } from "@opencode/simulation/protocol"
import { Agent } from "@opencode/schema/agent"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Array as Arr, type Cause, Data, DateTime, Effect, Exit, type Fiber, Option, Queue, Schema } from "effect"
import { below, type JsonObject, line, plain, record as recordOf, type Runtime } from "./runtime.ts"

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

export type HookInput = ModelRequestInput | IdleInput

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
  /** The fork records a compaction's `reason`; a host without it records every compaction `manual`. */
  readonly compactionReason?: boolean
  /** Background compaction: a session idle with a prompt at or past `trigger` and under `ceiling` gets a summary written ahead. */
  readonly backgroundCompaction?: { readonly trigger: number; readonly ceiling: number }
  /** `experimental.schedules` on: the schedule tools are built in. */
  readonly schedules?: boolean
  readonly models?: ReadonlyArray<CatalogModel>
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

const ShellInput = Schema.Struct({ command: Schema.String, background: Schema.optional(Schema.Boolean) })

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const AGENT = "build"
const MODEL = { providerID: "sim", id: "sim-model" }

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
  const latency = options.latency ?? [100, 2_000]
  const models = options.models ?? [SIM_MODEL]
  const state = { up: true, counter: 0 }
  /** What a plugin reached for that the world does not model: the world's next operation fails naming it. */
  const unmodelled: Array<string> = []
  const catalogNotFound = (what: string) => new CatalogNotFound({ message: `${what} not found` })

  /** Appends one trace line: its virtual time, its kind, its data as JSON. */
  const record = <A>(kind: string, data: A) => {
    trace.push(line({ t: runtime.now() - start, kind, ...recordOf(data) }))
  }

  /** An id in the host's shape: the prefix, a counter, then letters the seed picks. */
  const mint = (prefix: string) => {
    state.counter += 1
    const letters = Array.from({ length: 6 }, () => ALPHABET[below(runtime.world, ALPHABET.length)]).join("")
    return `${prefix}${state.counter.toString().padStart(5, "0")}${letters}`
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

  /** One model request: the hook, the request in the trace, the stream's time, the script's reply. */
  const request = (session: Session, kind: Kind, extra = "") =>
    Effect.gen(function* () {
      yield* runHooks("model.request", session, { sessionID: session.id, agent: AGENT, model: MODEL, kind, headers: {} }, { requestKind: kind })
      const startedAt = runtime.now()
      const text = [...contextOf(session).map(renderOf), extra].filter((part) => part !== "").join("\n")
      record("request", { sessionID: session.id, requestKind: kind })
      asked.push({ at: startedAt - start, sessionID: session.id, kind, text })
      const [low, high] = latency
      yield* Effect.sleep(low + below(runtime.world, Math.max(1, high - low + 1)))
      const reply = options.script({ sessionID: session.id, kind, agent: AGENT, text, tools: [...toolsOf(session.directory).keys()] })
      record("reply", { sessionID: session.id, requestKind: kind, items: reply.items })
      return { reply, startedAt }
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

  /** The built-in shell: foreground runs it and answers its output; background starts it and answers at once. */
  const shellTool = (session: Session, input: Schema.Json) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(ShellInput)(input)
      if (Exit.isFailure(decoded)) return { output: "Error: invalid shell input", error: true }
      const { command } = decoded.value
      if (decoded.value.background === true) return { output: `Started ${background(session, command).id} in the background: \`${command}\``, error: false }
      const run = processes(command, runtime.now())
      yield* Effect.sleep(run.ms)
      return { output: `exit ${run.exitCode}\n${run.stdout}`, error: run.exitCode !== 0 }
    })

  /** A plugin's tool: its input decoded with its own schema, then its execute on the call's context. */
  const pluginTool = (session: Session, messageID: string, used: ToolCall, tool: Tool.Info) =>
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

  /** One tool call: its answer, in the trace with its input. */
  const runTool = (session: Session, messageID: string, used: ToolCall) =>
    Effect.gen(function* () {
      record("tool", { sessionID: session.id, name: used.name, input: used.input })
      const offered = toolsOf(session.directory).get(used.name)
      let answer: Answer = { output: `Error: unknown tool ${used.name}`, error: true }
      if (offered !== void 0 && Option.isSome(offered)) answer = yield* pluginTool(session, messageID, used, offered.value)
      else if (offered !== void 0 && used.name === "shell") answer = yield* shellTool(session, used.input)
      else if (offered !== void 0) answer = { output: `Error: ${used.name} is not modelled in the world`, error: true }
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
    spawn(request(session, "title").pipe(Effect.map(({ reply }) => void (session.title = Option.some(textOf(reply))))))
  }

  /** One step: a primary request, its assistant message, and its tool call's answer; whether the turn goes on. */
  const step = (session: Session) =>
    Effect.gen(function* () {
      title(session)
      session.held = Option.none()
      const { reply, startedAt } = yield* request(session, "primary")
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
        model: MODEL,
        agent: AGENT,
      })
      if (Option.isNone(used)) return false
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
      return true
    })

  /** The execution's body: compactions and steps until a step answers with text and nothing resumable waits. */
  /** The turn: compactions and steps until a step answers with text; whether it did model work (not only control work). */
  const turn = (session: Session) =>
    Effect.gen(function* () {
      for (let stepped = false; ;) {
        const first = session.inbox[0]
        if (first?.type === "compaction") {
          session.inbox.shift()
          yield* publish({ type: "session.inbox.delivered", data: { sessionID: session.id, inboxID: first.id } })
          yield* compaction(session, first)
          if (!session.inbox.some((item) => item.resume)) return stepped
          continue
        }
        const taken = yield* deliver(session)
        if (taken === 0 && !stepped) return stepped
        stepped = true
        if (!(yield* step(session))) return stepped
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
      while (yield* turn(session)) {
        yield* runHooks("experimental.idle", session, {
          sessionID: session.id,
          background: session.shells.map((shell) => ({ kind: "shell", sessionID: session.id, shellID: shell.id, command: shell.command })),
        })
        if (!session.inbox.some((item) => item.resume)) break
      }
      session.idle = Option.some(runtime.now())
      session.running = false
      yield* publish({ type: "session.execution.succeeded", data: { sessionID: session.id } })
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
  const providers = () => [...new Set(models.map((model) => model.providerID))].map((id) => ({ id }))

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
    catalogNotFound,
    processes,
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
