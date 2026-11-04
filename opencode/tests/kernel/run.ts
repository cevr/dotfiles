/**
 * One kernel run in real OpenCode (the fork, embedded through its SDK), on the
 * scripted model, with the kernel plugin loaded from config as the owner would
 * load it. The test starts it in a child process whose HOME and XDG dirs are a
 * scratch dir: `bun tests/kernel/run.ts <spec.json>`. It writes the session's
 * messages and the model's requests to `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HELLO, serve, type Seen } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
  /** The first prompt: `kernel` runs the sim's two kernel calls. */
  readonly task: string
  readonly denyExecute: boolean
}

export interface Result {
  readonly messages: unknown
  readonly seen: ReadonlyArray<Seen>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })
const file = join(work, "hello.txt")
writeFileSync(file, `${HELLO}\n`)

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
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  },
  plugins: [{ package: spec.plugin, options: { denyExecute: spec.denyExecute, timeoutMs: 20_000 } }],
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
const opencode = await OpenCode.create({
  events: { persist: true },
  config: { directory: config, project: false, content: JSON.stringify(content) },
})

try {
  const session = await opencode.sessions.create({ location: { directory: work } })
  await opencode.sessions.prompt({ sessionID: session.id, text: spec.task })
  await opencode.experimental.session.wait({ sessionID: session.id })
  const result: Result = { messages: await opencode.sessions.context({ sessionID: session.id }), seen: sim.seen }
  writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
