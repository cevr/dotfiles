/**
 * One idle-compaction run in real OpenCode (the fork, embedded through its
 * SDK), on the scripted model, with the plugin loaded from config as the owner
 * would load it, on a 20 s cache and a 5 s margin. The test starts it in a
 * child process whose HOME and XDG dirs are a scratch dir:
 * `bun tests/idle-compact/run.ts <spec.json>`.
 *
 * It keeps the plugin's log lines and the host's loads of it (one per
 * directory it serves).
 *
 * It sends one prompt, lets the session sit idle, and reads the session's
 * context twice: `early`, `EARLY_MS` after the turn's request came (before the
 * compaction is due), and `late`, once a compaction message has run or
 * `LATE_MS` has passed. It writes both, the model's requests and the turn's
 * start to `<base>/result.json`.
 *
 * With `background`, the prompt is `BACKGROUND_TASK`, whose first step leaves a
 * shell running past the cache's expiry, and `late` is read once a request
 * came after the compaction (the shell's notice waking the session) or
 * `WAKE_MS` has passed.
 *
 * With `others`, the host opens that many other directories first, so it
 * runs a copy of the plugin for each of them too, as it does for every
 * directory it serves; the prompt waits until every copy has made its first
 * look, so the session's only decisions are the turn's.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BACKGROUND_TASK, EARLY_MS, LATE_MS, MARGIN_SECONDS, serve, TASK, TTL_SECONDS, WAKE_MS, type Seen } from "./sim.ts"

export interface Spec {
  readonly base: string
  readonly fork: string
  readonly plugin: string
  readonly background?: boolean
  readonly others?: number
}

/** A log line of the run: the plugin's own (`idle-compact: …`) or the host's `loading plugin` for it. */
export interface Line {
  readonly message: string
  readonly sessionID?: string
  readonly trigger?: string
}

export interface Result {
  readonly early: unknown
  readonly late: unknown
  readonly seen: ReadonlyArray<Seen>
  readonly log: ReadonlyArray<Line>
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
  readonly location: { readonly get: (input: { location: { directory: string } }) => Promise<unknown> }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk
const log: Array<Line> = []
const opencode = await OpenCode.create({
  events: { persist: true },
  log: {
    level: "info",
    emit: (entry: { readonly message: string; readonly attributes?: Readonly<Record<string, unknown>> }) => {
      const attributes = entry.attributes ?? {}
      // The host logs its load as an object, `{ msg: "loading plugin", id }`, which the SDK formats into the message.
      const loads = entry.message.includes("loading plugin") && entry.message.includes("idle-compact")
      if (!loads && !entry.message.startsWith("idle-compact")) return
      log.push({
        message: loads ? "loading plugin" : entry.message,
        ...(typeof attributes["sessionID"] === "string" ? { sessionID: attributes["sessionID"] } : {}),
        ...(typeof attributes["trigger"] === "string" ? { trigger: attributes["trigger"] } : {}),
      })
    },
  },
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
  if (spec.others !== undefined) {
    await opencode.location.get({ location: { directory: work } })
    for (let index = 0; index < spec.others; index += 1) {
      const directory = join(spec.base, `other-${index}`)
      mkdirSync(directory, { recursive: true })
      await opencode.location.get({ location: { directory } })
    }
    // Past each copy's first look, which waits for the catalog to settle (cmd/idle-compact/server.ts SETTLE).
    await sleep(3_000)
  }
  await opencode.sessions.prompt({ sessionID: session.id, text: spec.background ? BACKGROUND_TASK : TASK })
  await opencode.experimental.session.wait({ sessionID: session.id })
  const turn = sim.seen.findLast((item) => item.kind === "turn")?.at ?? Date.now()
  await sleep(turn + EARLY_MS - Date.now())
  const early = await opencode.sessions.context({ sessionID: session.id })
  let late = early
  // The background run waits on past the compaction for the shell's notice to wake the session.
  const woke = () => {
    const compaction = sim.seen.find((item) => item.kind === "compaction")
    return compaction !== undefined && sim.seen.some((item) => item.kind === "turn" && item.at > compaction.at)
  }
  const done = () => (spec.background ? compacted(late) && woke() : compacted(late))
  while (Date.now() < turn + (spec.background ? WAKE_MS : LATE_MS) && !done()) {
    await sleep(500)
    late = await opencode.sessions.context({ sessionID: session.id })
  }
  if (spec.background) await opencode.experimental.session.wait({ sessionID: session.id })
  late = await opencode.sessions.context({ sessionID: session.id })
  const result: Result = { early, late, seen: sim.seen, log }
  writeFileSync(join(spec.base, "result.json"), JSON.stringify(result, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
