/**
 * One kernel run in real OpenCode (the fork, embedded through its SDK), on the
 * scripted model, with the kernel plugin loaded from config as the owner would
 * load it. The test starts it in a child process whose HOME and XDG dirs are a
 * scratch dir: `bun tests/kernel/run.ts <spec.json>`. The work dir holds
 * hello.txt and pixel.png. It writes the session's
 * messages and the model's requests to `<base>/result.json`. On the stop
 * task it queues a prompt to the subagent once its turn stalls, and keeps
 * that subagent's inbox after the run.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schedule } from "effect"
import { HELLO, PIXEL_FILE, PIXEL_PNG, QUEUED_PROMPT, SELF, serve, type Seen, STALL_TASK, STOP_TASK } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
  /** The first prompt: `kernel` runs the sim's two kernel calls. */
  readonly task: string
  readonly denyExecute: boolean
  /** The kernel's codeOnly option; absent keeps its default. */
  readonly codeOnly?: boolean
  /** Loads the orchestrate mod too, its Sabbath clock at this time (ISO 8601). */
  readonly orchestrate?: { readonly plugin: string; readonly now: string }
  /** Loads the memory mod too, its notes in the scratch `memory.db`. */
  readonly memory?: { readonly plugin: string }
  /** The model reads images too; absent, it reads text only. */
  readonly images?: boolean
}

export interface Result {
  readonly messages: unknown
  readonly seen: ReadonlyArray<Seen>
  /** The stop task's subagent's inbox after the run: what still waits to reach it. */
  readonly inbox: ReadonlyArray<unknown>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
/** The drops journal the plugin hands the run's shells and reads back: the run's own. */
const DROPS = join(spec.base, "drops.jsonl")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })
const file = join(work, "hello.txt")
writeFileSync(file, `${HELLO}\n`)
writeFileSync(join(work, PIXEL_FILE), Buffer.from(PIXEL_PNG, "base64"))

const sim = serve(file)
const content = {
  model: "sim/sim-model",
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${sim.server.port}/v1`, apiKey: "sim-key" },
      models: {
        "sim-model": {
          name: "Sim",
          capabilities: { tools: true, input: spec.images ? ["text", "image"] : ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
  plugins: [
    {
      package: spec.plugin,
      options: { denyExecute: spec.denyExecute, timeoutMs: 20_000, ...(spec.codeOnly === undefined ? {} : { codeOnly: spec.codeOnly }) },
    },
    ...(spec.orchestrate ? [{ package: spec.orchestrate.plugin, options: { now: spec.orchestrate.now, log: join(spec.base, "agents.jsonl"), ledger: join(spec.base, "machine.jsonl"), drops: DROPS } }] : []),
    ...(spec.memory ? [{ package: spec.memory.plugin, options: { path: join(spec.base, "memory.db") } }] : []),
  ],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string; delivery?: "queue" }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
    readonly list: (input: { parentID: string }) => Promise<{ readonly data: ReadonlyArray<{ readonly id: string }> }>
    readonly inbox: { readonly list: (input: { sessionID: string }) => Promise<ReadonlyArray<unknown>> }
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk
const opencode = await OpenCode.create({
  events: { persist: true },
  config: { directory: config, project: false, content: JSON.stringify(content) },
})

try {
  const session = await opencode.sessions.create({ location: { directory: work } })
  // A task names the session itself by `SELF`: a session that is no subagent of its own.
  await opencode.sessions.prompt({ sessionID: session.id, text: spec.task.replace(SELF, session.id) })
  const done = Effect.promise(() => opencode.experimental.session.wait({ sessionID: session.id }))
  // The run ends with the session's turn. The stop task's subagent gets a prompt queued behind its stalled turn,
  // which its stop must drop; after the run, what still waits in its inbox.
  const ran = Effect.gen(function* () {
    if (!spec.task.endsWith(STOP_TASK)) {
      yield* done
      return []
    }
    // The child asked for its shell, then for the answer that holds: it is mid-turn with its shell running.
    yield* Effect.sync(() => sim.seen.filter((request) => request.task.endsWith(STALL_TASK) && request.tools.length > 0).length >= 2).pipe(
      Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (stalled) => stalled }),
    )
    const children = (yield* Effect.promise(() => opencode.sessions.list({ parentID: session.id }))).data
    yield* Effect.forEach(children, (child) => Effect.promise(() => opencode.sessions.prompt({ sessionID: child.id, text: QUEUED_PROMPT, delivery: "queue" })))
    yield* done
    return (yield* Effect.forEach(children, (child) => Effect.promise(() => opencode.sessions.inbox.list({ sessionID: child.id })))).flat()
  })
  const inbox = await Effect.runPromise(ran)
  const result: Result = { messages: await opencode.sessions.context({ sessionID: session.id }), seen: sim.seen, inbox }
  writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
