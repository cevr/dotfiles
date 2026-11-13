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
// - `silent`: the double stops answering (the requests stay open) while time moves.
//
// Ids are the fork's own (Identifier) on the virtual clock, their random part drawn
// from the seed by the harness; times are the virtual clock's.
import { Schema } from "effect"
import { ClientApi } from "@opencode/protocol/client"
import { EventManifest } from "@opencode/schema/event-manifest"
import { Agent } from "@opencode/schema/agent"
import { Identifier } from "@opencode/schema/identifier"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

/** The fixture's location (the fork's tui-client.ts `directory` and project). */
export const DIRECTORY = "/tmp/opencode/packages/tui"
export const PROJECT = "proj_test"

/** One thing the scripted model does in a step. */
export type Step =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Reasoning"; readonly text: string }
  /** The model holds here until the run is interrupted (or `release`d). */
  | { readonly _tag: "Stall" }
  /** A shell call a controller holds (opencode-drive's `tools.control`, as the scenarios run it) until the run is interrupted. */
  | { readonly _tag: "Shell"; readonly id: string; readonly command: string; readonly description: string }
  /** A background subagent call: a child session starts on `input.prompt`; the model answers it as any session (by `Asked.sessionID`). */
  | {
      readonly _tag: "Subagent"
      readonly id: string
      readonly input: Readonly<Record<string, string | boolean>>
      readonly title: string
      readonly agent: string
      readonly model: { readonly id: string; readonly providerID: string }
    }

/** What a request to the model carries: the session, its agent and the prompt it answers. */
export interface Asked {
  readonly sessionID: string
  readonly text: string
  readonly step: number
}
/** The scripted model: the steps of the next model step, given the prompt, or none to end the run. */
export type Model = (asked: Asked) => ReadonlyArray<Step> | undefined

export interface Took {
  readonly at: number
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

/** The fixture's fetch hook: an answer, or undefined for the fixture's own default. */
export type Handler = (url: URL, request: Request) => Promise<Response | undefined>

/** A random source: an integer in [0, n). */
export type Draw = (n: number) => number

type Json = Record<string, unknown>
type Message = Json & { readonly id: string; readonly type: string }
interface Pending {
  readonly id: string
  readonly sessionID: string
  readonly time: { readonly created: number }
  readonly type: "user"
  readonly payload: { readonly text: string }
  delivery: "steer" | "queue"
}
interface Running {
  readonly sessionID: string
  readonly prompt: string
  step: number
  message: Message & { content: Array<Json> }
  text: string
  hold?: "stall" | "shell"
  shell?: { readonly toolID: string; readonly part: Json }
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

interface Endpoint {
  readonly identifier: string
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly params: ReadonlyArray<string>
  readonly success: Schema.Top
}
const endpoints: ReadonlyArray<Endpoint> = Object.values(ClientApi.groups).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => {
    const params = [...endpoint.path.matchAll(/:(\w+)/g)].map((match) => match[1] ?? "")
    const pattern = new RegExp(`^${endpoint.path.replace(/:\w+/g, "([^/]+)")}$`)
    const [success] = [...endpoint.success] as ReadonlyArray<Schema.Top>
    return { identifier: endpoint.identifier, method: endpoint.method, path: endpoint.path, pattern, params, success: success ?? Schema.Void }
  }),
)
/** The client API's endpoint a request reaches, with its path parameters. */
export const endpointOf = (method: string, path: string) => {
  for (const endpoint of endpoints) {
    if (endpoint.method !== method) continue
    const match = endpoint.pattern.exec(path)
    if (match) return { endpoint, params: Object.fromEntries(endpoint.params.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")])) }
  }
  return undefined
}
/**
 * A wire value through `schema` and back: it must decode as the client would read it, and what goes out is what
 * the schema encodes (a field the schema does not know is dropped, as the real server never sends one).
 */
const roundTrip = (schema: Schema.Top, value: unknown) =>
  Schema.encodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(value))

/** An event kind's newest definition in the server's manifest. */
const definitionOf = (type: string) => {
  const definition = EventManifest.Server.get(type)
  if (definition === undefined) throw new Error(`the server's event manifest has no ${type}`)
  return definition
}

/** The routes the double itself serves, by the client API's endpoint identifier; each is named by a client law. */
export const SERVED = [
  "session.list",
  "session.get",
  "session.active",
  "session.messages",
  "session.message",
  "session.inbox.list",
  "session.inbox.cancel",
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
] as const

/**
 * The catalog: the agents a fresh project has (build and plan, and the worker
 * the orchestrate plugin adds), and the one scripted model, as opencode-drive names it
 * (its default config's `simulation/gpt-sim-model`, which the real scenarios run on).
 */
export const MODEL_REF = { id: "gpt-sim-model", providerID: "simulation" } as const
const agent = (name: string, mode: Agent.Info["mode"]): Agent.Info => ({ ...Agent.Info.default(Agent.ID.make(name)), mode })
const AGENTS = [agent("build", "primary"), agent("plan", "primary"), agent("worker", "subagent")]
const MODEL = { ...Model.Info.default(Provider.ID.make(MODEL_REF.providerID), Model.ID.make(MODEL_REF.id)), name: "Simulated Model", limit: { context: 128_000, output: 16_000 } }
const PROVIDER = { ...Provider.Info.empty(Provider.ID.make(MODEL_REF.providerID)), name: "Simulation" }
/** `value` as JSON with its keys in order: two values the same but for key order read the same. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`
      : JSON.stringify(value)

/** The server's info as the fixture answers it, but for a local build's version, as the real drive runs one (so the TUI's own build matches it). */
const INFO = { version: "local", pid: 0, urls: [], paths: { tmp: "/tmp" }, capabilities: { persistentPty: true } }
const catalogLocation = { directory: DIRECTORY, project: { id: PROJECT, directory: "/tmp/opencode", canonical: "/tmp/opencode" } }
export type Served = (typeof SERVED)[number]

/** The event kinds the double sends; each is named by a client law. */
export const EVENTS = [
  "session.created",
  "session.renamed",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
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
] as const
export type EventKind = (typeof EVENTS)[number]

export interface Options {
  readonly draw: Draw
  readonly now: () => number
  readonly model: Model
}

/** The double for one seed: its state, the requests it took and the events it queued for the TUI. */
export const make = (options: Options) => {
  const { draw, now } = options
  const sessions = new Map<string, Json>()
  const messages = new Map<string, Array<Message>>()
  const inbox = new Map<string, Array<Pending>>()
  const running = new Map<string, Running>()
  const waiters = new Map<string, Array<() => void>>()
  const outbox: Array<Json> = []
  const requests: Array<Took> = []
  const unserved: Array<string> = []
  const held: Array<() => void> = []
  /** How each shell call the model started ended, in order. */
  const shellExits: Array<"killed"> = []
  const events: Array<string> = []
  let silent = false
  const location = { directory: DIRECTORY }

  /**
   * Ids as the real server and the client draw them (the fork's Identifier: the virtual time and a
   * counter, then random characters the harness draws from the seed), so the double's ids and the
   * client's sort together by time as real ones do; sessions sort newest first.
   */
  const id = (prefix: string) => `${prefix}_${Identifier.create(prefix === "ses", now())}`

  const emit = (type: EventKind, data: Json, located = true) => {
    const definition = definitionOf(type)
    // A durable event carries its place in its aggregate's log, as the real server's do.
    const durable =
      definition.durability === "durable"
        ? (() => {
            const aggregateID = String(data[definition.durable.aggregate] ?? "")
            const seq = sequences.get(aggregateID) ?? 0
            sequences.set(aggregateID, seq + 1)
            return { durable: { aggregateID, seq, version: definition.durable.version } }
          })()
        : {}
    const event = { id: id("evt"), created: now(), type, ...(located ? { location } : {}), data, ...durable }
    try {
      outbox.push(roundTrip(definition, event) as Json)
    } catch (cause) {
      broken.push(`the event ${type} does not encode: ${String(cause)}`)
    }
    events.push(type)
  }
  const sequences = new Map<string, number>()
  /** Answers and events the fork's schemas refused: each fails the test's next step. */
  const broken: Array<string> = []

  const touch = (sessionID: string, time: Json) => {
    const session = sessions.get(sessionID)
    if (session) sessions.set(sessionID, { ...session, time: { ...(session.time as Json), updated: now(), ...time } })
  }

  /** Adds a session (a root, or a child under `parentID`) as the server holds it after `session.create`. */
  const session = (input: { title?: string; parentID?: string; agent?: string } = {}) => {
    const sessionID = id("ses")
    const info: Json = {
      id: sessionID,
      ...(input.parentID ? { parentID: input.parentID } : {}),
      projectID: PROJECT,
      // A session starts on the default agent and the scripted model, as the real drive's does: the
      // TUI's switch to them before a prompt changes nothing and shows no "Switched" row.
      agent: input.agent ?? "build",
      model: MODEL_REF,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now(), updated: now() },
      ...(input.title ? { title: input.title } : {}),
      location,
    }
    sessions.set(sessionID, info)
    messages.set(sessionID, [])
    inbox.set(sessionID, [])
    return sessionID
  }

  const list = (sessionID: string) => messages.get(sessionID) ?? []

  const startStep = (run: Running) => {
    const steps = options.model({ sessionID: run.sessionID, text: run.prompt, step: run.step })
    if (steps === undefined) return finish(run)
    const session = sessions.get(run.sessionID)
    const agent = (session?.agent as string | undefined) ?? "build"
    const model = (session?.model as Json | undefined) ?? MODEL_REF
    const message: Message & { content: Array<Json> } = { id: id("msg"), time: { created: now(), firstToken: now() }, type: "assistant", agent, model, content: [] }
    run.message = message
    run.text = ""
    list(run.sessionID).push(message)
    emit("session.step.started", { sessionID: run.sessionID, agent, model, assistantMessageID: message.id, started: now() })
    emit("session.step.first-token", { sessionID: run.sessionID, assistantMessageID: message.id })
    play(run, steps, 0)
  }

  const streamText = (run: Running, text: string, kind: "text" | "reasoning") => {
    const part: Json = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: now() } }
    run.message.content.push(part)
    const ordinal = run.message.content.length - 1
    emit(`session.${kind}.started`, { sessionID: run.sessionID, assistantMessageID: run.message.id, ordinal })
    // The text arrives in pieces the seed cuts.
    let rest = text
    while (rest.length > 0) {
      const size = 1 + draw(rest.length)
      const delta = rest.slice(0, size)
      rest = rest.slice(size)
      part.text = `${part.text as string}${delta}`
      emit(`session.${kind}.delta`, { sessionID: run.sessionID, assistantMessageID: run.message.id, ordinal, delta })
    }
    if (kind === "text") run.text = part.text as string
    return ordinal
  }

  const endText = (run: Running) => {
    const ordinal = run.message.content.findLastIndex((part) => part.type === "text")
    if (ordinal >= 0 && run.text !== "") emit("session.text.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, ordinal, text: run.text })
  }

  const play = (run: Running, steps: ReadonlyArray<Step>, from: number): void => {
    for (let index = from; index < steps.length; index++) {
      const given = steps[index]
      if (given === undefined) continue
      // A tool call's id is the script's, made the message's own: the TUI keeps state by call id,
      // so a seed never meets the call of a seed before it in the same app.
      const step = "id" in given ? { ...given, id: `${given.id}_${String(run.message.id).slice(-8)}` } : given
      switch (step._tag) {
        case "Text":
          streamText(run, step.text, "text")
          break
        case "Reasoning":
          streamText(run, step.text, "reasoning")
          break
        case "Stall":
          run.hold = "stall"
          return
        case "Shell": {
          const input = { command: step.command, description: step.description }
          const part: Json = { type: "tool", id: step.id, name: "shell", executed: false, state: { status: "running", input, metadata: {} }, time: { created: now(), ran: now() } }
          run.message.content.push(part)
          emit("session.tool.input.started", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, name: "shell" })
          emit("session.tool.input.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, text: JSON.stringify(input) })
          emit("session.tool.called", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, input, executed: false })
          endText(run)
          emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
          run.hold = "shell"
          run.shell = { toolID: step.id, part }
          return
        }
        case "Subagent": {
          subagent(run, step)
          break
        }
      }
    }
    endStep(run, steps.some((step) => step._tag === "Subagent") ? "tool-calls" : "stop")
  }

  const subagent = (run: Running, step: Extract<Step, { _tag: "Subagent" }>) => {
    const part: Json = { type: "tool", id: step.id, name: "subagent", executed: false, state: { status: "running", input: step.input, metadata: {} }, time: { created: now(), ran: now() } }
    run.message.content.push(part)
    emit("session.tool.input.started", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, name: "subagent" })
    emit("session.tool.input.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, text: JSON.stringify(step.input) })
    emit("session.tool.called", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, input: step.input, executed: false })
    emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
    const child = session({ title: step.title, parentID: run.sessionID, agent: step.agent })
    const info = sessions.get(child)
    if (info) sessions.set(child, { ...info, model: step.model })
    emit("session.created", {
      sessionID: child,
      slug: "sim-child",
      version: "unknown",
      projectID: PROJECT,
      location,
      parentID: run.sessionID,
    })
    const metadata = { sessionID: child, status: "running" }
    emit("session.tool.progress", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, metadata })
    const content = [{ type: "text", text: `The subagent is working in the background (sessionID: ${child}).` }]
    part.state = { status: "completed", input: step.input, content, metadata: { ...metadata, truncated: false } }
    part.time = { ...(part.time as Json), completed: now() }
    const prompt = `You are a subagent spawned by another session.\n${String(step.input.prompt ?? "")}`
    enqueue(child, prompt, "steer")
    emit("session.tool.success", { sessionID: run.sessionID, assistantMessageID: run.message.id, id: step.id, content, metadata: { ...metadata, truncated: false }, executed: false })
  }

  const endStep = (run: Running, finish: "stop" | "tool-calls") => {
    endText(run)
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    run.message.time = { ...(run.message.time as Json), streamed: now(), completed: now() }
    Object.assign(run.message, { finish, rawFinish: finish === "stop" ? "stop" : "tool_calls", cost: 0, tokens })
    emit("session.step.streamed", { sessionID: run.sessionID, assistantMessageID: run.message.id })
    emit("session.step.ended", { sessionID: run.sessionID, assistantMessageID: run.message.id, finish, rawFinish: finish === "stop" ? "stop" : "tool_calls", tokens, cost: 0 })
    run.step += 1
    const steers = (inbox.get(run.sessionID) ?? []).filter((item) => item.delivery === "steer")
    if (steers.length > 0) {
      for (const item of steers) deliver(item)
      return startStep(run)
    }
    return startStep(run)
  }

  const finish = (run: Running) => {
    running.delete(run.sessionID)
    emit("session.execution.succeeded", { sessionID: run.sessionID }, false)
    touch(run.sessionID, { idle: now() })
    settled(run.sessionID)
    const next = (inbox.get(run.sessionID) ?? [])[0]
    if (next) start(run.sessionID)
  }

  const settled = (sessionID: string) => {
    for (const wake of waiters.get(sessionID) ?? []) wake()
    waiters.delete(sessionID)
  }

  const deliver = (item: Pending) => {
    const items = inbox.get(item.sessionID) ?? []
    inbox.set(item.sessionID, items.filter((each) => each.id !== item.id))
    emit("session.inbox.delivered", { sessionID: item.sessionID, inboxID: item.id })
    list(item.sessionID).push({ id: item.id, time: { created: now() }, text: item.payload.text, type: "user" })
  }

  const start = (sessionID: string) => {
    const items = inbox.get(sessionID) ?? []
    const first = items[0]
    if (first === undefined) return
    emit("session.execution.started", { sessionID }, false)
    touch(sessionID, { busy: now() })
    const delivered = items.filter((item) => item.delivery === "steer" || item === first)
    for (const item of delivered) deliver(item)
    const run: Running = { sessionID, prompt: delivered.map((item) => item.payload.text).join("\n"), step: 0, message: { id: "", type: "assistant", content: [] }, text: "" }
    running.set(sessionID, run)
    const session = sessions.get(sessionID)
    if (session && session.title === undefined && session.parentID === undefined) {
      const title = titles(first.payload.text)
      sessions.set(sessionID, { ...session, title })
      emit("session.renamed", { sessionID, title })
    }
    startStep(run)
  }

  let titles: (text: string) => string = (text) => text.split(/\s+/).slice(0, 3).join(" ").toLowerCase()

  /** Commits a staged revert (core's SessionRevert.commit): the messages from the reverted one on go. */
  const commitRevert = (sessionID: string) => {
    const staged = sessions.get(sessionID)?.revert as { messageID: string } | undefined
    if (staged === undefined) return
    const kept = list(sessionID)
    const at = kept.findIndex((message) => message.id === staged.messageID)
    if (at >= 0) kept.splice(at)
    const { revert: _, ...rest } = sessions.get(sessionID) ?? {}
    sessions.set(sessionID, rest)
    emit("session.revert.committed", { sessionID, to: staged.messageID })
  }

  const enqueue = (sessionID: string, text: string, delivery: "steer" | "queue", given?: string) => {
    // A prompt on a session with a staged revert commits it first (core's Session.prompt).
    commitRevert(sessionID)
    // The client draws the prompt's id (it sends `id`); the server keeps it.
    const item: Pending = { id: given ?? id("msg"), sessionID, time: { created: now() }, type: "user", payload: { text }, delivery }
    inbox.get(sessionID)?.push(item)
    emit("session.inbox.enqueued", { inboxID: item.id, sessionID, item: { type: "user", payload: item.payload, delivery } })
    if (!running.has(sessionID)) start(sessionID)
    return item
  }

  const interrupt = (sessionID: string, resume: boolean) => {
    const run = running.get(sessionID)
    if (run === undefined) return false
    running.delete(sessionID)
    const error = { type: "aborted", message: "Step interrupted" }
    if (run.shell) {
      // As core settles a tool call the interrupt cut (SessionRunner.settleStaleToolCalls): aborted, with no output.
      shellExits.push("killed")
      const error = { type: "aborted", message: "Tool execution interrupted: shell" }
      run.shell.part.state = { status: "error", input: (run.shell.part.state as Json).input, error }
      run.shell.part.time = { ...(run.shell.part.time as Json), completed: now() }
      emit("session.tool.failed", { sessionID, assistantMessageID: run.message.id, id: run.shell.toolID, error, executed: false })
    } else {
      endText(run)
      emit("session.step.streamed", { sessionID, assistantMessageID: run.message.id })
    }
    run.message.time = { ...(run.message.time as Json), streamed: now(), completed: now() }
    Object.assign(run.message, { finish: "error", error })
    emit("session.step.failed", { sessionID, assistantMessageID: run.message.id, error })
    const idle: Message = { id: id("msg"), time: { created: now() }, type: "idle", outcome: "interrupted" }
    list(sessionID).push(idle)
    emit("session.execution.interrupted", { sessionID, reason: "user" }, false)
    touch(sessionID, { idle: now() })
    const session = sessions.get(sessionID)
    if (session) sessions.set(sessionID, { ...session, outcome: "interrupted" })
    settled(sessionID)
    if (resume && (inbox.get(sessionID) ?? []).some((item) => item.delivery === "steer")) start(sessionID)
    return true
  }

  const json = (identifier: string, body: unknown, status = 200) => {
    const found = endpoints.find((endpoint) => endpoint.identifier === identifier)
    if (found === undefined || body === undefined) return new Response(null, { status: 204 })
    const encoded = roundTrip(found.success, body)
    return new Response(JSON.stringify(encoded), { status, headers: { "content-type": "application/json" } })
  }

  /** An error answer, as the real server's: a JSON body under its status. */
  const failure = (status: number, body: Json) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const ordered = (sessionID: string) => list(sessionID).toReversed()
  const family = (sessionID: string): Array<string> => [
    sessionID,
    ...[...sessions.values()].filter((each) => each.parentID === sessionID).flatMap((each) => family(each.id as string)),
  ]

  const serve = (identifier: Served, params: Record<string, string>, query: URLSearchParams, body: Json): Response | Promise<Response> => {
    const sessionID = params.sessionID ?? ""
    switch (identifier) {
      case "session.list":
        return json(identifier, { data: [...sessions.values()].toSorted((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1)), cursor: {} })
      case "session.get": {
        const found = sessions.get(sessionID)
        if (found === undefined) return failure(404, { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` })
        return json(identifier, { data: found })
      }
      case "session.active":
        return json(identifier, { data: Object.fromEntries([...running.keys()].map((each) => [each, { type: "running" }])) })
      case "session.messages":
        return json(identifier, { data: ordered(sessionID), cursor: {} })
      case "session.message": {
        const found = list(sessionID).find((message) => message.id === params.messageID)
        if (found === undefined) return failure(404, { _tag: "MessageNotFoundError", message: `Message not found: ${params.messageID}` })
        return json(identifier, { data: found })
      }
      case "session.inbox.list":
        return json(identifier, { data: inbox.get(sessionID) ?? [] })
      case "session.inbox.cancel": {
        const items = inbox.get(sessionID) ?? []
        const inboxID = params.inboxID ?? ""
        if (items.some((item) => item.id === inboxID)) {
          inbox.set(sessionID, items.filter((item) => item.id !== inboxID))
          emit("session.inbox.cancelled", { sessionID, inboxID })
        }
        return new Response(null, { status: 204 })
      }
      case "session.prompt": {
        const delivery = body.delivery === "queue" ? "queue" : "steer"
        const item = enqueue(sessionID, String(body.text ?? ""), delivery, typeof body.id === "string" ? body.id : undefined)
        return json(identifier, { data: item })
      }
      case "session.interrupt":
        return json(identifier, { interrupted: interrupt(sessionID, query.get("resume") !== "false") })
      case "session.wait":
        if (!running.has(sessionID)) return new Response(null, { status: 204 })
        // A long poll: parked until the run settles, so it does not keep the harness from resting.
        parked += 1
        return new Promise<Response>((resolve) => {
          const list = waiters.get(sessionID) ?? []
          list.push(() => {
            parked -= 1
            resolve(new Response(null, { status: 204 }))
          })
          waiters.set(sessionID, list)
        })
      case "session.revert.stage": {
        const revert = { messageID: String(body.messageID ?? ""), files: [] }
        const found = sessions.get(sessionID)
        if (found) sessions.set(sessionID, { ...found, revert })
        emit("session.revert.staged", { sessionID, revert })
        return json(identifier, { data: revert })
      }
      case "session.family.request.list":
        return json(identifier, { data: { sessions: family(sessionID), permissions: [], forms: [] } })
      case "session.switchAgent":
      case "session.switchModel": {
        const found = sessions.get(sessionID)
        if (found === undefined) return failure(404, { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` })
        const field = identifier === "session.switchAgent" ? "agent" : "model"
        const previous = found[field]
        if (canonical(previous) !== canonical(body[field])) {
          sessions.set(sessionID, { ...found, [field]: body[field] })
          emit(field === "agent" ? "session.agent.selected" : "session.model.selected", { sessionID, [field]: body[field], ...(previous === undefined ? {} : { previous }) })
        }
        return new Response(null, { status: 204 })
      }
      case "session.revert.commit":
        if (!sessions.has(sessionID)) return failure(404, { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` })
        if (running.has(sessionID)) return failure(409, { _tag: "SessionBusyError", sessionID, message: `Session is busy: ${sessionID}` })
        commitRevert(sessionID)
        return new Response(null, { status: 204 })
      case "session.view": {
        // As core's Session.view: marks an idle the session has had, never past it and never back.
        const found = sessions.get(sessionID)
        if (found === undefined) return failure(404, { _tag: "SessionNotFoundError", message: `Session not found: ${sessionID}` })
        const time = found.time as { idle?: number; viewed?: number }
        const idle = Number(body.idle)
        if (time.idle === undefined || idle > time.idle || (time.viewed !== undefined && time.viewed >= idle)) return new Response(null, { status: 204 })
        sessions.set(sessionID, { ...found, time: { ...time, viewed: Math.max(idle, time.viewed ?? idle) } })
        emit("session.viewed", { sessionID, idle })
        return new Response(null, { status: 204 })
      }
      case "agent.list":
        return json(identifier, { location: catalogLocation, data: AGENTS })
      case "model.list":
        return json(identifier, { location: catalogLocation, data: [MODEL] })
      case "provider.list":
        return json(identifier, { location: catalogLocation, data: [PROVIDER] })
      case "server.info":
        return json(identifier, INFO)
      case "rpc.call":
        // No plugin of ours runs on the double's server: an RPC to one fails as the real server's does with none loaded.
        if (params.rpcID === "opencode.goal") return json(identifier, { output: null })
        return failure(404, { _tag: "RpcNotFoundError", message: `No RPC ${params.rpcID}` })
    }
  }

  let inflight = 0
  /** Requests the double holds open on purpose (a long poll, or any request while silent). */
  let parked = 0
  /** The fetch handler the fixture calls first: the double's answer, or undefined for the fixture's own defaults. */
  const fetch: Handler = async (url, raw) => {
    const found = endpointOf(raw.method, url.pathname)
    const served = found !== undefined && (SERVED as ReadonlyArray<string>).includes(found.endpoint.identifier)
    if (!served) {
      if (url.pathname === "/api/event") return undefined
      if (FIXTURE_ROUTES.includes(url.pathname) || FIXTURE_PATTERNS.some((pattern) => pattern.test(url.pathname))) return undefined
      unserved.push(`${raw.method} ${url.pathname}`)
      return failure(501, { message: `the double does not serve ${raw.method} ${url.pathname}` })
    }
    const text = raw.method === "GET" || raw.method === "DELETE" ? "" : await raw.text()
    const body = text === "" ? {} : (JSON.parse(text) as Json)
    requests.push({ at: now(), method: raw.method, path: url.pathname, ...(text === "" ? {} : { body }) })
    inflight += 1
    try {
      if (silent) {
        parked += 1
        return await new Promise<Response>((resolve) =>
          held.push(() => {
            parked -= 1
            resolve(new Response(null, { status: 503 }))
          }),
        )
      }
      return await serve(found.endpoint.identifier as Served, found.params, url.searchParams, body)
    } catch (cause) {
      broken.push(`${raw.method} ${url.pathname}: ${String(cause)}`)
      return failure(500, { message: String(cause) })
    } finally {
      inflight -= 1
    }
  }

  return {
    fetch,
    session,
    enqueue,
    interrupt,
    /** Ends a stalled step: the rest of the model's text, then the run goes on. */
    release: (sessionID: string, text = "") => {
      const run = running.get(sessionID)
      if (run === undefined || run.hold !== "stall") return
      run.hold = undefined
      if (text !== "") {
        const part = run.message.content.findLast((each) => each.type === "text")
        if (part) {
          const ordinal = run.message.content.lastIndexOf(part)
          part.text = `${part.text as string}${text}`
          run.text = part.text as string
          emit("session.text.delta", { sessionID, assistantMessageID: run.message.id, ordinal, delta: text })
        }
      }
      endStep(run, "stop")
    },
    /** The server stops answering: requests from now on stay open until `answer`. */
    silence: () => {
      silent = true
    },
    answer: () => {
      silent = false
      for (const wake of held.splice(0)) wake()
    },
    retitle: (namer: (text: string) => string) => {
      titles = namer
    },
    /** The events to send the client now: none while silent (the stream stalls with the rest). */
    take: () => (silent ? [] : outbox.splice(0)),
    /** Whether the double owes the client anything it will send without time moving. */
    busy: () => inflight - parked > 0 || (!silent && outbox.length > 0),
    /** How many requests the double holds open on purpose: the harness does not wait on them. */
    parked: () => parked,
    /** What the double still owes, for a message. */
    owed: () => `${inflight - parked} requests in flight, ${silent ? 0 : outbox.length} events unsent`,
    /** The seed ends: every parked request is answered (503) and every long poll woken, so none outlives its seed. */
    close: () => {
      silent = false
      // A session left running would stay running in the client's store past its seed, and the
      // store's backstop recheck would read it again in a later seed: each one ends here.
      for (const sessionID of [...running.keys()]) {
        running.delete(sessionID)
        emit("session.execution.succeeded", { sessionID }, false)
      }
      for (const wake of held.splice(0)) wake()
      for (const sessionID of [...waiters.keys()]) settled(sessionID)
    },
    shellExits: () => shellExits,
    requests: () => requests,
    unserved: () => unserved,
    broken: () => broken,
    events: () => events,
    running: (sessionID: string) => running.has(sessionID),
    /** The child sessions of `sessionID`, oldest first. */
    children: (sessionID: string) => [...sessions.values()].filter((each) => each.parentID === sessionID).map((each) => String(each.id)),
    messages: list,
    inbox: (sessionID: string) => inbox.get(sessionID) ?? [],
    info: (sessionID: string) => sessions.get(sessionID),
  }
}
export type Double = ReturnType<typeof make>
