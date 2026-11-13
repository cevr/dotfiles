// The server double: the client API the fork's TUI talks to, as scripted state
// a test sets up, held to real OpenCode by the client laws (client-laws.ts).
//
// - Every answer and every event is encoded through the fork's own schemas
//   (`ClientApi` endpoints' success schemas, `EventManifest.Server`), so a shape
//   the real server could not send fails to encode, naming the route or event.
// - What it does, and in which order, is copied from recordings of real OpenCode
//   (the client laws hold each to it): a prompt is enqueued, starts an execution
//   and is delivered; the scripted model streams a step; an interrupt fails the
//   step (`aborted`), ends the execution `interrupted` and leaves an idle
//   message; a revert stages the user message; a steer sent while a step runs
//   stays pending until the next step, a queued prompt until the run ends.
// - A route the double does not serve, and that is not one of the fork
//   fixture's defaults (`FIXTURE_ROUTES`), is recorded and fails the test's next
//   step naming it (`unserved`).
// - `silence`: the double stops answering (the requests stay open) while time moves.
//
// Ids are the fork's own (Identifier) on the virtual clock, their random part drawn
// from the seed by the harness; times are the virtual clock's.
import { Array as Arr, Effect, Exit, Option, Predicate, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { ClientApi } from "@opencode/protocol/client"
import type { OpenCodeEvent as ClientEvent } from "@opencode/client"
import { EventManifest } from "@opencode/schema/event-manifest"
import { Agent } from "@opencode/schema/agent"
import { Identifier } from "@opencode/schema/identifier"
import { Model as ModelInfo } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

/** The fixture's location (the fork's tui-client.ts `directory` and project). */
export const DIRECTORY = "/tmp/opencode/packages/tui"
export const PROJECT = "proj_test"

/** A model as a session names it. */
export type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string }

/** One thing the scripted model does in a step. */
export const Step = Schema.TaggedUnion({
  Text: { text: Schema.String },
  Reasoning: { text: Schema.String },
  /** The model holds here until the run is interrupted (or `release`d). */
  Stall: {},
  /** A shell call a controller holds (opencode-drive's `tools.control`, as the scenarios run it) until the run is interrupted. */
  Shell: {
    id: Schema.String,
    command: Schema.String,
    description: Schema.optional(Schema.String),
    /** The shell tool started it (it runs until `exit`ed or cut), as opposed to a controller holding the call. */
    started: Schema.optional(Schema.Boolean),
  },
  /**
   * A call that runs and answers within its step: a foreground shell that exits 0 with `output`, or a read
   * of the text file at `path` holding `output`, each answered as the fork's tool answers it.
   */
  Ran: { id: Schema.String, tool: Schema.Literals(["shell", "read"]), target: Schema.String, output: Schema.String },
  /** A background subagent call: a child session starts on `input.prompt`; the model answers it as any session (by `Asked.sessionID`). */
  Subagent: {
    id: Schema.String,
    input: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
    title: Schema.String,
    agent: Schema.String,
    model: Schema.Struct({ id: Schema.String, providerID: Schema.String }),
  },
})
export type Step = typeof Step.Type
/** A step that calls a tool and has its answer within the step: the step ends `tool-calls`. */
const callsTool = Predicate.or(Predicate.isTagged("Subagent"), Predicate.isTagged("Ran"))
type Subagent = typeof Step.cases.Subagent.Type

/** The model streams `text`. */
export const text = (value: string): Step => Step.cases.Text.make({ text: value })
/** The model thinks `text`. */
export const reasoning = (value: string): Step => Step.cases.Reasoning.make({ text: value })
/** The model holds until the run is interrupted or released. */
export const stall: Step = Step.cases.Stall.make({})
/** A shell call that runs until the run is interrupted. */
export const shell = (input: { readonly id: string; readonly command: string; readonly description?: string }): Step => Step.cases.Shell.make(input)
/** A foreground shell call the shell tool runs until the test `exit`s it (or the run is interrupted). */
export const longShell = (input: { readonly id: string; readonly command: string }): Step => Step.cases.Shell.make({ ...input, started: true })
/** A foreground shell call that runs `command` and exits 0 with `output`, within its step. */
export const ranShell = (input: { readonly id: string; readonly command: string; readonly output: string }): Step =>
  Step.cases.Ran.make({ id: input.id, tool: "shell", target: input.command, output: input.output })
/** A read call of the text file at `path`, which holds `output`, within its step. */
export const ranRead = (input: { readonly id: string; readonly path: string; readonly output: string }): Step =>
  Step.cases.Ran.make({ id: input.id, tool: "read", target: input.path, output: input.output })
/** A background subagent call. */
export const subagent = (input: Omit<Subagent, "_tag">): Step => Step.cases.Subagent.make(input)

/** What a request to the model carries: the session, its agent and the prompt it answers. */
export interface Asked {
  readonly sessionID: string
  readonly text: string
  readonly step: number
  /** The user texts of the session's transcript, in order: what a chat-completions request carries. */
  readonly users: ReadonlyArray<string>
}
/** The scripted model: the steps of the next model step, given the prompt; none ends the run. */
export type Model = (asked: Asked) => ReadonlyArray<Step>

export interface Took {
  readonly at: number
  readonly method: string
  readonly path: string
  /** The request's body as it came, empty for none. */
  readonly body: string
}

/** The double's answer to a request: a response, or none for the fixture's own default. */
export type Handler = (url: URL, request: Request) => Promise<Option.Option<Response>>

/** A random source: an integer in [0, n). */
export type Draw = (n: number) => number

type Input = Readonly<Record<string, string | boolean>>
type Tokens = { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
type ErrorInfo = { readonly type: string; readonly message: string }

type ToolState =
  | { readonly status: "running"; readonly input: Input; readonly metadata: Readonly<Record<string, string>> }
  | { readonly status: "completed"; readonly input: Input; readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly metadata: Metadata }
  | { readonly status: "error"; readonly input: Input; readonly error: ErrorInfo }

interface TextPart {
  readonly type: "text"
  text: string
}
interface ReasoningPart {
  readonly type: "reasoning"
  text: string
  readonly time: { readonly created: number }
}
interface ToolPart {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly executed: boolean
  state: ToolState
  time: { readonly created: number; readonly ran: number; readonly completed?: number }
}
type Part = TextPart | ReasoningPart | ToolPart

interface AssistantMessage {
  readonly id: string
  readonly type: "assistant"
  time: { readonly created: number; readonly firstToken?: number; readonly streamed?: number; readonly completed?: number }
  readonly agent: string
  readonly model: ModelRef
  readonly content: Array<Part>
  finish?: string
  rawFinish?: string
  cost?: number
  tokens?: Tokens
  error?: ErrorInfo
}
interface UserMessage {
  readonly id: string
  readonly type: "user"
  readonly time: { readonly created: number }
  readonly text: string
}
interface IdleMessage {
  readonly id: string
  readonly type: "idle"
  readonly time: { readonly created: number }
  readonly outcome: "interrupted"
}
type Message = AssistantMessage | UserMessage | IdleMessage

type Delivery = "steer" | "queue"
interface Pending {
  readonly id: string
  readonly sessionID: string
  readonly time: { readonly created: number }
  readonly type: "user"
  readonly payload: { readonly text: string }
  delivery: Delivery
}

interface SessionTime {
  readonly created: number
  updated: number
  idle?: number
  busy?: number
  viewed?: number
}
interface SessionInfo {
  readonly id: string
  parentID?: string
  readonly projectID: string
  agent: string
  model: ModelRef
  readonly cost: number
  readonly tokens: Tokens
  readonly time: SessionTime
  title?: string
  readonly location: { readonly directory: string }
  outcome?: string
  revert?: { readonly messageID: string; readonly files: ReadonlyArray<string> }
}

/** A shell command as the server's registry holds it (schema/src/shell.ts `Info`). */
interface ShellInfo {
  readonly id: string
  status: "running" | "exited" | "killed"
  readonly command: string
  readonly cwd: string
  readonly shell: string
  readonly file: string
  readonly metadata: { readonly sessionID: string }
  time: { readonly started: number; completed?: number }
}

interface Running {
  readonly sessionID: string
  readonly prompt: string
  step: number
  message: AssistantMessage
  text: string
  hold: "none" | "stall" | "shell"
  shell: Option.Option<ToolPart>
}

/** The routes the fork's fixture (packages/tui/test/fixture/tui-client.ts) answers when the double does not. */
export const FIXTURE_ROUTES: ReadonlyArray<string> = [
  "/agent", "/command", "/experimental/workspace", "/experimental/workspace/status", "/formatter", "/lsp", "/config",
  "/experimental/resource", "/mcp", "/provider/auth", "/session/status", "/config/providers", "/experimental/console",
  "/experimental/capabilities", "/path", "/api/info", "/api/location", "/api/plugin", "/api/vcs", "/api/fs/list",
  "/api/project", "/api/worktree", "/api/worktree/refresh", "/api/shell", "/api/mcp", "/api/mcp/resource",
  "/api/config", "/api/permission/request", "/api/form", "/api/agent", "/api/model", "/api/provider",
  "/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/experimental/usage/limits",
  "/api/websearch/provider", "/provider", "/session", "/vcs", "/api/experimental/migration/v1", "/api/event",
]
const FIXTURE_PATTERNS = [/^\/api\/session\/[^/]+\/permission$/, /^\/api\/session\/[^/]+\/form$/, /^\/api\/experimental\/session\/[^/]+\/terminal$/]

/** A schema the double encodes through: every success and event schema of the client API needs no service. */
const isCodec = (schema: unknown): schema is Schema.Codec<unknown, unknown> => Schema.isSchema(schema)

interface Endpoint {
  readonly identifier: string
  readonly method: string
  readonly pattern: RegExp
  readonly params: ReadonlyArray<string>
  readonly success: Schema.Codec<unknown, unknown>
}
const endpoints: ReadonlyArray<Endpoint> = Object.values(ClientApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => {
    const route = String(endpoint.path)
    const params = Array.from(route.matchAll(/:(\w+)/g), (match) => match[1] ?? "")
    const pattern = new RegExp(`^${route.replace(/:\w+/g, "([^/]+)")}$`)
    const success = Arr.head(Arr.filter(Array.from(endpoint.success), isCodec)).pipe(Option.getOrElse((): Schema.Codec<unknown, unknown> => Schema.Void))
    return { identifier: endpoint.identifier, method: endpoint.method, pattern, params, success }
  }),
)
/** The client API's endpoint a request reaches, with its path parameters. */
export const endpointOf = (method: string, path: string) =>
  Arr.findFirst(endpoints, (endpoint) => endpoint.method === method && endpoint.pattern.test(path)).pipe(
    Option.map((endpoint) => {
      const match = Option.fromNullishOr(endpoint.pattern.exec(path)).pipe(Option.getOrElse((): ReadonlyArray<string> => []))
      return { endpoint, params: new Map(endpoint.params.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")])) }
    }),
  )

/**
 * A wire value through `schema` and back: it must decode as the client would read it, and what goes out is what
 * the schema encodes (a field the schema does not know is dropped, as the real server never sends one).
 */
const roundTrip = <A>(schema: Schema.Codec<unknown, unknown>, value: A) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(value).pipe(Effect.flatMap(Schema.encodeUnknownEffect(schema))))

const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)

/** The fields of a request body the double reads; any other is ignored, as the real server's decoder does with a field it has no use for. */
const Body = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  delivery: Schema.optionalKey(Schema.Literals(["steer", "queue"])),
  messageID: Schema.optionalKey(Schema.String),
  idle: Schema.optionalKey(Schema.Number),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Struct({ id: Schema.String, providerID: Schema.String, variant: Schema.optionalKey(Schema.String) })),
})
type Body = typeof Body.Type
const decodeBody = Schema.decodeUnknownExit(Schema.fromJsonString(Body))

/** The routes the double itself serves, by the client API's endpoint identifier; each is named by a client law. */
export const SERVED = [
  "session.list",
  "session.get",
  "session.active",
  "session.messages",
  "session.message",
  "session.inbox.list",
  "session.inbox.cancel",
  "session.inbox.update",
  "session.prompt",
  "session.interrupt",
  "session.wait",
  "session.revert.stage",
  "session.family.request.list",
  "rpc.call",
  "session.switchAgent",
  "session.switchModel",
  "session.view",
  "session.revert.commit",
  "agent.list",
  "model.list",
  "provider.list",
  "server.info",
  "shell.list",
] as const
export type Served = (typeof SERVED)[number]
const isServed = (identifier: string): identifier is Served => SERVED.some((each) => each === identifier)

/**
 * The catalog: the agents a fresh project has (build and plan, the general subagent, and the worker
 * the orchestrate plugin adds), and the one scripted model, as opencode-drive names it
 * (its default config's `simulation/gpt-sim-model`, which the real scenarios run on).
 */
export const MODEL_REF: ModelRef = { id: "gpt-sim-model", providerID: "simulation" }
const agent = (name: string, mode: Agent.Info["mode"]): Agent.Info => ({ ...Agent.Info.default(Agent.ID.make(name)), mode })
const AGENTS = [agent("build", "primary"), agent("plan", "primary"), agent("general", "subagent"), agent("worker", "subagent")]
const MODEL = { ...ModelInfo.Info.default(Provider.ID.make(MODEL_REF.providerID), ModelInfo.ID.make(MODEL_REF.id)), name: "Simulated Model", limit: { context: 128_000, output: 16_000 } }
const PROVIDER = { ...Provider.Info.empty(Provider.ID.make(MODEL_REF.providerID)), name: "Simulation" }
const sameModel = (a: ModelRef, b: ModelRef) => a.id === b.id && a.providerID === b.providerID && a.variant === b.variant

/** The server's info as the fixture answers it, but for a local build's version, as the real drive runs one (so the TUI's own build matches it). */
const INFO = { version: "local", pid: 0, urls: [], paths: { tmp: "/tmp" }, capabilities: { persistentPty: true } }
const catalogLocation = { directory: DIRECTORY, project: { id: PROJECT, directory: "/tmp/opencode", canonical: "/tmp/opencode" } }

/** The event kinds the double sends; each is named by a client law. */
export const EVENTS = [
  "session.created",
  "session.renamed",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.first-token",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.tool.input.started",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.revert.staged",
  "session.revert.committed",
  "session.agent.selected",
  "session.model.selected",
  "session.viewed",
  "shell.created",
  "shell.exited",
] as const
export type EventKind = (typeof EVENTS)[number]

/** An event before it is encoded. */
interface Wire<D> {
  readonly id: string
  readonly created: number
  readonly type: string
  readonly data: D
  location?: { readonly directory: string }
  durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
}

/** How a text or a reasoning part streams: its part, and the kinds of its start and its pieces. */
const STREAMS = {
  text: { started: "session.text.started", delta: "session.text.delta" },
  reasoning: { started: "session.reasoning.started", delta: "session.reasoning.delta" },
} as const

/** A step's finish: by whether it called a tool. */
const FINISHES = ["stop", "tool-calls"] as const

/** The wire's finish reason for a step's finish. */
const RAW_FINISH = { stop: "stop", "tool-calls": "tool_calls" } as const

/** An event as the double sends it: its wire form, as the client reads it. */
export type Sent = ClientEvent
/** A wire value that is an event of a kind the double sends, encoded by its schema. */
const isClientEvent = (value: unknown): value is ClientEvent =>
  Predicate.hasProperty(value, "type") && EVENTS.some((kind) => kind === value.type)

export interface Options {
  readonly draw: Draw
  readonly now: () => number
  readonly model: Model
}

/** A completed call's metadata, as far as the double fills it. */
type Metadata = Readonly<Record<string, string | number | boolean>>
type Answer = { readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly metadata: Metadata }
const textPart = (value: string) => ({ type: "text" as const, text: value })
/** A runtime as the fork's shell tool's header line says it (tool/plugin/shell.ts `seconds`; the double's calls run under two minutes). */
const seconds = (ms: number) => [`${(ms / 1_000).toFixed(1)} s`, `${Math.round(ms / 1_000)} s`][Number(ms >= 10_000)] ?? ""
/**
 * A foreground shell's answer once it exited 0 (tool/plugin/shell.ts `run`): its handle's header line and its
 * output, and the handle less its output, with the fields the host's shell row read before handles.
 */
const shellAnswer = (shellID: string, output: string, runtimeMs: number): Answer => ({
  content: [textPart(`${shellID} · exited 0 · ${seconds(runtimeMs)}`), textPart(output)],
  metadata: { id: shellID, state: "exited", exitCode: 0, runtimeMs, next: Buffer.byteLength(output), truncated: false, status: "completed", exit: 0 },
})
/** A read's answer for a whole text file (tool/plugin/read.ts `toModelContent`): a line naming the range, then each line numbered. */
const readAnswer = (path: string, output: string): Answer => {
  const lines = Arr.filter([output.replace(/\n$/, "")], (text) => text !== "").flatMap((text) => text.split("\n"))
  const range = [`Read file ${path}, 0 lines`, `Read file ${path}, lines 1-${lines.length}`][Number(lines.length > 0)] ?? ""
  return { content: [textPart([range, ...lines.map((line, index) => `${index + 1}: ${line}`)].join("\n"))], metadata: { truncated: false } }
}

const NO_CONTENT = 204
const response = (status: number, body: Option.Option<string>) =>
  HttpServerResponse.toWeb(
    Option.match(body, {
      onNone: () => HttpServerResponse.empty({ status }),
      onSome: (value) => HttpServerResponse.text(value, { status, contentType: "application/json" }),
    }),
  )
const noContent = () => response(NO_CONTENT, Option.none())
/** An error answer, as the real server's: a JSON body under its status. */
const failure = (status: number, tag: string, message: string, more: { readonly type?: string } = {}) => response(status, Option.some(toJson({ _tag: tag, ...more, message })))
/** The goal RPC's answer when the session has no goal. */
const NO_GOAL = '{"output":null}'
const notFound = (sessionID: string) => failure(404, "SessionNotFoundError", `Session not found: ${sessionID}`)
const finishOf = (finish: "stop" | "tool-calls") => RAW_FINISH[finish]

/** The double for one seed: its state, the requests it took and the events it queued for the TUI. */
export const make = (options: Options) => {
  const { draw, now } = options
  const sessions = new Map<string, SessionInfo>()
  const messages = new Map<string, Array<Message>>()
  const inbox = new Map<string, Array<Pending>>()
  const running = new Map<string, Running>()
  const waiters = new Map<string, Array<() => void>>()
  const outbox: Array<Sent> = []
  const requests: Array<Took> = []
  const unserved: Array<string> = []
  const held: Array<() => void> = []
  /**
   * Idle sessions a steer woke, whose run starts once the requests in flight now are answered: the real
   * server starts a woken run on a fiber of its own, so steers the client sends in the same breath (the
   * escape plugin switches every queued prompt to steer, one request each) are all in its first step.
   */
  const woken = new Set<string>()
  /** How each shell call the model started ended, in order. */
  const shellExits: Array<"killed"> = []
  /** The shell commands the shell tool started, by id, as the server's shell registry lists them. */
  const shells = new Map<string, ShellInfo>()
  const events: Array<string> = []
  const sequences = new Map<string, number>()
  // The sessions that chose their own agent and model, as the real server keeps them: a switch to the one
  // chosen says nothing. A session made with none (`own: false`, as a bare session.create makes one) says
  // so at every agent switch, and at its first model switch, even to the default.
  const chosen = new Set<string>()
  /** Answers and events the fork's schemas refused: each fails the test's next step. */
  const broken: Array<string> = []
  const state = { silent: false, inflight: 0, parked: 0, titles: (prompt: string) => prompt.split(/\s+/).slice(0, 3).join(" ").toLowerCase() }
  const location = { directory: DIRECTORY }

  /**
   * Ids as the real server and the client draw them (the fork's Identifier: the virtual time and a
   * counter, then random characters the harness draws from the seed), so the double's ids and the
   * client's sort together by time as real ones do; sessions sort newest first.
   */
  const id = (prefix: string) => `${prefix}_${Identifier.create(prefix === "ses", now())}`

  /** Queues `type` about `sessionID` for the client; `located` events carry the session's location. */
  const emit = <D extends object>(type: EventKind, data: D, located = true) => {
    events.push(type)
    const found = Option.fromUndefinedOr(EventManifest.Server.get(type))
    if (Option.isNone(found)) return broken.push(`the server's event manifest has no ${type}`)
    const definition = found.value
    const event: Wire<D> = { id: id("evt"), created: now(), type, data }
    if (located) event.location = location
    // A durable event carries its place in its aggregate's log, as the real server's do (every durable event the double sends is a session's; the shell events are ephemeral).
    if (definition.durability === "durable" && Predicate.hasProperty(data, "sessionID") && Predicate.isString(data.sessionID)) {
      const seq = sequences.get(data.sessionID) ?? 0
      sequences.set(data.sessionID, seq + 1)
      event.durable = { aggregateID: data.sessionID, seq, version: definition.durable.version }
    }
    if (!isCodec(definition)) return broken.push(`the event ${type} has no schema`)
    const encoded = roundTrip(definition, event)
    if (Exit.isFailure(encoded)) return broken.push(`the event ${type} does not encode: ${String(encoded.cause)}`)
    const wire = encoded.value
    if (isClientEvent(wire)) return outbox.push(wire)
    return broken.push(`the event ${type} is no event the client reads`)
  }

  const touch = (sessionID: string, time: Partial<SessionTime>) => {
    const session = sessions.get(sessionID)
    if (session) Object.assign(session.time, time, { updated: now() })
  }

  /** Adds a session (a root, or a child under `parentID`) as the server holds it after `session.create`. */
  const session = (input: { readonly title?: string; readonly parentID?: string; readonly agent?: string; readonly own?: boolean } = {}) => {
    const sessionID = id("ses")
    if (input.own ?? true) {
      chosen.add(`${sessionID} agent`)
      chosen.add(`${sessionID} model`)
    }
    const info: SessionInfo = {
      id: sessionID,
      projectID: PROJECT,
      // A session starts on the default agent and the scripted model, as the real drive's does: the
      // TUI's switch to them before a prompt changes nothing and shows no "Switched" row.
      agent: input.agent ?? "build",
      model: MODEL_REF,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now(), updated: now() },
      location,
    }
    if (input.parentID) info.parentID = input.parentID
    if (input.title) info.title = input.title
    sessions.set(sessionID, info)
    messages.set(sessionID, [])
    inbox.set(sessionID, [])
    return sessionID
  }

  const list = (sessionID: string): Array<Message> => {
    const found = messages.get(sessionID) ?? []
    messages.set(sessionID, found)
    return found
  }
  const pending = (sessionID: string): Array<Pending> => inbox.get(sessionID) ?? []

  const startStep = (run: Running) => {
    const steps = options.model({ sessionID: run.sessionID, text: run.prompt, step: run.step, users: userTexts(run.sessionID) })
    if (steps.length === 0) return finish(run)
    const info = Option.fromUndefinedOr(sessions.get(run.sessionID))
    const agentName = Option.match(info, { onNone: () => "build", onSome: (each) => each.agent })
    const model = Option.match(info, { onNone: () => MODEL_REF, onSome: (each) => each.model })
    const message: AssistantMessage = { id: id("msg"), time: { created: now(), firstToken: now() }, type: "assistant", agent: agentName, model, content: [] }
    run.message = message
    run.text = ""
    list(run.sessionID).push(message)
    emit("session.step.started", { sessionID: run.sessionID, agent: agentName, model, assistantMessageID: message.id, started: now() })
    emit("session.step.first-token", { sessionID: run.sessionID, assistantMessageID: message.id })
    return play(run, steps)
  }

  /** Streams `value` as a new part of `kind`, in pieces the seed cuts. */
  const streamText = (run: Running, value: string, part: TextPart | ReasoningPart) => {
    const kinds = STREAMS[part.type]
    run.message.content.push(part)
    const ordinal = run.message.content.length - 1
    const ref = { sessionID: run.sessionID, assistantMessageID: run.message.id, ordinal }
    emit(kinds.started, ref)
    for (let rest = value; rest.length > 0; ) {
      const size = 1 + draw(rest.length)
      const delta = rest.slice(0, size)
      rest = rest.slice(size)
      part.text = `${part.text}${delta}`
      emit(kinds.delta, { ...ref, delta })
    }
    if (part.type === "text") run.text = part.text
  }

  const endText = (run: Running) => {
    const ordinal = run.message.content.findLastIndex((part) => part.type === "text")
    if (ordinal >= 0 && run.text !== "") emit("session.text.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, ordinal, text: run.text })
  }

  const toolPart = (id: string, name: string, input: Input): ToolPart => ({
    type: "tool",
    id,
    name,
    executed: false,
    state: { status: "running", input, metadata: {} },
    time: { created: now(), ran: now() },
  })

  /** The tool call's input and call events, the part already on the message. */
  const called = (run: Running, part: ToolPart, input: Input) => {
    const ref = { sessionID: run.sessionID, assistantMessageID: run.message.id, id: part.id }
    emit("session.tool.input.started", { ...ref, name: part.name })
    emit("session.tool.input.ended", { ...ref, text: toJson(input) })
    emit("session.tool.called", { ...ref, input, executed: false })
  }

  /** Plays `steps`; returns once the step holds (a stall, a shell) or the run went on past it. */
  const play = (run: Running, steps: ReadonlyArray<Step>): void => {
    // A tool call's id is the script's, made the message's own: the TUI keeps state by call id,
    // so a seed never meets the call of a seed before it in the same app.
    const own = (id: string) => `${id}_${run.message.id.slice(-8)}`
    for (const step of steps) {
      if (step._tag === "Text") streamText(run, step.text, { type: "text", text: "" })
      if (step._tag === "Reasoning") streamText(run, step.text, { type: "reasoning", text: "", time: { created: now() } })
      if (step._tag === "Stall") {
        run.hold = "stall"
        return
      }
      if (step._tag === "Ran") ran(run, { ...step, id: own(step.id) })
      if (step._tag === "Shell") {
        const input = Option.match(Option.fromUndefinedOr(step.description), {
          onNone: () => ({ command: step.command }),
          onSome: (description) => ({ command: step.command, description }),
        })
        const part = toolPart(own(step.id), "shell", input)
        run.message.content.push(part)
        called(run, part, input)
        endText(run)
        emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
        // The shell tool's own run names its shell as it starts; a controller's hold starts none.
        if (step.started === true) startShell(run, part, step.command)
        run.hold = "shell"
        run.shell = Option.some(part)
        return
      }
      if (step._tag === "Subagent") spawn(run, { ...step, id: own(step.id) })
    }
    endStep(run, FINISHES[Number(steps.some(callsTool))] ?? "stop")
  }

  /**
   * The shell tool starts `part`'s command: the registry lists it (`shell.created`), and the call names it
   * (`session.tool.progress`), as tool/plugin/shell.ts does. Returns the shell's id.
   */
  const startShell = (run: Running, part: ToolPart, command: string) => {
    const info: ShellInfo = {
      id: id("sh"),
      status: "running",
      command,
      cwd: DIRECTORY,
      shell: "/bin/sh",
      file: `/tmp/opencode/shell/${part.id}.out`,
      metadata: { sessionID: run.sessionID },
      time: { started: now() },
    }
    shells.set(info.id, info)
    emit("shell.created", { info })
    part.state = { status: "running", input: part.state.input, metadata: { sessionID: run.sessionID, shellID: info.id } }
    emit("session.tool.progress", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: part.id, metadata: part.state.metadata })
    return info.id
  }

  /**
   * The shell `shellID` exits 0; the registry says so (`shell.exited`) and lists it no more, even asked for
   * the exited ones, as real OpenCode lists an ended foreground shell (the shell law).
   */
  const exitShell = (shellID: string) =>
    Option.map(Option.fromUndefinedOr(shells.get(shellID)), () => {
      shells.delete(shellID)
      emit("shell.exited", { id: shellID, status: "exited", exit: 0 })
    })

  /** The shell `shellID` is killed, its call cut; the registry says so (`shell.exited`). */
  const killShell = (shellID: string) =>
    Option.map(Option.fromUndefinedOr(shells.get(shellID)), (info) => {
      Object.assign(info, { status: "killed", time: { ...info.time, completed: now() } })
      emit("shell.exited", { id: shellID, status: "killed" })
    })

  /** The id of the shell `part`'s call started, if it started one. */
  const shellOf = (part: ToolPart) =>
    Option.some(part.state).pipe(
      Option.filter((state): state is Extract<ToolState, { readonly status: "running" }> => state.status === "running"),
      Option.flatMap((state) => Option.fromUndefinedOr(state.metadata.shellID)),
    )

  /** The call's answer: its part completed and its success sent. */
  const answered = (run: Running, part: ToolPart, answer: Answer) => {
    part.state = { status: "completed", input: part.state.input, ...answer }
    part.time = { ...part.time, completed: now() }
    emit("session.tool.success", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: part.id, ...answer, executed: false })
  }

  /** A call that runs and answers within its step, as the fork's tool does: a shell names its shell as it starts. */
  const ran = (run: Running, step: typeof Step.cases.Ran.Type) => {
    const input = { [{ shell: "command", read: "path" }[step.tool]]: step.target }
    const part = toolPart(step.id, step.tool, input)
    run.message.content.push(part)
    called(run, part, input)
    if (step.tool === "read") return answered(run, part, readAnswer(step.target, step.output))
    const shellID = startShell(run, part, step.target)
    exitShell(shellID)
    answered(run, part, shellAnswer(shellID, step.output, now() - part.time.ran))
  }

  const spawn = (run: Running, step: Subagent) => {
    const part = toolPart(step.id, "subagent", step.input)
    run.message.content.push(part)
    called(run, part, step.input)
    const ref = { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id }
    emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
    const child = session({ title: step.title, parentID: run.sessionID, agent: step.agent })
    const info = sessions.get(child)
    if (info) info.model = step.model
    emit("session.created", { sessionID: child, slug: "sim-child", version: "unknown", projectID: PROJECT, location, parentID: run.sessionID })
    emit("session.tool.progress", { ...ref, metadata: { sessionID: child, status: "running" } })
    const content = [{ type: "text" as const, text: `The subagent is working in the background (sessionID: ${child}).` }]
    const metadata = { sessionID: child, status: "running", truncated: false }
    part.state = { status: "completed", input: step.input, content, metadata }
    part.time = { ...part.time, completed: now() }
    enqueue(child, `You are a subagent spawned by another session.\n${String(step.input.prompt ?? "")}`, "steer")
    emit("session.tool.success", { ...ref, content, metadata, executed: false })
  }

  const endStep = (run: Running, finished: "stop" | "tool-calls") => {
    endText(run)
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    run.message.time = { ...run.message.time, streamed: now(), completed: now() }
    Object.assign(run.message, { finish: finished, rawFinish: finishOf(finished), cost: 0, tokens })
    emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
    emit("session.step.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, finish: finished, rawFinish: finishOf(finished), tokens, cost: 0 })
    run.step += 1
    // A steer waiting in the inbox goes into the next step.
    for (const item of pending(run.sessionID).filter((each) => each.delivery === "steer")) deliver(item)
    startStep(run)
  }

  const finish = (run: Running) => {
    running.delete(run.sessionID)
    emit("session.execution.succeeded", { sessionID: run.sessionID }, false)
    touch(run.sessionID, { idle: now() })
    // As core's projector records the run's end (session/projector.ts projectIdle).
    const info = sessions.get(run.sessionID)
    if (info) info.outcome = "succeeded"
    settled(run.sessionID)
    if (pending(run.sessionID).length > 0) start(run.sessionID)
  }

  const settled = (sessionID: string) => {
    for (const wake of waiters.get(sessionID) ?? []) wake()
    waiters.delete(sessionID)
  }

  const deliver = (item: Pending) => {
    inbox.set(
      item.sessionID,
      pending(item.sessionID).filter((each) => each.id !== item.id),
    )
    emit("session.inbox.delivered", { sessionID: item.sessionID, inboxID: item.id })
    list(item.sessionID).push({ id: item.id, time: { created: now() }, text: item.payload.text, type: "user" })
  }

  const start = (sessionID: string) => {
    const items = pending(sessionID)
    Option.map(Arr.head(items), (first) => {
      emit("session.execution.started", { sessionID }, false)
      touch(sessionID, { busy: now() })
      const delivered = items.filter((item) => item.delivery === "steer" || item === first)
      for (const item of delivered) deliver(item)
      const placeholder: AssistantMessage = { id: "", type: "assistant", time: { created: now() }, agent: "build", model: MODEL_REF, content: [] }
      const run: Running = { sessionID, prompt: delivered.map((item) => item.payload.text).join("\n"), step: 0, message: placeholder, text: "", hold: "none", shell: Option.none() }
      running.set(sessionID, run)
      const info = sessions.get(sessionID)
      if (info && !info.title && !info.parentID) {
        const title = state.titles(first.payload.text)
        info.title = title
        emit("session.renamed", { sessionID, title })
      }
      startStep(run)
    })
  }

  /** Commits a staged revert (core's SessionRevert.commit): the messages from the reverted one on go. */
  const commitRevert = (sessionID: string) => {
    const info = sessions.get(sessionID)
    if (!info?.revert) return
    const { messageID } = info.revert
    const kept = list(sessionID)
    const at = kept.findIndex((message) => message.id === messageID)
    if (at >= 0) kept.splice(at)
    delete info.revert
    emit("session.revert.committed", { sessionID, to: messageID })
  }

  const enqueue = (sessionID: string, prompt: string, delivery: Delivery, given = "") => {
    // A prompt on a session with a staged revert commits it first (core's Session.prompt).
    commitRevert(sessionID)
    // The client draws the prompt's id (it sends `id`); the server keeps it.
    const item: Pending = { id: given || id("msg"), sessionID, time: { created: now() }, type: "user", payload: { text: prompt }, delivery }
    inbox.set(sessionID, [...pending(sessionID), item])
    emit("session.inbox.enqueued", { inboxID: item.id, sessionID, item: { type: "user", payload: item.payload, delivery } })
    if (!running.has(sessionID)) start(sessionID)
    return item
  }

  const interrupt = (sessionID: string, resume: boolean) => {
    const found = Option.fromUndefinedOr(running.get(sessionID))
    if (Option.isNone(found)) return false
    const run = found.value
    running.delete(sessionID)
    const error = { type: "aborted", message: "Step interrupted" }
    Option.match(run.shell, {
      onNone: () => {
        endText(run)
        emit("session.step.streamed", { sessionID, assistantMessageID: run.message.id })
      },
      onSome: (part) => {
        // As core settles a tool call the interrupt cut (SessionRunner.settleStaleToolCalls): aborted, with no output.
        shellExits.push("killed")
        Option.map(shellOf(part), killShell)
        const cut = { type: "aborted", message: "Tool execution interrupted: shell" }
        part.state = { status: "error", input: part.state.input, error: cut }
        part.time = { ...part.time, completed: now() }
        emit("session.tool.failed", { sessionID, assistantMessageID: run.message.id, id: part.id, error: cut, executed: false })
      },
    })
    run.message.time = { ...run.message.time, streamed: now(), completed: now() }
    Object.assign(run.message, { finish: "error", error })
    emit("session.step.failed", { sessionID, assistantMessageID: run.message.id, error })
    list(sessionID).push({ id: id("msg"), time: { created: now() }, type: "idle", outcome: "interrupted" })
    emit("session.execution.interrupted", { sessionID, reason: "user" }, false)
    touch(sessionID, { idle: now() })
    const info = sessions.get(sessionID)
    if (info) info.outcome = "interrupted"
    settled(sessionID)
    if (resume && pending(sessionID).some((item) => item.delivery === "steer")) start(sessionID)
    return true
  }

  /** A success answer of `identifier`, encoded through its schema. */
  const json = <A>(identifier: Served, body: A) =>
    Option.match(
      Arr.findFirst(endpoints, (endpoint) => endpoint.identifier === identifier),
      {
        onNone: noContent,
        onSome: (found) => {
          const encoded = roundTrip(found.success, body)
          if (Exit.isSuccess(encoded)) return response(200, Option.some(toJson(encoded.value)))
          broken.push(`${identifier} answers what its schema refuses: ${String(encoded.cause)}`)
          return failure(500, "SimTuiDoubleError", String(encoded.cause))
        },
      },
    )

  const ordered = (sessionID: string) => list(sessionID).toReversed()
  const family = (sessionID: string): ReadonlyArray<string> => [
    sessionID,
    ...Array.from(sessions.values()).filter((each) => each.parentID === sessionID).flatMap((each) => family(each.id)),
  ]

  const view = (sessionID: string, info: SessionInfo, idle: number) => {
    // As core's Session.view: marks an idle the session has had, never past it and never back.
    const had = info.time.idle ?? -1
    const viewed = info.time.viewed ?? -1
    if (had < 0 || idle > had || viewed >= idle) return noContent()
    info.time.viewed = idle
    emit("session.viewed", { sessionID, idle })
    return noContent()
  }

  const switchTo = (identifier: "session.switchAgent" | "session.switchModel", info: SessionInfo, body: Body) => {
    const sessionID = info.id
    const previousAgent = info.agent
    const previousModel = info.model
    if (identifier === "session.switchAgent")
      Option.map(
        Option.fromUndefinedOr(body.agent).pipe(Option.filter((next) => next !== previousAgent || !chosen.has(`${sessionID} agent`))),
        (next) => {
          info.agent = next
          emit("session.agent.selected", { sessionID, agent: next, previous: previousAgent })
        },
      )
    if (identifier === "session.switchModel")
      Option.map(
        Option.fromUndefinedOr(body.model).pipe(Option.filter((next) => !sameModel(next, previousModel) || !chosen.has(`${sessionID} model`))),
        (next) => {
          info.model = next
          chosen.add(`${sessionID} model`)
          emit("session.model.selected", { sessionID, model: next, previous: previousModel })
        },
      )
    return noContent()
  }

  const update = (sessionID: string, inboxID: string, delivery: Delivery) => {
    const item = pending(sessionID).find((each) => each.id === inboxID)
    if (!item) return failure(409, "ConflictError", `No pending inbox item ${inboxID}`)
    if (item.delivery !== delivery) {
      item.delivery = delivery
      emit("session.inbox.delivery.changed", { sessionID, inboxID, delivery })
    }
    // Steering wakes an idle session's execution (once the requests in flight are answered); a running one takes the steer at its next step.
    if (delivery === "steer" && !running.has(sessionID)) woken.add(sessionID)
    return noContent()
  }

  /** The user texts of the session's transcript, in order. */
  const userTexts = (sessionID: string): ReadonlyArray<string> =>
    list(sessionID)
      .filter((message): message is UserMessage => message.type === "user")
      .map((message) => message.text)

  /** Starts the run of each session a steer woke. */
  const wake = () => {
    const due = Array.from(woken)
    woken.clear()
    for (const sessionID of due) if (!running.has(sessionID)) start(sessionID)
  }

  const withSession = (sessionID: string, serve: (info: SessionInfo) => Response) =>
    Option.match(Option.fromUndefinedOr(sessions.get(sessionID)), { onNone: () => notFound(sessionID), onSome: serve })

  /** A long poll: parked until the run settles, so it does not keep the harness from resting. */
  const wait = (sessionID: string) =>
    Effect.callback<Response>((resume) => {
      state.parked += 1
      waiters.set(sessionID, [
        ...(waiters.get(sessionID) ?? []),
        () => {
          state.parked -= 1
          resume(Effect.succeed(noContent()))
        },
      ])
    })

  /** A request the double serves: its path parameters, its query and its body. */
  interface Call {
    readonly sessionID: string
    readonly params: ReadonlyMap<string, string>
    readonly query: URLSearchParams
    readonly body: Body
  }
  const now204 = () => Effect.succeed(noContent())
  const routes = {
    "session.list": () =>
      Effect.succeed(json("session.list", { data: Array.from(sessions.values()).toSorted((a, b) => Number(a.id > b.id) - Number(a.id < b.id)), cursor: {} })),
    "session.get": ({ sessionID }) => Effect.succeed(withSession(sessionID, (info) => json("session.get", { data: info }))),
    "session.active": () => Effect.succeed(json("session.active", { data: Object.fromEntries(Array.from(running.keys(), (each) => [each, { type: "running" }])) })),
    "session.messages": ({ sessionID }) => Effect.succeed(json("session.messages", { data: ordered(sessionID), cursor: {} })),
    "session.message": ({ sessionID, params }) => {
      const messageID = params.get("messageID") ?? ""
      return Effect.succeed(
        Option.match(Arr.findFirst(list(sessionID), (message) => message.id === messageID), {
          onNone: () => failure(404, "MessageNotFoundError", `Message not found: ${messageID}`),
          onSome: (found) => json("session.message", { data: found }),
        }),
      )
    },
    "session.inbox.list": ({ sessionID }) => Effect.succeed(json("session.inbox.list", { data: pending(sessionID) })),
    "session.inbox.cancel": ({ sessionID, params }) => {
      const inboxID = params.get("inboxID") ?? ""
      if (pending(sessionID).some((item) => item.id === inboxID)) {
        inbox.set(
          sessionID,
          pending(sessionID).filter((item) => item.id !== inboxID),
        )
        emit("session.inbox.cancelled", { sessionID, inboxID })
      }
      return now204()
    },
    "session.inbox.update": ({ sessionID, params, body }) => Effect.succeed(update(sessionID, params.get("inboxID") ?? "", body.delivery ?? "steer")),
    "session.prompt": ({ sessionID, body }) => Effect.succeed(json("session.prompt", { data: enqueue(sessionID, body.text ?? "", body.delivery ?? "steer", body.id ?? "") })),
    "session.interrupt": ({ sessionID, query }) => Effect.succeed(json("session.interrupt", { interrupted: interrupt(sessionID, query.get("resume") !== "false") })),
    "session.wait": ({ sessionID }) => {
      if (!running.has(sessionID)) return now204()
      return wait(sessionID)
    },
    "session.revert.stage": ({ sessionID, body }) => {
      const revert = { messageID: body.messageID ?? "", files: [] }
      const info = sessions.get(sessionID)
      if (info) info.revert = revert
      emit("session.revert.staged", { sessionID, revert })
      return Effect.succeed(json("session.revert.stage", { data: revert }))
    },
    "session.family.request.list": ({ sessionID }) => Effect.succeed(json("session.family.request.list", { data: { sessions: family(sessionID), permissions: [], forms: [] } })),
    "session.switchAgent": ({ sessionID, body }) => Effect.succeed(withSession(sessionID, (info) => switchTo("session.switchAgent", info, body))),
    "session.switchModel": ({ sessionID, body }) => Effect.succeed(withSession(sessionID, (info) => switchTo("session.switchModel", info, body))),
    "session.revert.commit": ({ sessionID }) =>
      Effect.succeed(
        withSession(sessionID, () => {
          if (running.has(sessionID)) return failure(409, "SessionBusyError", `Session is busy: ${sessionID}`)
          commitRevert(sessionID)
          return noContent()
        }),
      ),
    "session.view": ({ sessionID, body }) => Effect.succeed(withSession(sessionID, (info) => view(sessionID, info, body.idle ?? -1))),
    // The running shells; with `exited=true`, the ended ones too (server/src/handlers/shell.ts).
    "shell.list": ({ query }) =>
      Effect.succeed(json("shell.list", { location: catalogLocation, data: Array.from(shells.values()).filter((info) => info.status === "running" || query.get("exited") === "true") })),
    "agent.list": () => Effect.succeed(json("agent.list", { location: catalogLocation, data: AGENTS })),
    "model.list": () => Effect.succeed(json("model.list", { location: catalogLocation, data: [MODEL] })),
    "provider.list": () => Effect.succeed(json("provider.list", { location: catalogLocation, data: [PROVIDER] })),
    "server.info": () => Effect.succeed(json("server.info", INFO)),
    // No plugin of ours runs on the double's server: an RPC to one fails as the real server's does with none loaded (400, rpc.unavailable); the goal RPC answers no goal.
    "rpc.call": ({ params }) => {
      if (params.get("rpcID") === "opencode.goal") return Effect.succeed(response(200, Option.some(NO_GOAL)))
      const rpcID = params.get("rpcID") ?? ""
      return Effect.succeed(failure(400, "RpcError", `RPC is unavailable: ${rpcID}`, { type: "rpc.unavailable" }))
    },
  } satisfies { readonly [K in Served]: (call: Call) => Effect.Effect<Response> }

  /** Any request while silent: held open until `answer`, then a 503. */
  const hold = Effect.callback<Response>((resume) => {
    state.parked += 1
    held.push(() => {
      state.parked -= 1
      resume(Effect.succeed(response(503, Option.none())))
    })
  })

  /** A request's body as text: none for a GET or a DELETE. */
  const bodyOf = (raw: Request) => {
    if (raw.method === "GET" || raw.method === "DELETE") return Effect.succeed("")
    return Effect.promise(() => raw.text())
  }

  /** What the double does with `raw`: its answer, held open while silent. */
  const served = (route: Served, call: Call) => {
    if (state.silent) return hold
    return Effect.suspend(() => routes[route](call))
  }

  const answer = Effect.fn("SimTuiDouble.answer")(function* (url: URL, raw: Request) {
    const found = endpointOf(raw.method, url.pathname).pipe(
      Option.flatMap(({ endpoint, params }) => Option.map(Option.liftPredicate(endpoint.identifier, isServed), (route) => ({ route, params }))),
    )
    if (Option.isNone(found)) {
      if (url.pathname === "/api/event") return Option.none()
      if (FIXTURE_ROUTES.includes(url.pathname) || FIXTURE_PATTERNS.some((pattern) => pattern.test(url.pathname))) return Option.none()
      unserved.push(`${raw.method} ${url.pathname}`)
      return Option.some(failure(501, "SimTuiUnservedError", `the double does not serve ${raw.method} ${url.pathname}`))
    }
    const { route, params } = found.value
    const text = yield* bodyOf(raw)
    const body = Exit.match(decodeBody(text || "{}"), {
      onSuccess: (value): Body => value,
      onFailure: (): Body => {
        broken.push(`${raw.method} ${url.pathname}: a body the double cannot read: ${text}`)
        return {}
      },
    })
    requests.push({ at: now(), method: raw.method, path: url.pathname, body: text })
    state.inflight += 1
    const call: Call = { sessionID: params.get("sessionID") ?? "", params, query: url.searchParams, body }
    const result = yield* served(route, call).pipe(Effect.ensuring(Effect.sync(() => (state.inflight -= 1))))
    return Option.some(result)
  })

  /** The fetch handler the fixture calls first: the double's answer, or none for the fixture's own defaults. */
  const fetch: Handler = (url, raw) => Effect.runPromise(answer(url, raw))

  return {
    fetch,
    session,
    enqueue,
    interrupt,
    /** Ends a stalled step: the rest of the model's text (its first, if the step had none yet), then the run goes on. */
    release: (sessionID: string, rest = "") => {
      const found = Option.fromUndefinedOr(running.get(sessionID)).pipe(Option.filter((run) => run.hold === "stall"))
      if (Option.isNone(found)) return
      const run = found.value
      run.hold = "none"
      const ordinal = run.message.content.findLastIndex((part) => part.type === "text")
      const part = run.message.content[ordinal]
      if (rest !== "" && part?.type === "text") {
        part.text = `${part.text}${rest}`
        run.text = part.text
        emit("session.text.delta", { sessionID, assistantMessageID: run.message.id, ordinal, delta: rest })
      }
      if (rest !== "" && part?.type !== "text") streamText(run, rest, { type: "text", text: "" })
      endStep(run, "stop")
    },
    /** Ends a held shell call: it exits 0 with `output` (its runtime the virtual time it ran), and the run goes on. */
    exit: (sessionID: string, output: string) => {
      const found = Option.fromUndefinedOr(running.get(sessionID)).pipe(Option.filter((run) => run.hold === "shell"))
      if (Option.isNone(found)) return
      const run = found.value
      Option.map(run.shell, (part) => {
        const named = shellOf(part)
        Option.map(named, exitShell)
        answered(run, part, shellAnswer(Option.getOrElse(named, () => id("sh")), output, now() - part.time.ran))
      })
      run.hold = "none"
      run.shell = Option.none()
      endStep(run, "tool-calls")
    },
    /** The server stops answering: requests from now on stay open until `answer`. */
    silence: () => {
      state.silent = true
    },
    answer: () => {
      state.silent = false
      for (const wake of held.splice(0)) wake()
    },
    retitle: (namer: (prompt: string) => string) => {
      state.titles = namer
    },
    /** The events to send the client now: none while silent (the stream stalls with the rest). */
    take: (): ReadonlyArray<Sent> => {
      if (state.silent) return []
      if (state.inflight === state.parked) wake()
      return outbox.splice(0)
    },
    /** Whether the double owes the client anything it will send without time moving. */
    busy: () => state.inflight - state.parked > 0 || (!state.silent && (outbox.length > 0 || woken.size > 0)),
    /** How many requests the double holds open on purpose: the harness does not wait on them. */
    parked: () => state.parked,
    /** What the double still owes, for a message. */
    owed: () => `${state.inflight - state.parked} requests in flight, ${outbox.length * Number(!state.silent)} events unsent`,
    /** The seed ends: every parked request is answered (503) and every long poll woken, so none outlives its seed. */
    close: () => {
      state.silent = false
      woken.clear()
      // A session left running would stay running in the client's store past its seed, and the
      // store's backstop recheck would read it again in a later seed: each one ends here.
      for (const sessionID of Array.from(running.keys())) {
        running.delete(sessionID)
        emit("session.execution.succeeded", { sessionID }, false)
      }
      for (const wake of held.splice(0)) wake()
      for (const sessionID of Array.from(waiters.keys())) settled(sessionID)
    },
    shellExits: (): ReadonlyArray<"killed"> => shellExits,
    requests: (): ReadonlyArray<Took> => requests,
    unserved: (): ReadonlyArray<string> => unserved,
    broken: (): ReadonlyArray<string> => broken,
    events: (): ReadonlyArray<string> => events,
    running: (sessionID: string) => running.has(sessionID),
    /** The child sessions of `sessionID`, oldest first. */
    children: (sessionID: string) => Array.from(sessions.values()).filter((each) => each.parentID === sessionID).map((each) => each.id),
    messages: (sessionID: string): ReadonlyArray<Message> => list(sessionID),
    inbox: (sessionID: string): ReadonlyArray<Pending> => pending(sessionID),
    info: (sessionID: string) => Option.fromUndefinedOr(sessions.get(sessionID)),
  }
}
export type Double = ReturnType<typeof make>
