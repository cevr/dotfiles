/**
 * One memory run in real OpenCode (the fork, embedded through its SDK), on the
 * scripted model, with the memory plugin on a scratch file. The test starts it
 * in a child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/memory/run.ts <spec.json>`.
 *
 * Three root sessions run one after the other: `memory save` (a save, a near
 * repeat, a search), `memory recall` (a save mid-session) and `memory again`.
 * It writes each session's messages and the system prompts the model got for
 * each to `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGAIN_TASK, RECALL_TASK, SAVE_TASK, serve } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
}

export interface Result {
  /** Each task's messages, by task. */
  readonly messages: Readonly<Record<string, unknown>>
  /** Each task's system prompts, one per request, by task. */
  readonly systems: Readonly<Record<string, ReadonlyArray<string>>>
  readonly db: string
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })
const db = join(spec.base, "memory.db")

const sim = serve()
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
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
  plugins: [{ package: spec.plugin, options: { path: db } }],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string } }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk

try {
  const opencode = await OpenCode.create({
    events: { persist: true },
    database: { path: join(spec.base, "opencode.db") },
    config: { directory: config, project: false, content: JSON.stringify(content) },
  })
  try {
    const messages: Record<string, unknown> = {}
    for (const task of [SAVE_TASK, RECALL_TASK, AGAIN_TASK]) {
      const session = await opencode.sessions.create({ location: { directory: work } })
      await opencode.sessions.prompt({ sessionID: session.id, text: task })
      await opencode.experimental.session.wait({ sessionID: session.id })
      messages[task] = await opencode.sessions.context({ sessionID: session.id })
    }
    const result: Result = { messages, systems: sim.systems, db }
    writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
  } finally {
    await opencode.close()
  }
} finally {
  sim.server.stop(true)
}
process.exit(0)
