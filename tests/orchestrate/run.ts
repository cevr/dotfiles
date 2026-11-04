/**
 * One orchestrate run in real OpenCode (the fork, embedded through its SDK),
 * on the scripted model, with the orchestrate plugin loaded from config as
 * the owner would load it. The test starts it in a
 * child process whose HOME and XDG dirs are a scratch dir, so nothing of the
 * owner's is read or written: `bun tests/orchestrate/run.ts <spec.json>`.
 * It writes what the run left (sessions, their messages, the model's
 * requests, the call log) to `<base>/result.json`.
 *
 * Scenarios:
 * - `subagents`: the root session runs the sim's `orchestrate` task, which
 *   calls `subagent` with no agent and then with `orchestrate-reviewer`.
 * - `compaction`: a planner session and a worker session, two prompts each.
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT_TASK, serve } from "./sim.ts"

export interface Spec {
  readonly scenario: "subagents" | "compaction"
  readonly base: string
  readonly fork: string
  readonly plugin: string
  /** The Sabbath clock, ISO 8601. */
  readonly now: string
  /** compact.json's content, if the run has one. */
  readonly windows?: Record<string, number>
  readonly promptTokens?: number
}

export interface Child {
  readonly id: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
}

export interface Result {
  readonly root?: { readonly id: string; readonly messages: unknown }
  readonly children: ReadonlyArray<Child>
  readonly sessions: Record<string, { readonly agent?: string; readonly messages: unknown }>
  readonly seen: ReturnType<typeof serve>["seen"]
  readonly log: ReadonlyArray<Record<string, unknown>>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
const windowsFile = join(spec.base, "compact.json")
const logFile = join(spec.base, "agents.jsonl")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })
if (spec.windows) writeFileSync(windowsFile, JSON.stringify({ windows: spec.windows }))

const sim = serve(spec.promptTokens)
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
          variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
        },
      },
    },
  },
  plugins: [{ package: spec.plugin, options: { windows: windowsFile, log: logFile, now: spec.now } }],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface SessionInfo {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: Child["model"]
}
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string }; agent?: string }) => Promise<SessionInfo>
    readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
    readonly list: (input: { parentID: string; directory: string }) => Promise<{ data: ReadonlyArray<SessionInfo> }>
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

const location = { directory: work }
const turn = async (sessionID: string, text: string) => {
  await opencode.sessions.prompt({ sessionID, text })
  await opencode.experimental.session.wait({ sessionID })
}
const messages = (sessionID: string) => opencode.sessions.context({ sessionID })

let result: Result
try {
  if (spec.scenario === "subagents") {
    const root = await opencode.sessions.create({ location })
    await turn(root.id, ROOT_TASK)
    const page = await opencode.sessions.list({ parentID: root.id, directory: work })
    const children = await Promise.all(page.data.map((item) => opencode.sessions.get({ sessionID: item.id })))
    result = {
      root: { id: root.id, messages: await messages(root.id) },
      children: children.map((child) => ({
        id: child.id,
        ...(child.agent ? { agent: child.agent } : {}),
        ...(child.model ? { model: child.model } : {}),
      })),
      sessions: {},
      seen: sim.seen,
      log: [],
    }
  } else {
    const sessions: Result["sessions"] = {}
    for (const agent of ["planner", "worker"]) {
      const session = await opencode.sessions.create({ location, agent })
      await turn(session.id, `${agent}: first`)
      await turn(session.id, `${agent}: second`)
      sessions[agent] = { agent: (await opencode.sessions.get({ sessionID: session.id })).agent, messages: await messages(session.id) }
    }
    result = { children: [], sessions, seen: sim.seen, log: [] }
  }
  let log: Result["log"] = []
  try {
    log = readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {}
  writeFileSync(join(spec.base, "result.json"), JSON.stringify({ ...result, log }, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
