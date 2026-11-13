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
import { Array as Arr, Clock, Config, Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { answer, BROKEN, callOf, DONE, KEPT, LAW_FOLDER, LAW_LOGIN, PROBE_OPTIONS } from "../../sim/law-names.ts"

/** How long the probe has to run every law on the real host. */
const LIMIT = 300_000
/** How often the run looks for the probe's last line, ms. */
const POLL = 250

/** The run could not start the fork or the probe never finished. */
class RealRunFailed extends Data.TaggedError("RealRunFailed")<{ readonly message: string; readonly cause?: unknown }> {}

/** A message's content: a string, its parts, or none at all (an assistant turn of tool calls only). */
const Content = Schema.Union([Schema.String, Schema.Null, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optional(Content) }))),
})
type ChatRequest = typeof ChatRequest.Type
const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)

/** A message's text: its string, or its parts' texts. */
const textOf = (content: Content = ""): string => {
  if (Predicate.isNull(content)) return ""
  if (Predicate.isString(content)) return content
  return content.map((part) => part.text ?? "").join("")
}

/** A request's kind as the host means it: a title by its system prompt, a compaction by OpenCode's summary prompt. */
const kindOf = (request: ChatRequest) => {
  const messages = request.messages ?? []
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content))
  if (system.join("\n").includes("You name conversations")) return "title"
  const user = messages.filter((message) => message.role === "user").map((message) => textOf(message.content))
  if ((user.at(-1) ?? "").includes("summarize the conversation above")) return "compaction"
  return "primary"
}

interface Delta {
  readonly role?: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{ readonly index: number; readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }>
}

/** A tool call as OpenAI-compatible stream events, with a usage: what a law's `law-call:` prompt asks for. */
const callEvents = (asked: { readonly name: string; readonly input: string }, model: string, id: string) => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }],
  })
  const usage = { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 }
  const list = [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: asked.name, arguments: asked.input } }] }, Option.none()),
    chunk({}, Option.some("tool_calls")),
    { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage },
  ]
  return [...list.map((event) => `data: ${toJson(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** The answer as OpenAI-compatible stream events, with a usage. */
const events = (text: string, model: string, id: string) => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }],
  })
  const usage = { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 }
  const list = [
    chunk({ role: "assistant", content: "" }, Option.none()),
    chunk({ content: text }, Option.none()),
    chunk({}, Option.some("stop")),
    { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage },
  ]
  return [...list.map((event) => `data: ${toJson(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** The scripted model: each chat completion answered as the world's model answers it. */
const model = (served: { count: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest)
    const text = (body.messages ?? []).map((message) => textOf(message.content)).join("\n")
    served.count += 1
    const id = `law${served.count}`
    const kind = kindOf(body)
    // A turn whose last message is a law's `law-call:` prompt is answered with that tool call; any other as `answer` says.
    const asked = Option.filter(Arr.head(callOf(textOf(body.messages?.at(-1)?.content))), () => kind === "primary")
    const stream = Option.match(asked, { onNone: () => events(answer(kind, text), body.model ?? "sim", id), onSome: (call) => callEvents(call, body.model ?? "sim", id) })
    return HttpServerResponse.text(stream, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    })
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
  readonly close: () => Promise<void>
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

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* Config.String("SIM_REAL_BASE")
  const fork = yield* Config.String("SIM_REAL_FORK")
  const probe = yield* Config.String("SIM_REAL_PROBE")
  const law = path.join(base, LAW_FOLDER)
  const config = path.join(base, "config")
  yield* fs.makeDirectory(law, { recursive: true })
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
        models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
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
  const warnings: Array<string> = []
  const note = (entry: LogEntry) => {
    if (entry.level !== "warn" && entry.level !== "error" && entry.level !== "fatal") return
    warnings.push(`${entry.level}: ${entry.message}${Option.match(Option.fromUndefinedOr(entry.cause), { onNone: () => "", onSome: (cause) => ` (${String(cause).slice(0, 400)})` })}`)
    if (warnings.length > KEPT_WARNINGS) warnings.shift()
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
  yield* Effect.suspend(() => {
    if (Arr.contains(lines, DONE)) return Effect.void
    return Effect.fail(new RealRunFailed({ message: "the probe has not finished" }))
  }).pipe(Effect.retry({ schedule: Schedule.spaced(POLL), times: LIMIT / POLL }), Effect.ignore)
  // A probe that did not finish leaves a line saying how far it got and what the host warned of, for the test to show.
  if (!Arr.contains(lines, DONE))
    lines.push(`the probe did not finish in ${LIMIT / 1000} s, after ${lines.length} outcome lines; the host's last warnings and errors:\n${warnings.join("\n")}`)
  yield* fs.writeFileString(path.join(base, "result.json"), toJson({ lines }))
})

const Model = BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(Model)))
