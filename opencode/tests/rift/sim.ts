/**
 * The scripted model for the rift test: an OpenAI-compatible chat endpoint on
 * a loopback port that answers by the conversation it is sent. Each request is
 * kept for the test. Each next call comes once the last one's result is back.
 *
 * - A title request: a short title.
 * - The task `rift flow`: create a Rift for `feat/x`; commit in it through the
 *   shell; list; remove it (refused: the commit is found nowhere else); remove
 *   it with force; call `shll`, a one-letter miss of `shell`; call
 *   `opencode_worktree_create`, which the rift plugin took away; then a
 *   closing line.
 * - Anything else: one line.
 *
 * @module
 */

export const TASK = "rift flow"
export const DONE = "sim: rift done"
export const BRANCH = "feat/x"
export const COMMIT_SUBJECT = "only here"

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string; readonly description?: string } }>
}

/** The names the test looks for in each request: the worktree tools, and a sibling of theirs that stays. */
export const WATCHED = ["worktree_create", "worktree_list", "worktree_remove", "session_move"] as const

/** What the test reads back about one request. */
export interface Seen {
  readonly task: string
  readonly tools: ReadonlyArray<string>
  /** Which of these names the whole request carries anywhere (a tool, Code Mode's catalog, the system prompt). */
  readonly named: ReadonlyArray<string>
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

/** The calls of the flow, for a Rift that will be made at `rift`. */
const script = (rift: string): ReadonlyArray<Reply> => [
  { kind: "tool", name: "rift", input: { action: "create", branch: BRANCH } },
  {
    kind: "tool",
    name: "shell",
    input: { command: `git -c user.name=sim -c user.email=sim@example.com -c commit.gpgsign=false commit --allow-empty -q -m "${COMMIT_SUBJECT}"`, workdir: rift, description: "Commit in the Rift" },
  },
  { kind: "tool", name: "rift", input: { action: "list" } },
  { kind: "tool", name: "rift", input: { action: "remove", name: "feat-x" } },
  { kind: "tool", name: "rift", input: { action: "remove", name: "feat-x", force: true } },
  { kind: "tool", name: "shll", input: { command: "echo never", description: "A misspelled tool" } },
  { kind: "tool", name: "opencode_worktree_create", input: { name: "x" } },
]

/** Serves the scripted model for a Rift that will be made at `rift`. */
export const serve = (rift: string) => {
  const seen: Seen[] = []
  let served = 0
  const reply = (request: ChatRequest): Reply => {
    const messages = request.messages ?? []
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => text(message.content))
      .join("\n")
    if (system.includes("You name conversations")) return { kind: "text", text: "Rift run" }
    if (!firstUser(messages).endsWith(TASK)) return { kind: "text", text: "sim: nothing to do" }
    return script(rift)[messages.filter((message) => message.role === "tool").length] ?? { kind: "text", text: DONE }
  }
  const events = (answer: Reply, model: string, id: string): string => {
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      seen.push({
        task: firstUser(body.messages ?? []),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
        named: WATCHED.filter((name) => JSON.stringify(body).includes(name)),
      })
      served += 1
      return new Response(events(reply(body), body.model ?? "sim", `sim${served}`), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  return { server, seen }
}
