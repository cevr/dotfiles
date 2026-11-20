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
 * - The task `kernel attach`: one `kernel` call that attaches the work dir's
 *   pixel.png, then a closing line.
 * - The task `kernel memory`, when `memory_save` is offered directly: one
 *   direct `memory_save` call, then a closing line.
 * - The task `<shell line>\nkernel drop`: one `kernel` call whose cell starts `implementor alpha r1` and then
 *   runs the shell line through `tools.shell`, then a closing line.
 * - The task `<sessionID>\nkernel stop`: one `kernel` call whose cell starts a worker on the stall task, stops it,
 *   and checks its shell never ended on its own, then a closing line.
 * - The task `kernel report`: one `kernel` call whose cell starts a worker on `REPORT_CHILD` and returns, then a
 *   closing line; once the worker's report arrives as the parent's next message, `REPORT_HEARD`.
 * - The task `REPORT_CHILD` (that worker's): one line, held until the run releases it (`release`) once the parent's
 *   turn ended.
 * - The task `kernel stall` (that worker's): a background shell call, then, once its result is back, an answer that
 *   opens and never ends (`stalls`).
 * - Anything else: one line.
 *
 * @module
 */

import { envelope } from "../../mods/subagents/envelope.ts"

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
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string; readonly description?: string } }>
}

/** What the test reads back about one request. */
export interface Seen {
  readonly task: string
  readonly last: string
  readonly tools: ReadonlyArray<string>
  /** The kernel's description as offered, when it was. */
  readonly kernel?: string
  /** The image URLs the request's messages carry, when they carry any. */
  readonly images?: ReadonlyArray<string>
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

/** The URL of each `image_url` part in the messages, in order. */
const imagesOf = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<string> =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "image_url" &&
          "image_url" in part &&
          typeof part.image_url === "object" &&
          part.image_url !== null &&
          "url" in part.image_url &&
          typeof part.image_url.url === "string"
            ? [part.image_url.url]
            : [],
        )
      : [],
  )

const firstUser = (messages: ReadonlyArray<ChatMessage>) =>
  text(messages.find((message) => message.role === "user")?.content).trim()

export const SUBAGENT_TASK = "kernel subagent"
/** One kernel call that starts a subagent from a cell and prints why it could not. */
export const SUBAGENT_CELL = `try {\n  await tools.subagent({ agent: "worker", description: "probe from a cell", prompt: "Say hi" })\n  console.log("started")\n} catch (error) {\n  console.log("refused: " + (error instanceof Error ? error.message : String(error)))\n}`

/**
 * A subagent's task the model never finishes: its first answer starts a background shell (`LATE_COMMAND`), and its
 * next one, once the shell's call is back, streams a first chunk and then holds.
 */
export const STALL_TASK = "kernel stall"
/** The file the stall task's shell writes once it ran its course: a stopped child's shell never does. */
export const LATE_FILE = "late.txt"
/** The stall task's background shell: long enough to outlast the stop, short enough for the cell to see it would have ended. */
export const LATE_COMMAND = `sleep 6; echo late > ${LATE_FILE}`
/** The prompt the run queues to the stalled child (run.ts): a stopped child never runs it. */
export const QUEUED_PROMPT = "kernel queued follow-up"
/** Where a task names its own session, which the run replaces with the session's id (run.ts). */
export const SELF = "{self}"
/** The stop task, after its own session's id: `<sessionID>\nkernel stop`. */
export const STOP_TASK = "kernel stop"
/**
 * One kernel call that starts a worker on the stall task, reads it after a few seconds, stops it twice, waits
 * past the time its shell would have ended and reads it again, then asks the subagents tool to stop its own
 * session, no subagent of itself; it prints a line of what each step did.
 */
const stopCell = (task: string) =>
  [
    `const seen = []`,
    `const h = await tools.subagent({ agent: "worker", description: "stop probe", prompt: "${STALL_TASK}" })`,
    `await new Promise((resolve) => setTimeout(resolve, 3000))`,
    `await h.refresh()`,
    "seen.push(`read: ${h.state}`)",
    `await h.stop()`,
    "seen.push(`stopped: ${h.state}, ${h.note}`)",
    `await h.stop()`,
    "seen.push(`again: ${h.state}, ${h.note}`)",
    // Past the end the shell would have had: had it lived, it wrote its file, and its notice woke the child.
    `await new Promise((resolve) => setTimeout(resolve, 5000))`,
    `await h.refresh()`,
    "seen.push(`later: ${h.state}`)",
    `const late = await tools.shell({ command: "test -e ${LATE_FILE} && echo written || echo none" })`,
    `await late.wait()`,
    "seen.push(`late file: ${late.output.trim()}`)",
    `try {`,
    `  await tools.subagents({ action: "stop", sessionID: "${task.slice(0, -STOP_TASK.length).trim()}" })`,
    `  seen.push("other: stopped")`,
    `} catch (error) {`,
    "  seen.push(`other: ${error.message}`)",
    `}`,
    `seen.join("\\n")`,
  ].join("\n")

export const REPORT_TASK = "kernel report"
/** The worker's prompt in the report task; its answer waits for `release`. */
export const REPORT_CHILD = "child: say hi late"
/** The parent's answer to a finished subagent's report. */
export const REPORT_HEARD = "sim: heard the subagent's report"
/** One kernel call that starts a worker and returns at once: its report comes later, as the parent's next message. */
const reportCell = () => `await tools.subagent({ agent: "worker", description: "report probe", prompt: "${REPORT_CHILD}" })\n"started"`

/** The drop task, after its shell line: `<line>\nkernel drop`. */
export const DROP_TASK = "kernel drop"
/**
 * One kernel call that starts alpha's implementor, runs the drop task's shell line (no backtick in it) through
 * `tools.shell`, and prints the shell's output.
 */
const dropCell = (task: string) =>
  [
    `await tools.subagent({ agent: "implementor", description: "implementor alpha r1", prompt: "Say hi" })`,
    `const run = await tools.shell({ command: \`${task.slice(0, -DROP_TASK.length).trim()}\` })`,
    `await run.wait()`,
    `run.output`,
  ].join("\n")

export const ATTACH_TASK = "kernel attach"
/** The image the attach task's cell attaches, in the work dir. */
export const PIXEL_FILE = "pixel.png"
/** The smallest PNG: one transparent pixel, base64. */
export const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
/** One kernel call that attaches the pixel by its path relative to the session's directory. */
export const ATTACH_CELL = `attach(${JSON.stringify(PIXEL_FILE)})`

export const SHELL_TASK = "kernel shell"
/** One kernel call that runs commands through `tools.shell` and prints what each handle method showed. */
export const SHELL_CELL = [
  `const seen = {}`,
  `const fg = await tools.shell({ command: "printf 'fg-out\\\\n'" })`,
  `seen.fgRun = fg.output`,
  `await fg.wait()`,
  `seen.fgWait = fg.output`,
  `await fg.refresh()`,
  `seen.fgRefresh = fg.output`,
  `seen.chained = (await (await tools.shell({ command: "printf 'chained\\\\n'" })).wait()).output`,
  `const bg = await tools.shell({ command: "sleep 0.3; printf 'bg-out\\\\n'", background: true })`,
  `seen.bgRun = bg.output`,
  `await bg.wait()`,
  `seen.bgWait = bg.output`,
  `const quick = await tools.shell({ command: "printf 'quick\\\\n'", background: true })`,
  `await quick.wait()`,
  `seen.quickWait = quick.output`,
  `const both = await tools.shell({ command: "printf 'first\\\\n'; sleep 1; printf 'last\\\\n'", timeout: 300 })`,
  `seen.bothRun = both.output`,
  `await both.wait()`,
  `seen.bothWait = both.output`,
  `JSON.stringify(seen)`,
].join("\n")

export const MEMORY_TASK = "kernel memory"
/** The note the memory task saves with a direct `memory_save` call. */
export const MEMORY_NOTE = "The owner keeps the kernel's memory tools direct."

/** The two kernel calls; the first reads `file` through the kernel's `tools`. */
export const cells = (file: string) => [
  `let note = "kept"\nconst page = await tools.read({ path: ${JSON.stringify(file)} })\nconsole.log(JSON.stringify(page))\nnote.length`,
  `note + "!"`,
]

/** The tasks that run one kernel cell and then close, each with its cell (from the task's text). */
const ONE_CELL: ReadonlyArray<readonly [string, (task: string) => string]> = [
  [SUBAGENT_TASK, () => SUBAGENT_CELL],
  [STOP_TASK, stopCell],
  [REPORT_TASK, reportCell],
  [DROP_TASK, dropCell],
  [SHELL_TASK, () => SHELL_CELL],
  [ATTACH_TASK, () => ATTACH_CELL],
]

/** The stall task's first answer: its background shell, called directly when the shell is offered, else from a cell. */
const startLate = (request: ChatRequest): Reply => {
  if ((request.tools ?? []).some((tool) => tool.function?.name === "shell"))
    return { kind: "tool", name: "shell", input: { command: LATE_COMMAND, description: "late write", background: true } }
  return { kind: "tool", name: "kernel", input: { code: `await tools.shell({ command: "${LATE_COMMAND}", background: true })` } }
}

/** Whether a message is a subagent's idle report: its envelope, in either form (envelope.ts). */
export const isReport = (said: string) => envelope(said, "subagent") !== undefined

/** A one-cell task's last line: the report task's answer to its subagent's report once it arrives, else `DONE`. */
const closing = (task: string, messages: ReadonlyArray<ChatMessage>) => {
  if (task.endsWith(REPORT_TASK) && isReport(text(messages.at(-1)?.content))) return REPORT_HEARD
  return DONE
}

const reply = (request: ChatRequest, file: string): Reply => {
  const messages = request.messages ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n")
  if (system.includes("You name conversations")) return { kind: "text", text: "Kernel run" }
  const results = messages.filter((message) => message.role === "tool").length
  const offersKernel = (request.tools ?? []).some((tool) => tool.function?.name === "kernel")
  const task = firstUser(messages)
  if (task.endsWith(STALL_TASK)) return startLate(request)
  for (const [name, cell] of ONE_CELL)
    if (task.endsWith(name) && offersKernel) return results === 0 ? { kind: "tool", name: "kernel", input: { code: cell(task) } } : { kind: "text", text: closing(task, messages) }
  const offersSave = (request.tools ?? []).some((tool) => tool.function?.name === "memory_save")
  if (firstUser(messages).endsWith(MEMORY_TASK) && offersSave)
    return results === 0 ? { kind: "tool", name: "memory_save", input: { text: MEMORY_NOTE, scope: "global" } } : { kind: "text", text: DONE }
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

/** Whether the request is the stall task's answer after its shell's call: the one that opens and never ends. */
const stalls = (messages: ReadonlyArray<ChatMessage>, system: string) =>
  firstUser(messages).endsWith(STALL_TASK) && !system.includes("You name conversations") && messages.some((message) => message.role === "tool")

/** Serves the scripted model; `file` is the path the first kernel call reads. */
export const serve = (file: string) => {
  const seen: Seen[] = []
  let served = 0
  /** The report task's worker's answers waiting for `release`, whether it came, and how many it sent that had waited. */
  const held: Array<() => void> = []
  const released = { value: false, waited: 0 }
  /** Sends the report task's worker's answers that wait, and from now on each at once. */
  const release = () => {
    released.value = true
    released.waited += held.length
    for (const send of held.splice(0)) send()
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held answer waits for the parent's whole turn: past Bun's default 10 s idle cut, up to its 255 s most.
    idleTimeout: 255,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      const messages = body.messages ?? []
      seen.push({
        task: firstUser(messages),
        last: text(messages.at(-1)?.content),
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
        ...(() => {
          const kernel = (body.tools ?? []).find((tool) => tool.function?.name === "kernel")?.function?.description
          return kernel === undefined ? {} : { kernel }
        })(),
        ...(() => {
          const images = imagesOf(messages)
          return images.length === 0 ? {} : { images }
        })(),
      })
      served += 1
      const system = messages.filter((message) => message.role === "system").map((message) => text(message.content)).join("\n")
      const model = body.model ?? "sim"
      // The stall task's answer after its shell's call opens (its first event, the assistant's role) and never ends,
      // until the request is aborted.
      if (stalls(messages, system)) {
        const opening = `${events({ kind: "text", text: "" }, model, `sim${served}`).split("\n\n")[0]}\n\n`
        return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(opening)) }), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      // The report task's worker answers only once the run releases it: after the parent's turn ended.
      // A worker's first user message holds more than its prompt, which ends it, as every task here does.
      if (firstUser(messages).endsWith(REPORT_CHILD) && !system.includes("You name conversations")) {
        const answer = new TextEncoder().encode(events(reply(body, file), model, `sim${served}`))
        return new Response(
          new ReadableStream({
            start: (controller) => {
              const send = () => {
                controller.enqueue(answer)
                controller.close()
              }
              if (released.value) send()
              else held.push(send)
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        )
      }
      return new Response(events(reply(body, file), model, `sim${served}`), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  /** How many of the report task's worker's answers waited for `release` before they were sent. */
  const waited = () => released.waited
  return { server, seen, release, waited }
}
