/**
 * One idle-compaction run in real OpenCode (the fork, embedded through its
 * SDK), on the scripted model, with the plugin loaded from config as the owner
 * would load it, on a 20 s cache and a 5 s margin. The test starts it in a
 * child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/idle-compact/run.ts <spec.json>`.
 *
 * It sends one prompt, lets the session sit idle, and reads the session's
 * context twice: `early`, `EARLY_MS` after the turn's request came (before the
 * compaction is due), and `late`, once a compaction message has run or
 * `LATE_MS` has passed. It writes both, the model's requests and the turn's
 * start to `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EARLY_MS, LATE_MS, MARGIN_SECONDS, serve, TASK, TTL_SECONDS, type Seen } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
}

export interface Result {
  readonly early: unknown
  readonly late: unknown
  readonly seen: ReadonlyArray<Seen>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })

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
  // A 1000-token prompt is over a 50-token threshold.
  plugins: [{ package: spec.plugin, options: { ttlSeconds: TTL_SECONDS, shortMarginSeconds: MARGIN_SECONDS, thresholdTokens: 50 } }],
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const compacted = (messages: unknown) =>
  Array.isArray(messages) &&
  messages.some(
    (message: unknown) =>
      typeof message === "object" && message !== null && "type" in message && message.type === "compaction" && "status" in message && message.status === "completed",
  )

try {
  const session = await opencode.sessions.create({ location: { directory: work } })
  await opencode.sessions.prompt({ sessionID: session.id, text: TASK })
  await opencode.experimental.session.wait({ sessionID: session.id })
  const turn = sim.seen.find((item) => item.kind === "turn")?.at ?? Date.now()
  await sleep(turn + EARLY_MS - Date.now())
  const early = await opencode.sessions.context({ sessionID: session.id })
  let late = early
  while (Date.now() < turn + LATE_MS && !compacted(late)) {
    await sleep(500)
    late = await opencode.sessions.context({ sessionID: session.id })
  }
  const result: Result = { early, late, seen: sim.seen }
  writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
