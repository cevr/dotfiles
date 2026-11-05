/**
 * The scripted model for the idle-compaction test: an OpenAI-compatible chat
 * endpoint on a loopback port. Every answer reports a prompt partly read from
 * and partly written to the prompt cache, so the session's last request has a
 * warm cache to lose. Each request is kept, with when it came, for the test.
 *
 * - A title request: a short title.
 * - A compaction request (OpenCode's summary prompt): a summary in its template.
 * - Anything else: one line.
 *
 * @module
 */

/** The run's cache lifetime and margin: the compaction is due 15 s after the turn's request. */
export const TTL_SECONDS = 20
export const MARGIN_SECONDS = 5
/** When the run reads the context before the compaction is due, after the turn's request came. */
export const EARLY_MS = 10_000
/** How long the run waits for the compaction, after the turn's request came. */
export const LATE_MS = 45_000

export const TASK = "idle compact"
export const ANSWER = "sim: idle answer"
export const SUMMARY = "## Objective\n- sim: the idle session's summary"
/** The usage every answer reports: 1000 prompt tokens, 400 read from cache, 500 written to it. */
export const PROMPT_TOKENS = 1_000

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
}

export type Kind = "title" | "compaction" | "turn"

/** What the test reads back about one request. */
export interface Seen {
  readonly kind: Kind
  /** Epoch ms the request came. */
  readonly at: number
}

const text = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("")
}

const kindOf = (request: ChatRequest): Kind => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return "title"
  const last = messages.findLast((message) => message.role === "user")
  if (text(last?.content).includes("summarize the conversation above")) return "compaction"
  return "turn"
}

const events = (answer: string, model: string, id: string): string => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const usage = {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: 10,
    total_tokens: PROMPT_TOKENS + 10,
    prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 500 },
  }
  const list: unknown[] = [
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content: answer }, null),
    chunk({}, "stop"),
    { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage },
  ]
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

const ANSWERS: Readonly<Record<Kind, string>> = { title: "Idle run", compaction: SUMMARY, turn: ANSWER }

/** Serves the scripted model. */
export const serve = () => {
  const seen: Seen[] = []
  let served = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      const kind = kindOf(body)
      seen.push({ kind, at: Date.now() })
      served += 1
      return new Response(events(ANSWERS[kind], body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, seen }
}
