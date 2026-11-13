// The client laws' real run: real OpenCode (the fork's embedded host, booted
// by sim-tui/law-server.ts `real`) on a scripted model on a loopback port,
// every law of sim-tui/client-laws.ts run on it over the host's own fetch, and
// each law's outcome written to `<base>/result.json`. tests/client-laws.test.ts
// starts it in a child process whose HOME and XDG dirs are a scratch dir, with
// `SIM_REAL_BASE` and `SIM_REAL_FORK`.
//
// The model answers as the double's scripted one in sim-tui/client-laws.test.ts:
// a prompt containing `stall` streams `Working on it` and holds until the run is
// cut; `spawn` calls the subagent tool once (a background worker on the
// `general` agent, whose brief thinks and holds) and then answers `Started.`;
// a title request answers a title; anything else answers `Done.`.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Array as Arr, Config, Effect, FileSystem, Option, Path, Predicate, Schema, Stream } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { real } from "../../sim-tui/law-server.ts"

const BRIEF = "Worker brief."
const MODEL = { providerID: "sim", id: "sim-model" }

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
// An assistant message that only called a tool has no content.
const Said = Schema.Union([Content, Schema.Null])
type Said = typeof Said.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optional(Said) }))),
})
type ChatRequest = typeof ChatRequest.Type
const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)
const Outcomes = Schema.fromJsonString(Schema.Struct({ outcomes: Schema.Array(Schema.Struct({ name: Schema.String, failures: Schema.Array(Schema.String) })) }))
const toOutcomes = Schema.encodeSync(Outcomes)

/** A message's text: its string, or its parts' texts. */
const textOf = (content: Said = ""): string => {
  if (Predicate.isString(content)) return content
  if (!Arr.isArray(content)) return ""
  return content.map((part) => part.text ?? "").join("")
}

/** What the model does for a request: a title, a held stream, the subagent call, or a short answer. */
const answerOf = (request: ChatRequest) => {
  const messages = request.messages ?? []
  const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content))
  if (system.join("\n").includes("You name conversations")) return { kind: "say" as const, text: "Law session" }
  const last = messages.at(-1)
  if (last?.role === "tool") return { kind: "say" as const, text: "Started." }
  const user = textOf(messages.filter((message) => message.role === "user").at(-1)?.content)
  if (user.includes(BRIEF)) return { kind: "hold" as const, text: "Looking." }
  if (user.includes("stall")) return { kind: "hold" as const, text: "Working on it" }
  if (user.includes("spawn")) return { kind: "spawn" as const, text: "" }
  return { kind: "say" as const, text: "Done." }
}

interface Delta {
  readonly role?: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{ readonly index: number; readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }>
}

/** The answer as OpenAI-compatible stream events. */
const eventsOf = (answer: ReturnType<typeof answerOf>, model: string, id: string) => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }],
  })
  const usage = { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 } }
  const line = (event: ReturnType<typeof chunk> | typeof usage) => `data: ${toJson(event)}\n\n`
  const start = line(chunk({ role: "assistant", content: "" }, Option.none()))
  if (answer.kind === "hold") return { head: [start, line(chunk({ content: answer.text }, Option.none()))], tail: Option.none<ReadonlyArray<string>>() }
  if (answer.kind === "spawn") {
    const input = { agent: "general", description: "Check the parser", prompt: BRIEF }
    const call = { index: 0, id: "call_worker", type: "function" as const, function: { name: "subagent", arguments: toJson(input) } }
    return { head: [start, line(chunk({ tool_calls: [call] }, Option.none()))], tail: Option.some([line(chunk({}, Option.some("tool_calls"))), line(usage), "data: [DONE]\n\n"]) }
  }
  return { head: [start, line(chunk({ content: answer.text }, Option.none()))], tail: Option.some([line(chunk({}, Option.some("stop"))), line(usage), "data: [DONE]\n\n"]) }
}

/** The scripted model: each chat completion answered as the header says; a held one never ends. */
const model = (served: { count: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest)
    served.count += 1
    const { head, tail } = eventsOf(answerOf(body), body.model ?? "sim", `law${served.count}`)
    const rest = Option.match(tail, { onNone: () => Stream.never, onSome: (lines) => Stream.fromIterable(lines) })
    return HttpServerResponse.stream(Stream.concat(Stream.fromIterable(head), rest).pipe(Stream.encodeText), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    })
  }).pipe(Effect.orDie)

const run = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* Config.String("SIM_REAL_BASE")
  const fork = yield* Config.String("SIM_REAL_FORK")
  const directory = path.join(base, "laws")
  const config = path.join(base, "config")
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.makeDirectory(config, { recursive: true })

  yield* HttpServer.serveEffect(model({ count: 0 }))
  const server = yield* HttpServer.HttpServer
  const origin = HttpServer.formatAddress(server.address)
  const content = {
    model: `${MODEL.providerID}/${MODEL.id}`,
    providers: {
      sim: {
        name: "Sim",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${origin}/v1`, apiKey: "sim-key" },
        models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
      },
    },
  }
  const outcomes = yield* Effect.promise(() =>
    real({ fork, directory, model: MODEL, create: { events: { persist: true }, config: { directory: config, project: false, content: toJson(content) } } }),
  )
  yield* fs.writeFileString(path.join(base, "result.json"), toOutcomes({ outcomes }))
})

const Model = BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })

BunRuntime.runMain(run.pipe(Effect.scoped, Effect.provide(Model)))
