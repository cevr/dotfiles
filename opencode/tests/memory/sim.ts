/**
 * The scripted model for the memory test: an OpenAI-compatible chat endpoint
 * on a loopback port that answers by the conversation it is sent, and keeps
 * the system prompt of every request (titles aside) by its task. Each next call
 * comes once the last one's result is back.
 *
 * - `memory save`: saves a global note, saves a near repeat of it, searches.
 * - `memory recall`: saves a project note mid-session, then answers.
 * - `memory again`: answers at once.
 *
 * @module
 */

export const SAVE_TASK = "memory save"
export const RECALL_TASK = "memory recall"
export const AGAIN_TASK = "memory again"
export const DONE = "sim: memory done"

export const FACT = "The user prefers bun over npm"
export const REPEAT = "The user prefers bun over npm for scripts"
export const LATE = "Run the gate before every push"

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

const SCRIPTS: Readonly<Record<string, ReadonlyArray<Reply>>> = {
  [SAVE_TASK]: [
    { kind: "tool", name: "memory_save", input: { text: FACT, scope: "global", tags: ["bun"] } },
    { kind: "tool", name: "memory_save", input: { text: REPEAT, scope: "global" } },
    { kind: "tool", name: "memory_search", input: { query: "bun npm" } },
  ],
  [RECALL_TASK]: [{ kind: "tool", name: "memory_save", input: { text: LATE } }],
  [AGAIN_TASK]: [],
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

/** Serves the scripted model; `systems` holds each task's system prompts, one per request, in order. */
export const serve = () => {
  const systems: Record<string, Array<string>> = {}
  let served = 0
  const reply = (request: ChatRequest): Reply => {
    const messages = request.messages ?? []
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => text(message.content))
      .join("\n")
    if (system.includes("You name conversations")) return { kind: "text", text: "Memory run" }
    const task = text(messages.find((message) => message.role === "user")?.content).trim()
    const name = Object.keys(SCRIPTS).find((key) => task.endsWith(key))
    if (name === undefined) return { kind: "text", text: "sim: nothing to do" }
    ;(systems[name] ??= []).push(system)
    return SCRIPTS[name]![messages.filter((message) => message.role === "tool").length] ?? { kind: "text", text: DONE }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      served += 1
      return new Response(events(reply(body), body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, systems }
}
