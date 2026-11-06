/**
 * The scripted model for the orchestrate tests: an OpenAI-compatible chat
 * endpoint on a loopback port that answers by the conversation it is sent,
 * so the same run gives the same requests. Each request is kept for the test.
 *
 * - A title request: a short title.
 * - The root's task, `orchestrate`: a `subagent` call with no agent, then one
 *   asking for `orchestrate-reviewer` (the verifier's former name), then a
 *   closing line. Each next call comes once the last one's result is back.
 * - A unit run's root task, `units <unit dir>`: a `subagent` call starting
 *   the implementor of `auth` round 1, whose prompt ends `handback: <line>`,
 *   then a closing line.
 * - A task whose last line is `handback: <line>`: that line, then another.
 * - A compaction request: a summary in OpenCode's template.
 * - Anything else (a subagent's task, a plain prompt): one line that quotes
 *   the last thing it was told.
 *
 * Every reply reports `promptTokens` tokens of input, so a test can set how
 * full the context looks.
 *
 * @module
 */

export const ROOT_TASK = "orchestrate"
export const UNTYPED_TASK = "task-untyped"
export const REVIEW_TASK = "task-review"
export const SUMMARY = "## Objective\n- sim summary"
/** The root's task in a unit run: `units <unit dir>`. */
export const UNITS_TASK = "units"
/** A task whose last line is `handback: <line>` answers with that line first. */
export const HAND_BACK = "handback:"
/** A root task that calls one foreground subagent on `HANG_TASK`, then closes. */
export const RESTART_TASK = "restart-root"
/** The same, for the root the user interrupts. */
export const ESCAPE_TASK = "escape-root"
/** A subagent task whose first request hangs until the sim is released: the turn a shutdown cuts. */
export const HANG_TASK = "task-hang"

export interface ChatMessage {
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
  readonly system: string
  readonly task: string
  readonly last: string
  readonly tools: ReadonlyArray<string>
  /** The request's messages as sent, for prefix checks. */
  readonly messages: ReadonlyArray<ChatMessage>
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

const lastLine = (value: string): string =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? ""

export const reply = (request: ChatRequest): Reply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: "Orchestrate run" }
  const last = text(messages.at(-1)?.content)
  if (last.includes("You MUST summarize the conversation")) return { kind: "text", text: SUMMARY }
  const task = lastLine(text(messages.find((message) => message.role === "user")?.content))
  const results = messages.filter((message) => message.role === "tool").length
  const offersSubagent = (request.tools ?? []).some((tool) => tool.function?.name === "subagent")
  // A unit run: the root starts an implementor on the unit dir it names, and the implementor hands back.
  if (task.startsWith(UNITS_TASK) && offersSubagent) {
    const dir = task.slice(UNITS_TASK.length).trim()
    if (results === 0)
      return {
        kind: "tool",
        name: "subagent",
        input: { agent: "implementor", description: "implementor auth r1", prompt: `Spec: ${dir}/spec.md\n${HAND_BACK} implementor auth r1: ready ${dir}/round-1-request.md` },
      }
    return { kind: "text", text: "root: the implementor handed back" }
  }
  if (task.startsWith(HAND_BACK)) return { kind: "text", text: `${task.slice(HAND_BACK.length).trim()}\nThe gate is green.` }
  if (task === ROOT_TASK && offersSubagent) {
    if (results === 0)
      return { kind: "tool", name: "subagent", input: { description: "Untyped task", prompt: UNTYPED_TASK } }
    if (results === 1)
      return {
        kind: "tool",
        name: "subagent",
        input: { agent: "orchestrate-reviewer", description: "Review task", prompt: REVIEW_TASK },
      }
    return { kind: "text", text: "root: both subagents answered" }
  }
  if ((task === RESTART_TASK || task === ESCAPE_TASK) && offersSubagent) {
    if (results === 0) return { kind: "tool", name: "subagent", input: { description: `${task} child`, prompt: HANG_TASK } }
    return { kind: "text", text: "root: the subagent is back" }
  }
  return { kind: "text", text: `sim: ${lastLine(last) || "nothing"}` }
}

const events = (answer: Reply, model: string, id: string, promptTokens: number): string => {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const list: unknown[] = [chunk({ role: "assistant", content: "" }, null)]
  if (answer.kind === "text") {
    list.push(chunk({ content: answer.text }, null), chunk({}, "stop"))
  } else {
    list.push(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${id}`,
              type: "function",
              function: { name: answer.name, arguments: JSON.stringify(answer.input) },
            },
          ],
        },
        null,
      ),
      chunk({}, "tool_calls"),
    )
  }
  list.push({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 },
  })
  return [...list.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

export const serve = (promptTokens = 100) => {
  const seen: Seen[] = []
  let served = 0
  // Hanging requests, and whether a hang task's first request still hangs.
  let hanging = 0
  let released = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      const messages = body.messages ?? []
      seen.push({
        system: messages
          .filter((message) => message.role === "system")
          .map((message) => text(message.content))
          .join("\n"),
        task: lastLine(text(messages.find((message) => message.role === "user")?.content)),
        last: text(messages.at(-1)?.content),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
        messages,
      })
      served += 1
      const task = lastLine(text(messages.find((message) => message.role === "user")?.content))
      if (task === HANG_TASK && lastLine(text(messages.at(-1)?.content)) === HANG_TASK && !released) {
        hanging += 1
        // An open stream that never ends: the request runs until the server's shutdown cuts it.
        return new Response(new ReadableStream({ start: () => {} }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      }
      return new Response(events(reply(body), body.model ?? "sim", `sim${served}`, promptTokens), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return {
    server,
    seen,
    /** How many requests hang now or did. */
    hanging: () => hanging,
    /** From now on a hang task answers. */
    release: () => {
      released = true
    },
  }
}
