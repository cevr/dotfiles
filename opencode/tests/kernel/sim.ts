/**
 * The scripted model for the kernel test: an OpenAI-compatible chat endpoint on
 * a loopback port that answers by the conversation it is sent. Each request is
 * kept for the test.
 *
 * - A title request: a short title.
 * - The task `kernel`: a `kernel` call that binds `note` and reads the work
 *   dir's hello.txt through `tools.read`, then a second `kernel` call that
 *   reads `note` back, then a closing line. Each next call comes once the last
 *   one's result is back.
 * - Anything else: one line.
 *
 * @module
 */

export const KERNEL_TASK = "kernel"
export const HELLO = "hello from the work dir"
export const DONE = "sim: kernel done"

interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>
}

/** What the test reads back about one request. */
export interface Seen {
  readonly task: string
  readonly last: string
  readonly tools: ReadonlyArray<string>
}

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> }

const text = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const firstUser = (messages: ReadonlyArray<ChatMessage>) =>
  text(messages.find((message) => message.role === "user")?.content).trim()

/** The two kernel calls; the first reads `file` through the kernel's `tools`. */
export const cells = (file: string) => [
  `let note = "kept"\nconst page = await tools.read({ path: ${JSON.stringify(file)} })\nconsole.log(JSON.stringify(page))\nnote.length`,
  `note + "!"`,
]

const reply = (request: ChatRequest, file: string): Reply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: "Kernel run" }
  const results = messages.filter((message) => message.role === "tool").length
  const offersKernel = (request.tools ?? []).some((tool) => tool.function?.name === "kernel")
  if (firstUser(messages).endsWith(KERNEL_TASK) && offersKernel) {
    const code = cells(file)[results]
    if (code !== undefined) return { kind: "tool", name: "kernel", input: { code } }
    return { kind: "text", text: DONE }
  }
  return { kind: "text", text: "sim: nothing to do" }
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
      chunk(
        {
          tool_calls: [
            { index: 0, id: `call_${id}`, type: "function", function: { name: answer.name, arguments: JSON.stringify(answer.input) } },
          ],
        },
        null,
      ),
      chunk({}, "tool_calls"),
    )
  list.push({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** Serves the scripted model; `file` is the path the first kernel call reads. */
export const serve = (file: string) => {
  const seen: Seen[] = []
  let served = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      const messages = body.messages ?? []
      seen.push({
        task: firstUser(messages),
        last: text(messages.at(-1)?.content),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
      })
      served += 1
      return new Response(events(reply(body, file), body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, seen }
}
