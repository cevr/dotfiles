/**
 * One compaction-prefix run in real OpenCode (the fork, embedded through its
 * SDK), on the scripted model, with the plugins that write the system prompt
 * loaded from config as the owner loads them: memory, on a scratch file that
 * holds one global note, so every session's requests carry its digest. The
 * test starts it in a child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/compaction-prefix/run.ts <spec.json>`.
 *
 * The mode picks the compaction:
 * - `auto`: `AUTO_TASK`, whose tool step ends past the window's ceiling, so the
 *   host compacts before the next step.
 * - `idle`: `IDLE_TASK` with the idle-compact plugin on an 8 s cache and a 3 s
 *   margin: the idle session is compacted through `session.compact`.
 * - `background`: `BACKGROUND_TASK` with `background_compaction` on: the host
 *   writes a summary in the background as the turn ends.
 *
 * It writes every model request the sim got, in order, with its whole body, to
 * `<base>/result.json`.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { main } from "../../cmd/memory/cli.ts"
import { AUTO_TASK, BACKGROUND_TASK, IDLE_TASK, MARGIN_SECONDS, NOTE, type Seen, serve, TTL_SECONDS } from "./sim.ts"

export type Mode = "auto" | "idle" | "background"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly mode: Mode
  /** `cmd/memory` and `cmd/idle-compact` of this checkout. */
  readonly memory: string
  readonly idleCompact: string
}

export interface Result {
  readonly seen: ReadonlyArray<Seen>
  readonly compacted: boolean
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })
const db = join(spec.base, "memory.db")
const added = await main(["add", NOTE, "--scope", "global"], { db, now: Date.now() })
if (added.code !== 0) throw new Error(`the note was not added: ${added.out}`)

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
  plugins: [
    { package: spec.memory, options: { path: db } },
    // A 1000-token prompt is over a 50-token threshold.
    ...(spec.mode === "idle" ? [{ package: spec.idleCompact, options: { ttlSeconds: TTL_SECONDS, shortMarginSeconds: MARGIN_SECONDS, thresholdTokens: 50 } }] : []),
  ],
  ...(spec.mode === "background" ? { experimental: { background_compaction: true } } : {}),
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const compactedIn = (messages: unknown) =>
  Array.isArray(messages) &&
  messages.some(
    (message: unknown) =>
      typeof message === "object" && message !== null && "type" in message && message.type === "compaction" && "status" in message && message.status === "completed",
  )
const TASKS: Readonly<Record<Mode, string>> = { auto: AUTO_TASK, idle: IDLE_TASK, background: BACKGROUND_TASK }
/** How long the run waits, after the turn, for the compaction (idle) or the background summary's request. */
const WAIT_MS = 20_000

try {
  const opencode = await OpenCode.create({
    events: { persist: true },
    database: { path: join(spec.base, "opencode.db") },
    config: { directory: config, project: false, content: JSON.stringify(content) },
  })
  try {
    const session = await opencode.sessions.create({ location: { directory: work } })
    await opencode.sessions.prompt({ sessionID: session.id, text: TASKS[spec.mode] })
    await opencode.experimental.session.wait({ sessionID: session.id })
    const until = Date.now() + WAIT_MS
    let compacted = compactedIn(await opencode.sessions.context({ sessionID: session.id }))
    const done = () => (spec.mode === "background" ? sim.seen.some((item) => item.kind === "compaction") : compacted)
    while (!done() && Date.now() < until) {
      await sleep(250)
      compacted = compactedIn(await opencode.sessions.context({ sessionID: session.id }))
    }
    // The background summary's request is in; give it time to finish before the host closes.
    if (spec.mode === "background") await sleep(1_000)
    const result: Result = { seen: sim.seen, compacted }
    writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
  } finally {
    await opencode.close()
  }
} finally {
  sim.server.stop(true)
}
process.exit(0)
