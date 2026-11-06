/**
 * The scripted model for the guard test: an OpenAI-compatible chat endpoint on
 * a loopback port that answers by the conversation it is sent. Each request is
 * kept for the test. Each next call comes once the last one's result is back.
 *
 * - A title request: a short title.
 * - The task `guard direct` (the kernel beside the direct tools): a direct
 *   `shell` call of `git reset --hard`, a `kernel` call whose cell tries
 *   `tools.shell` with it, a direct `shell` call of the harmless command,
 *   then a closing line.
 * - The task `guard cell` (the kernel is the runtime): one `kernel` call whose
 *   cell tries `tools.shell` with `git reset --hard` and then runs the
 *   harmless command through it, then a closing line.
 * - The task `guard sleep`: a foreground `subagent` call whose child (the
 *   task `guard sleep in a subagent`) makes a `shell` call opening with
 *   `sleep 60`, then the root's own `shell` call opening with `sleep 30`,
 *   moved to the background after a second, then a closing line.
 * - Anything else: one line.
 *
 * @module
 */

export const SLEEP_TASK = "guard sleep"
export const SLEEP_CHILD_TASK = "guard sleep in a subagent"
/** The subagent's opening sleep, which the guard refuses. */
export const CHILD_SLEEP = "sleep 60 && echo child slept"
/** The root's, which runs. */
export const ROOT_SLEEP = "sleep 30 && echo root slept"
export const DIRECT_TASK = "guard direct"
export const CELL_TASK = "guard cell"
export const DONE = "sim: guard done"
export const RESET = "git reset --hard"
/** What the harmless command prints; it also writes `HARMLESS_FILE` in the work dir. */
export const HARMLESS_OUT = "harmless ran"
export const HARMLESS_FILE = "harmless.txt"
export const HARMLESS = `echo ${JSON.stringify(HARMLESS_OUT)} && echo ${JSON.stringify(HARMLESS_OUT)} > ${HARMLESS_FILE}`

/** A cell's call of `tools.shell`, printing its output or why it threw. */
const tryShell = (command: string) =>
  `try {\n  const ran = await tools.shell({ command: ${JSON.stringify(command)}, description: "probe from a cell" })\n  console.log("ran: " + JSON.stringify(ran))\n} catch (error) {\n  console.log("refused: " + (error instanceof Error ? error.message : String(error)))\n}`

/** The cell of the direct run: the kernel is not the runtime, so `tools.shell` is out of a cell's reach. */
export const DIRECT_CELL = tryShell(RESET)
/** The cell of the cell run: the reset is refused, the harmless command runs. */
export const CELL = `${tryShell(RESET)}\n${tryShell(HARMLESS)}`

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
  readonly tools: ReadonlyArray<string>
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

const SCRIPTS: Readonly<Record<string, ReadonlyArray<Reply>>> = {
  [SLEEP_TASK]: [
    { kind: "tool", name: "subagent", input: { agent: "general", description: "Sleep probe", prompt: SLEEP_CHILD_TASK } },
    // The root's own sleep runs: it moves to the background after a second, so the run does not wait it out.
    { kind: "tool", name: "shell", input: { command: ROOT_SLEEP, description: "Sleep in the root", timeout: 1_000 } },
  ],
  [SLEEP_CHILD_TASK]: [{ kind: "tool", name: "shell", input: { command: CHILD_SLEEP, description: "Sleep in the subagent" } }],
  [DIRECT_TASK]: [
    { kind: "tool", name: "shell", input: { command: RESET, description: "Reset the work tree" } },
    { kind: "tool", name: "kernel", input: { code: DIRECT_CELL } },
    { kind: "tool", name: "shell", input: { command: HARMLESS, description: "Run a harmless command" } },
  ],
  [CELL_TASK]: [{ kind: "tool", name: "kernel", input: { code: CELL } }],
}

const reply = (request: ChatRequest): Reply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: "Guard run" }
  const task = firstUser(messages)
  const script = Object.entries(SCRIPTS).find(([name]) => task.endsWith(name))?.[1]
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
      seen.push({ task: firstUser(body.messages ?? []), tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "") })
      served += 1
      return new Response(events(reply(body), body.model ?? "sim", `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, seen }
}
