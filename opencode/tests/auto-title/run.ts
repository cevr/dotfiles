// One auto-title run in real OpenCode (the fork, embedded through its SDK, as
// tests/host-laws/real.ts runs it) on a scripted model on a loopback port,
// with the plugin loaded from config as the owner loads it, due after 0
// minutes and 2 turns. tests/auto-title.test.ts starts it in a child process
// whose HOME and XDG dirs are a scratch dir, with `AUTO_TITLE_BASE`,
// `AUTO_TITLE_FORK` and `AUTO_TITLE_PLUGIN`.
//
// - `alpha`: a root session, titled from its first prompt by the host, then
//   given turns until its title is generated again.
// - `beta`: a root session, titled, then renamed by the owner (`session.update`
//   with a title, as the TUI's `/rename <text>` sends it) and given as many
//   turns: it keeps the owner's title. Then the owner's `/rename` with no
//   argument (`session.update` with an empty title) generates one, which
//   unpins it, and two turns later its title is generated again.
//
// The model answers a title request (OpenCode's title agent) `Title <word> <n>`,
// the n-th one naming that session's word (`alpha`, `beta`), anything else one
// line. It writes each session's title after each step, the title requests per
// word and the plugin's log lines to `<base>/result.json`. It runs on the
// root's Effect and Bun's platform layer; it imports nothing of the fork's at
// compile time.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Config, Data, Effect, FileSystem, Option, Path, Predicate, Schedule, Schema } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Result, titleOf, WORDS } from "./names.ts"

/** How long a title may take to land after the step that asks for it. */
const LAND = 20_000
/** How often the run reads a title while it waits for one, ms. */
const POLL = 200

class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string; readonly cause?: unknown }> {}
class NotYet extends Data.TaggedError("NotYet")<{ readonly title: string }> {}

/** A message's content: a string or its parts; none for a message of tool calls only. */
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.OptionFromOptionalNullOr(Content) })),
})
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const textOf = (content: Option.Option<Content>): string =>
  Option.match(content, {
    onNone: () => "",
    onSome: (present) => {
      if (Predicate.isString(present)) return present
      return present.map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => "")).join("")
    },
  })

/** The answer as OpenAI-compatible stream events, with a usage. */
const events = (text: string, model: string, id: string) => {
  const chunk = (delta: { readonly role?: string; readonly content?: string }, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }],
  })
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
  const list = [
    chunk({ role: "assistant", content: "" }, Option.none()),
    chunk({ content: text }, Option.none()),
    chunk({}, Option.some("stop")),
    { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage },
  ]
  return [...list.map((event) => `data: ${toJson(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** The scripted model: a title request named by its session's word gets that session's next title; anything else one line. */
const model = (requests: { alpha: number; beta: number }, served: { count: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest)
    served.count += 1
    const system = body.messages.filter((message) => message.role === "system").map((message) => textOf(message.content))
    const all = body.messages.map((message) => textOf(message.content)).join("\n")
    const word = Option.filter(Option.fromUndefinedOr(WORDS.find((candidate) => all.includes(candidate))), () => system.join("\n").includes("You name conversations"))
    const text = Option.match(word, {
      onNone: () => "sim: ok",
      onSome: (named) => {
        requests[named] += 1
        return titleOf(named, requests[named])
      },
    })
    return HttpServerResponse.text(events(text, Option.getOrElse(Option.fromUndefinedOr(body.model), () => "sim"), `sim${served.count}`), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    })
  }).pipe(Effect.orDie)

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { readonly location: { readonly directory: string } }) => Promise<{ readonly id: string }>
    readonly get: (input: { readonly sessionID: string }) => Promise<{ readonly title: string }>
    readonly prompt: (input: { readonly sessionID: string; readonly text: string }) => Promise<object>
    readonly update: (input: { readonly sessionID: string; readonly title: string }) => Promise<object>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { readonly sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface CreateOptions {
  readonly events: { readonly persist: boolean }
  readonly log: { readonly level: string; readonly emit: (entry: { readonly message: string }) => void }
  readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: CreateOptions) => Promise<Embedded> }
}
const loadSdk = (file: string): Promise<Partial<Sdk>> => import(file)
const isSdk = (value: Partial<Sdk>): value is Sdk => Predicate.isFunction(value.OpenCode?.create)

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* Config.String("AUTO_TITLE_BASE")
  const fork = yield* Config.String("AUTO_TITLE_FORK")
  const plugin = yield* Config.String("AUTO_TITLE_PLUGIN")
  const work = path.join(base, "work")
  const config = path.join(base, "config")
  yield* fs.makeDirectory(work, { recursive: true })
  yield* fs.makeDirectory(config, { recursive: true })

  const requests = { alpha: 0, beta: 0 }
  yield* HttpServer.serveEffect(model(requests, { count: 0 }))
  const server = yield* HttpServer.HttpServer
  const content = {
    model: "sim/sim-model",
    small_model: "sim/sim-model",
    providers: {
      sim: {
        name: "Sim",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${HttpServer.formatAddress(server.address)}/v1`, apiKey: "sim-key" },
        models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
      },
    },
    plugins: [{ package: plugin, options: { afterMinutes: 0, afterTurns: 2 } }],
  }

  const sdk: Partial<Sdk> = yield* Effect.tryPromise({
    try: () => loadSdk(path.join(fork, "packages/sdk/src/index.ts")),
    catch: (cause) => new RunFailed({ message: "the fork's SDK did not load", cause }),
  })
  if (!isSdk(sdk)) return yield* new RunFailed({ message: "the fork's SDK has no OpenCode.create" })
  const log: Array<string> = []
  const opencode = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        sdk.OpenCode.create({
          events: { persist: true },
          log: { level: "info", emit: (entry) => void (entry.message.startsWith("auto-title") && log.push(entry.message)) },
          config: { directory: config, project: false, content: toJson(content) },
        }),
      catch: (cause) => new RunFailed({ message: "OpenCode did not start", cause }),
    }),
    (embedded) => Effect.promise(() => embedded.close()),
  )
  const call = <A>(what: string, request: () => Promise<A>) => Effect.tryPromise({ try: request, catch: (cause) => new RunFailed({ message: what, cause }) })
  const titleNow = (sessionID: string) => call("the session did not read", () => opencode.sessions.get({ sessionID })).pipe(Effect.map((session) => session.title))
  /** The session's title once it is `expected`, or what it is after `LAND`. */
  const titleOnce = (sessionID: string, expected: string) =>
    titleNow(sessionID).pipe(
      Effect.filterOrFail((title) => title === expected, (title) => new NotYet({ title })),
      Effect.retry({ schedule: Schedule.spaced(POLL), times: LAND / POLL }),
      Effect.catchTag("NotYet", (stale) => Effect.succeed(stale.title)),
    )
  const turn = (sessionID: string, text: string) =>
    call("the prompt was refused", () => opencode.sessions.prompt({ sessionID, text })).pipe(
      Effect.andThen(call("the turn did not end", () => opencode.experimental.session.wait({ sessionID }))),
    )
  const session = call("the session was not made", () => opencode.sessions.create({ location: { directory: work } })).pipe(Effect.map((made) => made.id))
  const rename = (sessionID: string, title: string) => call("the rename was refused", () => opencode.sessions.update({ sessionID, title }))
  const titles: Record<string, string> = {}

  const alpha = yield* session
  yield* turn(alpha, "alpha: the first request")
  titles["alpha first"] = yield* titleOnce(alpha, titleOf("alpha", 1))
  // Whether the first turn's end came before its title or after, two more turns are due.
  yield* turn(alpha, "alpha: a second turn")
  yield* turn(alpha, "alpha: a third turn")
  titles["alpha after turns"] = yield* titleOnce(alpha, titleOf("alpha", 2))

  const beta = yield* session
  yield* turn(beta, "beta: the first request")
  titles["beta first"] = yield* titleOnce(beta, titleOf("beta", 1))
  yield* rename(beta, "The owner's name")
  yield* turn(beta, "beta: a second turn")
  yield* turn(beta, "beta: a third turn")
  yield* turn(beta, "beta: a fourth turn")
  // A retitle starts as the session goes idle: the wait that would see one land, had the pin not held it.
  titles["beta pinned"] = yield* titleOnce(beta, titleOf("beta", 2)).pipe(Effect.timeoutOption("3 seconds"), Effect.andThen(titleNow(beta)))
  yield* rename(beta, "")
  titles["beta regenerated"] = yield* titleOnce(beta, titleOf("beta", 2))
  yield* turn(beta, "beta: a fifth turn")
  yield* turn(beta, "beta: a sixth turn")
  titles["beta unpinned"] = yield* titleOnce(beta, titleOf("beta", 3))

  yield* fs.writeFileString(path.join(base, "result.json"), Schema.encodeSync(Schema.fromJsonString(Result))({ titles, requests, log }))
})

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }))))
