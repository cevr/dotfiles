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
 * Every reply reports `promptTokens` tokens of input, or as many as it gives
 * for the conversation's task, so a test can set how full a context looks.
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
/** A root turn that makes one given call: `probe:` and `{ name, input }` as JSON. */
export const PROBE = "probe:"
/** A root task that calls one foreground subagent on `HANG_TASK`, then closes. */
export const RESTART_TASK = "restart-root"
/** The same, for the root the user interrupts. */
export const ESCAPE_TASK = "escape-root"
/** A subagent task whose first request hangs until the sim is released: the turn a shutdown cuts. */
export const HANG_TASK = "task-hang"

/**
 * The root's task in a machine run: three implementors, then (after the
 * compaction its context forces) a verifier for one unit and a land of one
 * Rift, which the plugin refuses, then the batch's land and its verifier.
 * The script keys on the last thing the root was told (`machineStep`), never
 * on a count of tool results: the compaction removes them.
 */
export const MACHINE_TASK = "machine-run"
/** The machine run's summary: the root's context after its compaction. */
export const MACHINE_SUMMARY = "## Objective\n- machine-run summary: three implementors handed back ready"
/** The input tokens the reply that starts the third implementor reports: past the root's window, so it compacts. */
export const MACHINE_FULL = 500_000

/** What the machine run's root was last told, newest first, and what it does next. */
const MACHINE_SCRIPT: ReadonlyArray<readonly [string, Reply]> = [
  ["verifier batch-1 r1: accepted", { kind: "text", text: "root: batch-1 landed and verified" }],
  [
    "Landed 3 Rift(s)",
    { kind: "tool", name: "subagent", input: { agent: "verifier", description: "verifier batch-1 r1", prompt: `${HAND_BACK} verifier batch-1 r1: accepted /run/batch-1-findings.md` } },
  ],
  ["Land every ready unit at once when the cadence fires", { kind: "tool", name: "rift", input: { action: "land", rifts: ["alpha", "beta", "gamma"] } }],
  ["One verifier per batch, fresh", { kind: "tool", name: "rift", input: { action: "land", rifts: ["alpha"] } }],
  [MACHINE_SUMMARY, { kind: "tool", name: "subagent", input: { agent: "verifier", description: "verifier alpha r1", prompt: `${HAND_BACK} verifier alpha r1: accepted /run/alpha/round-1-findings.md` } }],
  ["implementor gamma r1: ready", { kind: "tool", name: "subagent", input: { agent: "verifier", description: "verifier alpha r1", prompt: `${HAND_BACK} verifier alpha r1: accepted /run/alpha/round-1-findings.md` } }],
  ...(["gamma", "beta"] as const).map((unit, index): readonly [string, Reply] => [
    `implementor ${index === 0 ? "beta" : "alpha"} r1: ready`,
    { kind: "tool", name: "subagent", input: { agent: "implementor", description: `implementor ${unit} r1`, prompt: `${HAND_BACK} implementor ${unit} r1: ready /run/${unit}/round-1-request.md` } },
  ]),
  [MACHINE_TASK, { kind: "tool", name: "subagent", input: { agent: "implementor", description: "implementor alpha r1", prompt: `${HAND_BACK} implementor alpha r1: ready /run/alpha/round-1-request.md` } }],
]

/** The machine run's next step: by the newest message that says one of the script's lines, in the script's order. */
export const machineStep = (messages: ReadonlyArray<ChatMessage>): readonly [string, Reply] | undefined => {
  for (const message of [...messages].reverse()) {
    const said = text(message.content)
    const step = MACHINE_SCRIPT.find(([line]) => said.includes(line))
    if (step !== undefined) return step
  }
  return undefined
}

/** Whether a request is the machine run's root's (its summary request among them), not a title's or a child's. */
export const isMachineRoot = (seen: Pick<Seen, "system" | "messages">): boolean =>
  !seen.system.includes("You name conversations") && seen.messages.some((message) => text(message.content).includes(MACHINE_TASK))

/** The input tokens a machine run's request reports: full on the request that starts the third implementor. */
export const machineTokens = (_task: string, messages: ReadonlyArray<ChatMessage>): number => messages.some((message) => text(message.content).includes(MACHINE_TASK)) && machineStep(messages)?.[0] === "implementor beta r1: ready" ? MACHINE_FULL : 100

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
  // A probe turn (`probe:{"name":…,"input":…}`): the root makes that one call, then says it is done.
  const probed = messages.findLastIndex((message) => message.role === "user" && text(message.content).startsWith(PROBE))
  if (probed >= 0) {
    const asked = JSON.parse(text(messages[probed]!.content).slice(PROBE.length)) as { name: string; input: Record<string, unknown> }
    return messages.slice(probed + 1).some((message) => message.role === "tool") ? { kind: "text", text: "probe done" } : { kind: "tool", ...asked }
  }
  if (last.includes("You MUST summarize the conversation")) return { kind: "text", text: isMachineRoot({ system, messages }) ? MACHINE_SUMMARY : SUMMARY }
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
  if (isMachineRoot({ system, messages })) return machineStep(messages)?.[1] ?? { kind: "text", text: "root: lost the machine script" }
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

export const serve = (promptTokens: number | ((task: string, messages: ReadonlyArray<ChatMessage>) => number) = 100) => {
  const tokensOf = typeof promptTokens === "number" ? () => promptTokens : promptTokens
  const seen: Seen[] = []
  let served = 0
  // Hanging requests, and whether a hang task's first request still hangs.
  let hanging = 0
  let released = false
  // Gates: a task whose first message holds a `gate:<name>` line answers its first request once the gate opens.
  const gates = new Map<string, { readonly opened: Promise<void>; readonly open: () => void }>()
  const gate = (name: string) => {
    const found = gates.get(name)
    if (found !== undefined) return found
    let open = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    const made = { opened, open }
    gates.set(name, made)
    return made
  }
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
      const first = messages.find((message) => message.role === "user")
      const gated = /^gate:(\S+)$/m.exec(text(first?.content))?.[1]
      if (gated !== undefined && text(messages.at(-1)?.content) === text(first?.content)) await gate(gated).opened
      if (task === HANG_TASK && lastLine(text(messages.at(-1)?.content)) === HANG_TASK && !released) {
        hanging += 1
        // An open stream that never ends: the request runs until the server's shutdown cuts it.
        return new Response(new ReadableStream({ start: () => {} }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      }
      return new Response(events(reply(body), body.model ?? "sim", `sim${served}`, tokensOf(task, messages)), {
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
    /** A gated task's first request answers. */
    open: (name: string) => gate(name).open(),
  }
}
