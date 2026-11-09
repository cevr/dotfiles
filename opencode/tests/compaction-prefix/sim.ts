/**
 * The scripted model for the compaction-prefix test: an OpenAI-compatible chat
 * endpoint on a loopback port that keeps every request's whole body, in the
 * order the requests came, with its kind. Every answer reports a prompt partly
 * read from the cache, so a session has a cache to keep.
 *
 * - A title request: a short title.
 * - A compaction request (OpenCode's summary prompt): a summary in its template.
 * - `AUTO_TASK`: a foreground `shell` call on a prompt past the 128k window's
 *   ceiling (108.8k), so the host compacts before the next step; then one line.
 * - `BACKGROUND_TASK`: a foreground `shell` call on a 20k prompt, then one line
 *   on a 90k one, past the background-summary trigger and below the ceiling, so
 *   with `background_compaction` on the host writes a summary as the turn ends.
 * - Anything else (`IDLE_TASK`): one line.
 *
 * @module
 */

export const AUTO_TASK = "compaction prefix auto"
export const IDLE_TASK = "compaction prefix idle"
export const BACKGROUND_TASK = "compaction prefix background"

/** The memory note the run's digest carries. */
export const NOTE = "The user runs the gate before every push"

export const ANSWER = "sim: prefix answer"
export const SUMMARY = "## Objective\n- sim: the session's summary"

/** The idle run's cache lifetime and margin: the idle compaction is due 5 s after the turn's request. */
export const TTL_SECONDS = 8
export const MARGIN_SECONDS = 3

export type Kind = "title" | "compaction" | "turn"

/** One request as the sim got it: its kind and its whole body. */
export interface Seen {
  readonly kind: Kind
  readonly at: number
  readonly body: ChatRequest
}

export interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

export interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<unknown>
}

type Reply = (
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "shell"; readonly command: string }
) & { readonly prompt: number }

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

const replyOf = (kind: Kind, request: ChatRequest): Reply => {
  if (kind === "title") return { kind: "text", text: "Prefix run", prompt: 100 }
  if (kind === "compaction") return { kind: "text", text: SUMMARY, prompt: 1_000 }
  const messages = request.messages ?? []
  const first = text(messages.find((message) => message.role === "user")?.content)
  const started = messages.some((message) => message.role === "tool")
  if (first.includes(AUTO_TASK)) return started ? { kind: "text", text: ANSWER, prompt: 1_000 } : { kind: "shell", command: "true", prompt: 120_000 }
  if (first.includes(BACKGROUND_TASK)) return started ? { kind: "text", text: ANSWER, prompt: 90_000 } : { kind: "shell", command: "true", prompt: 20_000 }
  return { kind: "text", text: ANSWER, prompt: 1_000 }
}

const events = (answer: Reply, model: string, id: string): string => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const usage = {
    prompt_tokens: answer.prompt,
    completion_tokens: 10,
    total_tokens: answer.prompt + 10,
    prompt_tokens_details: { cached_tokens: Math.floor(answer.prompt / 2), cache_write_tokens: Math.floor(answer.prompt / 4) },
  }
  const body =
    answer.kind === "text"
      ? [chunk({ content: answer.text }, null), chunk({}, "stop")]
      : [
          chunk(
            { tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: answer.command }) } }] },
            null,
          ),
          chunk({}, "tool_calls"),
        ]
  const list: unknown[] = [chunk({ role: "assistant", content: "" }, null), ...body, { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage }]
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** Serves the scripted model; `seen` holds every request, in the order they came. */
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
      seen.push({ kind, at: Date.now(), body })
      served += 1
      return new Response(events(replyOf(kind, body), body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, seen }
}
