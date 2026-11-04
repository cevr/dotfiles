/**
 * A scripted OpenAI-compatible chat model for gamut's `sim` preset:
 * `bun testbeds/gamut/sim-model.ts <port file>`.
 *
 * It listens on a free loopback port, writes the port to `<port file>` and
 * answers `POST …/chat/completions` with a streamed reply until it is killed.
 * It reaches no network and holds no credential: OpenCode sends it the
 * preset's placeholder key. The script, per request:
 *
 * - a title request (the system prompt says "You name conversations"): a
 *   short title;
 * - the last message is the user's and the request offers `shell`: one
 *   `shell` call that runs `bun test` in the work dir;
 * - otherwise (a tool result came back, or no shell is offered): a text reply
 *   that quotes the last line of the tool's output, or of the user's text.
 *
 * The reply is the same for the same request, so a run on it is a
 * deterministic check of gamut's commands against a real OpenCode.
 *
 * @module
 */

/** One message of an OpenAI chat request, as much of it as the script reads. */
interface ChatMessage {
  readonly role: string
  readonly content?: unknown
}

export interface ChatRequest {
  readonly model?: string
  readonly messages?: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>
}

export type SimReply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> }

/** The command the scripted turn runs. Its summary line is what the reply quotes. */
export const SIM_COMMAND = "bun test 2>&1 | tail -n 4"

export const SIM_TITLE = "Ledgerline red suite"

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .join("")
  }
  return ""
}

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? ""

/** What the scripted model answers `request` with. */
export const simReply = (request: ChatRequest): SimReply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: SIM_TITLE }
  const last = messages.at(-1)
  const offersShell = (request.tools ?? []).some((tool) => tool.function?.name === "shell")
  if (last?.role === "user" && offersShell) {
    return { kind: "tool", name: "shell", input: { command: SIM_COMMAND } }
  }
  if (last?.role === "tool") {
    return { kind: "text", text: `sim: the suite says ${lastLine(contentText(last.content)) || "nothing"}` }
  }
  return { kind: "text", text: `sim: you said ${lastLine(contentText(last?.content)) || "nothing"}` }
}

/** The reply as the server-sent events of a streamed chat completion. */
export const replyEvents = (reply: SimReply, model: string, id: string): ReadonlyArray<string> => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const events: unknown[] = [chunk({ role: "assistant", content: "" }, null)]
  if (reply.kind === "text") {
    for (const word of reply.text.split(/(?<= )/)) events.push(chunk({ content: word }, null))
    events.push(chunk({}, "stop"))
  } else {
    events.push(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${id}`,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.input) },
            },
          ],
        },
        null,
      ),
    )
    events.push(chunk({}, "tool_calls"))
  }
  events.push({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  })
  return [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"]
}

/** Serve the scripted model on a free loopback port. */
export const serveSim = () => {
  let served = 0
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }
      const body = (await request.json()) as ChatRequest
      served += 1
      const events = replyEvents(simReply(body), body.model ?? "sim", `sim${served}`)
      return new Response(events.join(""), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
}

if (import.meta.main) {
  const portFile = Bun.argv[2]
  if (portFile === undefined) {
    console.error("usage: bun sim-model.ts <port file>")
    process.exit(2)
  }
  const server = serveSim()
  await Bun.write(portFile, `${server.port}\n`)
  console.log(`sim model on http://127.0.0.1:${server.port}`)
}
