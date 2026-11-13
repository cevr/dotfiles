// The host laws' real run: real OpenCode (the fork, embedded through its SDK,
// as tests/idle-compact/run.ts runs it) on a scripted model on a loopback
// port, with the law probe (sim/server.ts) loaded from config as the owner
// loads any plugin. It opens the law folder, so the host starts the probe's
// copy there, waits for the probe's `sim-law: done`, and writes the probe's
// outcome lines to `<base>/result.json`. tests/host-laws.test.ts starts it in a
// child process whose HOME and XDG dirs are a scratch dir:
// `bun sim/real.ts <base> <fork> <probe package>`.
//
// The model answers each request as the world's does (host-laws.ts `answer`),
// so a law reads the same words on both hosts.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Option, Predicate, Schema } from "effect"
import { answer, LAW_FOLDER, PROBE_OPTIONS } from "./host-laws.ts"
import { BROKEN, DONE, KEPT } from "./law-names.ts"

/** How long the probe has to run every law on the real host. */
const LIMIT_MS = 300_000

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optional(Content) }))),
})
type ChatRequest = typeof ChatRequest.Type

/** A message's text: its string, or its parts' texts. */
const textOf = (content: Content = ""): string => {
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
}

/** The answer as OpenAI-compatible stream events, with a usage. */
const events = (text: string, model: string, id: string) => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, ...Option.match(finish, { onNone: () => ({}), onSome: (reason) => ({ finish_reason: reason }) }) }],
  })
  const usage = { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 }
  const list = [
    chunk({ role: "assistant", content: "" }, Option.none()),
    chunk({ content: text }, Option.none()),
    chunk({}, Option.some("stop")),
    { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage },
  ]
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

const [base = "", fork = "", probe = ""] = process.argv.slice(2)
const law = join(base, LAW_FOLDER)
const config = join(base, "config")
mkdirSync(law, { recursive: true })
mkdirSync(config, { recursive: true })

const counter = { served: 0 }
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = Schema.decodeUnknownSync(ChatRequest)(await request.json())
    const text = (body.messages ?? []).map((message) => textOf(message.content)).join("\n")
    counter.served += 1
    return new Response(events(answer(kindOf(body), text), body.model ?? "sim", `law${counter.served}`), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  },
})

const content = {
  model: "sim/sim-model",
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "sim-key" },
      models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
    },
  },
  plugins: [{ package: probe, options: PROBE_OPTIONS }],
  // As the world's law run: OpenCode's schedule tools built in, for the tool law to remove one.
  experimental: { schedules: true },
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly location: { readonly get: (input: { location: { directory: string } }) => Promise<Embedded["location"]> }
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
const isSdk = (value: Partial<Sdk>): value is Sdk => Predicate.isFunction(value.OpenCode?.create)

const lines: Array<string> = []
const sdk: Partial<Sdk> = await import(join(fork, "packages/sdk/src/index.ts"))
if (!isSdk(sdk)) {
  console.error("sim/real.ts: the fork's SDK has no OpenCode.create")
  process.exit(2)
}
const opencode = await sdk.OpenCode.create({
  events: { persist: true },
  log: {
    level: "info",
    emit: (entry) => {
      const at = entry.message.indexOf("sim-law: ")
      if (at >= 0 && [KEPT, BROKEN, DONE].some((prefix) => entry.message.slice(at).startsWith(prefix))) lines.push(entry.message.slice(at))
    },
  },
  config: { directory: config, project: false, content: JSON.stringify(content) },
})

const run = async () => {
  // The host starts a copy of each config plugin for each Location it opens: this one for the law folder.
  await opencode.location.get({ location: { directory: law } })
  const until = Date.now() + LIMIT_MS
  while (Date.now() < until && !lines.includes(DONE)) await Bun.sleep(250)
  writeFileSync(join(base, "result.json"), JSON.stringify({ lines }))
}
await run().finally(async () => {
  await opencode.close()
  await model.stop(true)
})
process.exit(0)
