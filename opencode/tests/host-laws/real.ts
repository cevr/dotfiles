// The host laws' real run: real OpenCode (the fork, embedded through its SDK,
// as tests/idle-compact/run.ts runs it) on a scripted model on a loopback
// port, with the law probe (sim/server.ts) loaded from config as the owner
// loads any plugin. It opens the law folder, so the host starts the probe's
// copy there, waits for the probe's `sim-law: done`, and writes the probe's
// outcome lines to `<base>/result.json`. tests/host-laws.test.ts starts it in a
// child process whose HOME and XDG dirs are a scratch dir, with
// `SIM_REAL_BASE`, `SIM_REAL_FORK` and `SIM_REAL_PROBE` (the probe package).
//
// The model answers each request as the world's does (law-names.ts `answer`),
// so a law reads the same words on both hosts. It runs on the root's Effect
// and Bun's platform layer; it imports nothing of the fork's at compile time.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Array as Arr, Clock, Config, Data, Effect, FileSystem, Match, Option, Path, Predicate, Schedule, Schema } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import {
  answer,
  BROKEN,
  callFor,
  callOf,
  CLIENT,
  DONE,
  ELSEWHERE_FOLDER,
  KEPT,
  LAW_FOLDER,
  LAW_LOGIN,
  LAW_SOL,
  LAW_SOCKET,
  type LawCall,
  PROBE_OPTIONS,
} from "../../sim/law-names.ts"

/** How long the probe has to run every law on the real host. */
const LIMIT = 300_000
/** How often the run looks for the probe's last line, ms. */
const POLL = 250

/** The run could not start the fork or the probe never finished. */
class RealRunFailed extends Data.TaggedError("RealRunFailed")<{ readonly message: string; readonly cause?: unknown }> {}

/** A message's content: a string or its parts; a message of tool calls only has none, or `null` (`OptionFromOptionalNullOr`). */
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  // A message may carry no content, or `null` (an assistant's tool call): no text.
  messages: Schema.optional(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.OptionFromOptionalNullOr(Content) }))),
})
type ChatRequest = typeof ChatRequest.Type
const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)

/** A message's text: its string, or its parts' texts; none for no content. */
const textOf = (content: Option.Option<Content>): string =>
  Option.match(content, {
    onNone: () => "",
    onSome: (present) => {
      if (Predicate.isString(present)) return present
      return present.map((part) => part.text ?? "").join("")
    },
  })

/** OpenAI's Responses request, over HTTP or as a socket's `response.create`: its instructions and its input's messages. */
const ResponsesRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Array(Schema.Struct({ role: Schema.optional(Schema.String), content: Schema.OptionFromOptionalNullOr(Content) }))),
})
type ResponsesRequest = typeof ResponsesRequest.Type
const decodeResponses = Schema.decodeUnknownEffect(Schema.fromJsonString(ResponsesRequest))

/** A conversation as both APIs carry it: each message's role and text. */
type Said = ReadonlyArray<{ readonly role?: string; readonly content: Option.Option<Content> }>

/** A request's kind as the host means it: a title by its system prompt, a compaction by OpenCode's summary prompt. */
const kindOf = (messages: Said, instructions = "") => {
  const system = [instructions, ...messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content))]
  if (system.join("\n").includes("You name conversations")) return "title"
  const user = messages.filter((message) => message.role === "user").map((message) => textOf(message.content))
  if ((user.at(-1) ?? "").includes("summarize the conversation above")) return "compaction"
  return "primary"
}

/** The answer to a Responses request, as OpenAI's Responses events: one text message, then the response's usage. */
const responseEvents = (request: ResponsesRequest, id: string) => {
  const messages = request.input ?? []
  const text = answer(kindOf(messages, request.instructions), messages.map((message) => textOf(message.content)).join("\n"))
  const item = { type: "message", id: `msg_${id}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }
  const usage = { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 }
  return [
    { type: "response.created", response: { id: `resp_${id}` } },
    { type: "response.output_item.added", item: { type: "message", id: item.id } },
    { type: "response.output_text.delta", item_id: item.id, delta: text },
    { type: "response.output_text.done", item_id: item.id, text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: `resp_${id}`, output: [item], usage } },
  ].map((event) => toJson(event))
}

interface Delta {
  readonly role?: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{
    readonly index: number
    readonly id: string
    readonly type: "function"
    readonly function: { readonly name: string; readonly arguments: string }
  }>
}

/**
 * The answer: text, a law's tool call (law-names.ts `callFor`), or the call a law's `law-call:` prompt asks for
 * (law-names.ts `callOf`: its input already a JSON object's text).
 */
type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly call: LawCall }
  | { readonly kind: "asked"; readonly name: string; readonly input: string }

/** The answer as OpenAI-compatible stream events, with a usage. A tool call's arguments are its input as JSON: a string input stays a string. */
const events = (reply: Reply, model: string, id: string) => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }],
  })
  const usage = { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 }
  const called = (name: string, args: string) => [
    chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name, arguments: args } }] }, Option.none()),
    chunk({}, Option.some("tool_calls")),
  ]
  const body = Match.value(reply).pipe(
    Match.when({ kind: "text" }, (text) => [chunk({ content: text.text }, Option.none()), chunk({}, Option.some("stop"))]),
    Match.when({ kind: "tool" }, (tool) => called(tool.call.name, toJson(tool.call.input))),
    Match.when({ kind: "asked" }, (asked) => called(asked.name, asked.input)),
    Match.exhaustive,
  )
  const list = [chunk({ role: "assistant", content: "" }, Option.none()), ...body, { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage }]
  return [...list.map((event) => `data: ${toJson(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

const stream = (body: string) => HttpServerResponse.text(body, { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } })

/**
 * The socket model: each `response.create` the host writes to the socket answered with the answer's events, one frame
 * each, until the host closes it.
 */
const socketModel = (request: HttpServerRequest.HttpServerRequest, served: { count: number }) =>
  Effect.gen(function* () {
    const socket = yield* request.upgrade
    const writer = yield* socket.writer
    const pull = yield* Socket.readerString(socket)
    yield* pull.pipe(
      Effect.flatMap((messages) =>
        Effect.forEach(messages, (message) =>
          decodeResponses(message).pipe(
            Effect.flatMap((create) => {
              served.count += 1
              return Effect.forEach(responseEvents(create, `law${served.count}`), (frame) => writer.write(frame), { discard: true })
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.catchTag("SocketError", () => Effect.void),
    )
    return HttpServerResponse.empty()
  }).pipe(Effect.scoped)

/**
 * The reply to a request: the call a turn's last message asks for with a law's `law-call:` prompt; a law's call while
 * its prompt waits for one; else the words `answer` gives.
 */
const replyTo = (request: ChatRequest): Reply => {
  const messages = request.messages ?? []
  const text = messages.map((message) => textOf(message.content)).join("\n")
  const kind = kindOf(messages)
  const asked = Option.filter(Arr.head(callOf(textOf(Option.flatMap(Option.fromNullishOr(messages.at(-1)), (last) => last.content)))), () => kind === "primary")
  if (Option.isSome(asked)) return { kind: "asked", ...asked.value }
  const call = callFor(kind, text, messages.filter((message) => message.role === "tool").length)
  if (call !== void 0) return { kind: "tool", call }
  return { kind: "text", text: answer(kind, text) }
}

/**
 * The scripted model: each chat completion (the `sim` provider) and each Responses request over HTTP or a socket
 * (the socket law's provider) answered as the world's model answers it.
 */
const model = (served: { count: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url.endsWith("/responses") && request.headers["upgrade"] === "websocket") return yield* socketModel(request, served)
    if (request.method === "POST" && request.url.endsWith("/responses")) {
      const body = yield* HttpServerRequest.schemaBodyJson(ResponsesRequest)
      served.count += 1
      return stream(responseEvents(body, `law${served.count}`).map((frame) => `data: ${frame}\n\n`).join(""))
    }
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest)
    served.count += 1
    return stream(events(replyTo(body), body.model ?? "sim", `law${served.count}`))
  }).pipe(Effect.orDie)

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly location: { readonly get: (input: { location: { directory: string } }) => Promise<object> }
  readonly credential: {
    readonly create: (input: {
      readonly id: string
      readonly integrationID: string
      readonly label: string
      readonly value: { readonly [key: string]: string | number }
      readonly activate: boolean
    }) => Promise<object>
  }
  readonly session: {
    readonly update: (input: { readonly sessionID: string; readonly archived: boolean }) => Promise<{ readonly id: string }>
    readonly form: {
      readonly create: (input: {
        readonly sessionID: string
        readonly title: string
        readonly fields: ReadonlyArray<{ readonly key: string; readonly type: "string" }>
      }) => Promise<{ readonly id: string }>
      readonly reply: (input: { readonly sessionID: string; readonly formID: string; readonly answer: { readonly [key: string]: string } }) => Promise<void>
    }
  }
  readonly close: () => Promise<void>
}

/** What the probe asks the host's client to do (sim/host-laws.ts `ClientAsk`). */
const ClientAsk = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("archive"), sessionID: Schema.String }),
    Schema.Struct({ action: Schema.Literal("form"), sessionID: Schema.String, key: Schema.String, value: Schema.String }),
  ]),
)
type ClientAsk = typeof ClientAsk.Type

/** Does what the probe asked, as the owner would from a client: archive a session, or answer a form made for it. */
const act = (opencode: Embedded, ask: ClientAsk) => {
  const client = <A>(request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: (cause) => new RealRunFailed({ message: `the client did not ${ask.action}`, cause }) })
  if (ask.action === "archive") return client(() => opencode.session.update({ sessionID: ask.sessionID, archived: true }))
  return client(() => opencode.session.form.create({ sessionID: ask.sessionID, title: "law", fields: [{ key: ask.key, type: "string" }] })).pipe(
    Effect.flatMap((form) => client(() => opencode.session.form.reply({ sessionID: ask.sessionID, formID: form.id, answer: { [ask.key]: ask.value } }))),
  )
}
/** A host log entry, as the fork's SDK emits it (packages/sdk/src/logging.ts). */
interface LogEntry {
  readonly level: string
  readonly message: string
  readonly cause?: unknown
}
/** The host's warnings and errors the run keeps, the last ones, to say why the probe did not finish. */
const KEPT_WARNINGS = 40
interface CreateOptions {
  readonly events: { readonly persist: boolean }
  readonly log: { readonly level: string; readonly emit: (entry: LogEntry) => void }
  readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: CreateOptions) => Promise<Embedded> }
}
/** The fork's SDK module, loaded from the fork found at run time. */
const loadSdk = (file: string): Promise<Partial<Sdk>> => import(file)
const isSdk = (value: Partial<Sdk>): value is Sdk => Predicate.isFunction(value.OpenCode?.create)

/** The probe's outcome line in a log message, if it holds one. */
const outcomeIn = (message: string) =>
  Option.liftPredicate(message.indexOf("sim-law: "), (at) => at >= 0).pipe(
    Option.map((at) => message.slice(at)),
    Option.filter((line) => [KEPT, BROKEN, DONE].some((prefix) => line.startsWith(prefix))),
  )

/** The probe's ask of the client in a log message, if it holds one: its JSON. */
const askIn = (message: string) =>
  Option.liftPredicate(message.indexOf(CLIENT), (at) => at >= 0).pipe(Option.map((at) => message.slice(at + CLIENT.length)))

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* Config.String("SIM_REAL_BASE")
  const fork = yield* Config.String("SIM_REAL_FORK")
  const probe = yield* Config.String("SIM_REAL_PROBE")
  const law = path.join(base, LAW_FOLDER)
  const config = path.join(base, "config")
  yield* fs.makeDirectory(law, { recursive: true })
  // The `located` law's other location, beside the law folder.
  yield* fs.makeDirectory(path.join(base, ELSEWHERE_FOLDER), { recursive: true })
  yield* fs.makeDirectory(config, { recursive: true })

  yield* HttpServer.serveEffect(model({ count: 0 }))
  const server = yield* HttpServer.HttpServer
  const origin = HttpServer.formatAddress(server.address)
  const content = {
    model: "sim/sim-model",
    providers: {
      sim: {
        name: "Sim",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${origin}/v1`, apiKey: "sim-key" },
        models: {
          "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } },
          [LAW_SOL.id]: {
            name: "Sim sol",
            family: LAW_SOL.family,
            releaseDate: LAW_SOL.releaseDate,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
          },
        },
      },
      // The socket law's provider: OpenAI's Responses, streamed over a WebSocket to the same loopback.
      [LAW_SOCKET.providerID]: {
        name: "Law socket",
        package: "@opencode/ai/providers/openai",
        settings: { baseURL: `${origin}/v1`, apiKey: "sim-key", transport: "websocket" },
        models: {
          [LAW_SOCKET.id]: { name: "Law socket", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } },
        },
      },
    },
    plugins: [{ package: probe, options: PROBE_OPTIONS }],
    // As the world's law run: OpenCode's schedule tools built in, for the tool law to remove one.
    experimental: { schedules: true },
  }

  const sdk: Partial<Sdk> = yield* Effect.tryPromise({
    try: () => loadSdk(path.join(fork, "packages/sdk/src/index.ts")),
    catch: (cause) => new RealRunFailed({ message: "the fork's SDK did not load", cause }),
  })
  if (!isSdk(sdk)) return yield* new RealRunFailed({ message: "the fork's SDK has no OpenCode.create" })
  const lines: Array<string> = []
  const asks: Array<string> = []
  const warnings: Array<string> = []
  /** The host's warnings that it could not load the probe: a plugin load failure that names the probe's folder. */
  const unloaded: Array<string> = []
  const note = (entry: LogEntry) => {
    if (entry.level !== "warn" && entry.level !== "error" && entry.level !== "fatal") return
    const said = `${entry.level}: ${entry.message}${Option.match(Option.fromUndefinedOr(entry.cause), { onNone: () => "", onSome: (cause) => ` (${String(cause).slice(0, 400)})` })}`
    warnings.push(said)
    if (warnings.length > KEPT_WARNINGS) warnings.shift()
    if (entry.message.includes("failed to load plugin") && String(entry.cause).includes(probe)) unloaded.push(said)
  }
  const opencode = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        sdk.OpenCode.create({
          events: { persist: true },
          log: {
            level: "info",
            emit: (entry) => {
              note(entry)
              Option.map(outcomeIn(entry.message), (line) => lines.push(line))
              Option.map(askIn(entry.message), (ask) => asks.push(ask))
            },
          },
          config: { directory: config, project: false, content: toJson(content) },
        }),
      catch: (cause) => new RealRunFailed({ message: "OpenCode did not start", cause }),
    }),
    (embedded) => Effect.promise(() => embedded.close()),
  )

  // The login the integration law reads, held before the probe starts, as `opencode auth import` holds one.
  const now = yield* Clock.currentTimeMillis
  yield* Effect.tryPromise({
    try: () =>
      opencode.credential.create({
        id: LAW_LOGIN.id,
        integrationID: "anthropic",
        label: LAW_LOGIN.label,
        value: { type: "oauth", methodID: "claude-max", access: LAW_LOGIN.access, refresh: LAW_LOGIN.refresh, expires: now + 8 * 3_600_000 },
        activate: true,
      }),
    catch: (cause) => new RealRunFailed({ message: "the law login was not held", cause }),
  })

  // The host starts a copy of each config plugin for each Location it opens: this one for the law folder.
  yield* Effect.tryPromise({
    try: () => opencode.location.get({ location: { directory: law } }),
    catch: (cause) => new RealRunFailed({ message: "the law folder did not open", cause }),
  })
  // Each poll does what the probe asked of the client since the last; one that fails is a warning, the law saying why it broke.
  const drain = Effect.suspend(() =>
    Effect.forEach(
      asks.splice(0),
      (json) =>
        Schema.decodeUnknownEffect(ClientAsk)(json).pipe(
          Effect.flatMap((ask) => act(opencode, ask)),
          Effect.catch((failure) => Effect.sync(() => note({ level: "warn", message: `client ask ${json}: ${failure.message}` }))),
        ),
      { discard: true },
    ),
  )
  yield* drain.pipe(
    // The wait ends at the probe's `done`, or at once when the host says it could not load the probe (each law has its
    // own limit in the probe, sim/server.ts, so a law that hangs names itself there).
    Effect.andThen(
      Effect.suspend(() => {
        if (Arr.contains(lines, DONE) || unloaded.length > 0) return Effect.void
        return Effect.fail(new RealRunFailed({ message: "the probe has not finished" }))
      }),
    ),
    Effect.retry({ schedule: Schedule.spaced(POLL), times: LIMIT / POLL }),
    Effect.ignore,
  )
  // A probe that did not finish leaves a line saying why and what the host warned of, for the test to show.
  if (unloaded.length > 0) lines.push(`the host did not load the probe (${probe}): ${unloaded.join("\n")}`)
  else if (!Arr.contains(lines, DONE))    lines.push(`the probe did not finish in ${LIMIT / 1000} s, after ${lines.length} outcome lines; the host's last warnings and errors:\n${warnings.join("\n")}`)
  yield* fs.writeFileString(path.join(base, "result.json"), toJson({ lines }))
})

const Model = BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(Model)))
