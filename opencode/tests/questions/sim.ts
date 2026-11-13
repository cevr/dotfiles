/**
 * The scripted model for the two-location questions run: an OpenAI-compatible
 * chat endpoint on a loopback port that answers by the conversation it is sent.
 *
 * - `questions ask`: asks one question through `ask_user_async`, then answers
 *   `ASKED`; once the answer's letter is in the conversation, `ANSWERED`.
 * - `questions root`: `ROOT_TOLD` once the notice of its subagent's answer is
 *   in the conversation, else `ROOT_UNTOLD`.
 * - anything else (the other location's session): `IDLE` at once.
 *
 * The root task, the subagent's names and the message predicates serve the
 * simulated run (cmd/questions/questions-locations.sim.test.ts), whose model
 * answers the same way.
 *
 * @module
 */

export const ASK_TASK = "questions ask"
export const IDLE_TASK = "questions idle"
/** The root session of the subagent run: it answers by whether the notice of its subagent's answer is in its conversation. */
export const ROOT_TASK = "questions root"
export const ROOT_UNTOLD = "sim: root has no word of the subagent's question"
export const ROOT_TOLD = "sim: root knows the subagent's question was answered"
/** What the root's notice opens with (mods/questions/reply.ts `noticeOf`), for the subagent titled `SUBAGENT`. */
export const SUBAGENT = "implementor auth r1"
export const NOTICE = `The subagent ${SUBAGENT} had its background question q1 answered`
export const ASKED = "sim: asked, carrying on with SQLite"
export const ANSWERED = "sim: switched to Redis"
export const IDLE = "sim: nothing to do here"
/** What the answer's letter opens with (mods/questions/reply.ts). */
export const LETTER = "Answer to your background question q1"

export const QUESTION = {
  question: "Which database should the cache use?",
  header: "Cache store",
  options: [{ label: "SQLite" }, { label: "Redis" }],
  assume: "SQLite",
}

/** A session message as the SDK's `sessions.context` lists it, as much as the run and the test read. */
export interface Message {
  readonly type?: string
  readonly metadata?: { readonly source?: string; readonly notice?: unknown }
}
/** A session's messages, from `sessions.context`'s answer (a list, or `{ messages }`). */
export const messagesOf = (context: unknown): ReadonlyArray<Message> => {
  const list = Array.isArray(context) ? context : (context as { messages?: unknown } | undefined)?.messages
  return Array.isArray(list) ? (list as ReadonlyArray<Message>) : []
}
/** OpenCode's idle report of a subagent, in its parent. */
export const isReport = (message: Message) => message.type === "synthetic" && message.metadata?.source === "subagent"
/** The questions plugin's notice to a root that its subagent's question was answered. */
export const isNotice = (message: Message) => message.metadata?.source === "questions" && message.metadata.notice !== undefined
/** Whether an assistant turn follows the last message that `is` matches. */
export const answeredAfter = (messages: ReadonlyArray<Message>, is: (message: Message) => boolean) => {
  const at = messages.findLastIndex(is)
  return at >= 0 && messages.slice(at + 1).some((message) => message.type === "assistant")
}

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

/** Serves the scripted model. */
export const serve = () => {
  let served = 0
  const reply = (request: ChatRequest): Reply => {
    const messages = request.messages ?? []
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => text(message.content))
      .join("\n")
    if (system.includes("You name conversations")) return { kind: "text", text: "Questions run" }
    const task = text(messages.find((message) => message.role === "user")?.content).trim()
    const conversation = messages.map((message) => text(message.content)).join("\n")
    if (task.endsWith(ROOT_TASK)) return { kind: "text", text: conversation.includes(NOTICE) ? ROOT_TOLD : ROOT_UNTOLD }
    if (!task.endsWith(ASK_TASK)) return { kind: "text", text: IDLE }
    if (conversation.includes(LETTER)) return { kind: "text", text: ANSWERED }
    if (messages.some((message) => message.role === "tool")) return { kind: "text", text: ASKED }
    return { kind: "tool", name: "ask_user_async", input: { questions: [QUESTION] } }
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
  return { server }
}
