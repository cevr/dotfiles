/**
 * One questions run in real OpenCode (the fork, embedded through its SDK) on
 * the scripted model, with the questions plugin, and two project directories
 * open on the one server, as the owner's servers have. The test starts it in a
 * child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/questions/run.ts <spec.json>`.
 *
 * A session in the other directory runs first, so the plugin is loaded there
 * too. Then a session in the asking directory asks one question; the run opens
 * the /answer form for it (`session.form.create`, as the TUI does) and submits
 * an answer, waits for the letter and the turn it wakes. It writes the
 * sessions' messages and every warning the server logged to
 * `<base>/result.json`. (The subagent's question, answered in its root's
 * form, runs on the simulated host: cmd/questions/questions-locations.sim.test.ts.)
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formOf } from "../../mods/questions/form.ts"
import type { Question } from "../../mods/questions/question.ts"
import { ASK_TASK, IDLE_TASK, LETTER, type Message, messagesOf, QUESTION, serve } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
}

export interface Warning {
  readonly message: string
  readonly attributes?: Readonly<Record<string, unknown>>
}

export interface Result {
  /** The asking session's messages. */
  readonly asked: unknown
  /** The other directory's session's messages. */
  readonly other: unknown
  /** Every warning the server logged. */
  readonly warnings: ReadonlyArray<Warning>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const asking = join(spec.base, "asking")
const other = join(spec.base, "other")
const config = join(spec.base, "config")
for (const dir of [asking, other, config]) mkdirSync(dir, { recursive: true })

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
  plugins: [{ package: spec.plugin }],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string }; parentID?: string; title?: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
    readonly form: {
      readonly create: (input: { sessionID: string } & Record<string, unknown>) => Promise<{ readonly id: string }>
      readonly reply: (input: { sessionID: string; formID: string; answer: Record<string, unknown> }) => Promise<unknown>
    }
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk

const warnings: Array<Warning> = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const opencode = await OpenCode.create({
    events: { persist: true },
    database: { path: join(spec.base, "opencode.db") },
    config: { directory: config, project: false, content: JSON.stringify(content) },
    log: {
      level: "warn",
      emit: (entry: { level: string; message: string; attributes?: Record<string, unknown> }) => {
        if (entry.level === "warn") warnings.push({ message: entry.message, ...(entry.attributes === undefined ? {} : { attributes: { sessionID: entry.attributes.sessionID } }) })
      },
    },
  })
  try {
    // The other directory first, so the plugin is loaded there as well.
    const idle = await opencode.sessions.create({ location: { directory: other } })
    await opencode.sessions.prompt({ sessionID: idle.id, text: IDLE_TASK })
    await opencode.experimental.session.wait({ sessionID: idle.id })

    const session = await opencode.sessions.create({ location: { directory: asking } })
    await opencode.sessions.prompt({ sessionID: session.id, text: ASK_TASK })
    await opencode.experimental.session.wait({ sessionID: session.id })

    // /answer: the form the TUI opens for the session's open question, answered off the assumption.
    const asked: Question = { id: "q1", sessionID: session.id, askedAt: 0, ...QUESTION }
    const input = formOf([asked])
    if (input === undefined) throw new Error("no form for the question")
    const form = await opencode.sessions.form.create({ sessionID: session.id, ...input })
    await opencode.sessions.form.reply({ sessionID: session.id, formID: form.id, answer: { [input.fields[0].key]: "Redis" } })

    // The letter wakes the session; wait for it to arrive, then for the turn it starts.
    /** Polls a session's messages until `ready` holds of them, or fails with `what` after 30 s. */
    const until = async (sessionID: string, ready: (messages: ReadonlyArray<Message>) => boolean, what: string) => {
      const deadline = Date.now() + 30_000
      while (!ready(messagesOf(await opencode.sessions.context({ sessionID })))) {
        if (Date.now() > deadline) throw new Error(`${what} never happened in ${sessionID}`)
        await sleep(100)
      }
    }
    const hasLetter = (messages: ReadonlyArray<Message>) => JSON.stringify(messages).includes(LETTER)
    await until(session.id, hasLetter, "the answer's letter")
    await opencode.experimental.session.wait({ sessionID: session.id })

    // Every location's subscriber has long seen the event by now; let any late one log.
    await sleep(500)

    const result: Result = {
      asked: await opencode.sessions.context({ sessionID: session.id }),
      other: await opencode.sessions.context({ sessionID: idle.id }),
      warnings,
    }
    writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
  } finally {
    await opencode.close()
  }
} finally {
  sim.server.stop(true)
}
process.exit(0)
