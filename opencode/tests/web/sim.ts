/**
 * The scripted model for the web test: an OpenAI-compatible chat endpoint on
 * a loopback port that answers by the conversation it is sent. Each next call
 * comes once the last one's result is back.
 *
 * - A title request: a short title.
 * - The task `web pick` (the run before the plugin): one `websearch` call,
 *   which asks the consent form.
 * - The task `web check`: a foreground `subagent` call whose child (the task
 *   `web search in a subagent`) makes one `websearch` call, then `webfetch`
 *   calls of the site's PDF, its body over 5 MB and a missing docs page.
 * - Anything else: one line.
 *
 * @module
 */

export const PICK_TASK = "web pick"
export const CHECK_TASK = "web check"
export const CHILD_TASK = "web search in a subagent"
export const DONE = "sim: web done"

/** The site's paths, under the base URL `serve` is given. */
export const PDF_PATH = "/paper.pdf"
export const BIG_PATH = "/big.txt"
export const MISSING_PATH = "/docs/missing"

/** The sentence the site's PDF says. */
export const PDF_TEXT = "The investigative judgment began in 1844"
/** The size of the site's text body, over the built-in's 5 MB limit. */
export const BIG_BYTES = 6 * 1024 * 1024
/** The result the stand-in `steady` provider answers. */
export const STEADY_URL = "https://steady.example/result"

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
}

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> }

const text = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("")
}

const firstUser = (messages: ReadonlyArray<ChatMessage>) => text(messages.find((message) => message.role === "user")?.content).trim()

const scripts = (site: string): Readonly<Record<string, ReadonlyArray<Reply>>> => ({
  [PICK_TASK]: [{ kind: "tool", name: "websearch", input: { query: "pick a provider" } }],
  [CHECK_TASK]: [
    { kind: "tool", name: "subagent", input: { agent: "general", description: "Search probe", prompt: CHILD_TASK } },
    { kind: "tool", name: "webfetch", input: { url: `${site}${PDF_PATH}` } },
    { kind: "tool", name: "webfetch", input: { url: `${site}${BIG_PATH}`, format: "text" } },
    { kind: "tool", name: "webfetch", input: { url: `${site}${MISSING_PATH}` } },
  ],
  [CHILD_TASK]: [{ kind: "tool", name: "websearch", input: { query: "the investigative judgment" } }],
})

const reply = (request: ChatRequest, site: string): Reply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: "Web run" }
  const task = firstUser(messages)
  const script = Object.entries(scripts(site)).find(([name]) => task.endsWith(name))?.[1]
  if (script === undefined) return { kind: "text", text: "sim: nothing to do" }
  return script[messages.filter((message) => message.role === "tool").length] ?? { kind: "text", text: DONE }
}

const events = (answer: Reply, model: string, id: string): string => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const list: unknown[] = [chunk({ role: "assistant", content: "" }, null)]
  if (answer.kind === "text") list.push(chunk({ content: answer.text }, null), chunk({}, "stop"))
  else
    list.push(
      chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: answer.name, arguments: JSON.stringify(answer.input) } }] }, null),
      chunk({}, "tool_calls"),
    )
  list.push({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** Serves the scripted model; `site` is the base URL of the pages it fetches. */
export const serve = (site: string) => {
  let served = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      served += 1
      return new Response(events(reply(body, site), body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server }
}
