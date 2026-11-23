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
 * - `units`: the root starts the implementor of `work/tmp/orchestrate/web/auth`,
 *   which hands back; the result carries that unit's `log.md`.
 * - `lane`: one root, each turn one `probe:` call, starts three implementors
 *   and lands each one's Rift as it hands back, through a fixture `rift` tool
 *   written beside the fake pace plugin; a verifier named for a unit starts
 *   while another verifier runs. No batch rule refuses any of it. The result
 *   carries the lands, the root's children in order and its messages.
 *
 * @module
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { externalInput, matchingInput, readScratchFileSync as readFileSync, scratchExistsSync as existsSync, scratchInput } from "../read-path.ts"
import { HAND_BACK, PROBE, ROOT_TASK, serve, UNITS_TASK } from "./sim.ts"

export interface Spec {
  readonly scenario: "subagents" | "compaction" | "units" | "lane"
  readonly base: string
  readonly fork: string
  readonly plugin: string
  /** The Sabbath clock, ISO 8601. */
  readonly now: string
  readonly pace?: boolean
  /** The Codex admission's answer: the sim provider is paced as Codex, and each call's arguments land in codex-args.jsonl. */
  readonly codex?: "admit" | "hold"
  /** The input tokens every reply reports, or per agent: by the task's text before its `:` (`planner: first`). */
  readonly promptTokens?: number | Readonly<Record<string, number>>
  /** The root session's model, such as the sim model at `max`; the config's default when absent. */
  readonly rootModel?: Child["model"]
  /** The config's `agents` entries, by agent id. */
  readonly agents?: Readonly<Record<string, { readonly model: string }>>
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
  /** A unit run's `log.md`, each line without its time. */
  readonly unitLog?: ReadonlyArray<string>
  /** What a `lane` run adds. */
  readonly lane?: Lane
}

/** What the `lane` scenario adds. */
export interface Lane {
  /** The `rifts` of each land the fixture rift tool ran, in order. */
  readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
  /** The agent of each child of the root, in the order made. */
  readonly agents: ReadonlyArray<string>
  /** The root's messages as JSON, for a test to search. */
  readonly said: string
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(scratchInput(spec.base), "work")
const config = join(spec.base, "config")
const logFile = join(spec.base, "agents.jsonl")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })

const tokens = spec.promptTokens
const sim = serve(typeof tokens === "object" ? (task) => tokens[task.split(":")[0]!] ?? 100 : tokens)
// The lane run's `rift` tool: a fixture that only records each land's Rifts and answers as a pushed land does.
/** A fixture plugin's package.json: one ES module, its server entry. */
const PLUGIN_PACKAGE = JSON.stringify({ type: "module", exports: { "./server": "./server.js" } })
const riftPlugin = join(spec.base, "fake-rift")
const riftLog = join(spec.base, "rift-lands.jsonl")
const laned = spec.scenario === "lane"
if (laned) {
  mkdirSync(riftPlugin, { recursive: true })
  writeFileSync(join(riftPlugin, "package.json"), PLUGIN_PACKAGE)
  writeFileSync(
    join(riftPlugin, "server.js"),
    [
      'import { appendFileSync } from "node:fs"',
      "export default {",
      '  id: "fixture.rift",',
      "  async setup(ctx) {",
      "    await ctx.tool.transform((editor) =>",
      "      editor.add({",
      '        name: "rift",',
      '        description: "Lands Rifts as one batch: rift({ action: \\"land\\", rifts: [...] }).",',
      '        input: { type: "object", properties: { action: { type: "string" }, rifts: { type: "array", items: { type: "string" } }, departs: { type: "string" } }, required: ["action"] },',
      "        options: { codemode: false },",
      "        execute: async (input) => {",
      `          appendFileSync(${JSON.stringify(riftLog)}, JSON.stringify(input.rifts ?? []) + "\\n")`,
      "          const rifts = input.rifts ?? []",
      '          return { content: [{ type: "text", text: `Landed ${rifts.length} workspace(s) as one push: ${rifts.join(", ")}.` }], metadata: { action: "land" } }',
      "        },",
      "      }),",
      "    )",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
}
const pacePlugin = join(spec.base, "fake-pace")
if (spec.pace !== undefined) {
  mkdirSync(pacePlugin, { recursive: true })
  writeFileSync(join(pacePlugin, "package.json"), PLUGIN_PACKAGE)
  writeFileSync(join(pacePlugin, "server.js"), `export default { id: "fixture.pace", async setup(ctx) { await ctx.rpc.register({ id: "dotfiles-opencode.pool", methods: { pace: { input: { type: "object" }, output: { type: "object" } } }, events: {} }, { pace: async () => ({ ok: ${!spec.pace}, measured: true, reason: "scripted weekly pace", retryAt: ${Date.parse(spec.now) + 60000} }) }); } }`)
}
const codexScript = join(spec.base, "fake-codex.ts")
if (spec.codex !== undefined) {
  const line = spec.codex === "admit" ? "admit: scripted Codex pace" : "hold: scripted Codex week is over; opens about 2026-11-04 16:20Z"
  writeFileSync(
    codexScript,
    `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(join(spec.base, "codex-args.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n")\nconsole.log(${JSON.stringify(line)})\nprocess.exit(${spec.codex === "admit" ? 0 : 1})\n`,
  )
}
const codexOption = spec.codex === undefined ? {} : { codex: { providers: ["sim"], script: codexScript } }
const content = {
  model: "sim/sim-model",
  agents: { ...spec.agents },
  providers: {
    sim: {
      name: "Sim",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${sim.server.port}/v1`, apiKey: "sim-key" },
      models: {
        "sim-model": {
          name: "Sim",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          // A window as large as Opus's, so only the agents' own window decides when a session compacts.
          limit: { context: 1_000_000, output: 16_000 },
          variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
        },
      },
    },
  },
  plugins: [
    {
      package: matchingInput("cmd/orchestrate", spec.plugin),
      options: {
        log: logFile,
        now: spec.now,
        unitLog: matchingInput("../skills/orchestrate/scripts/log.ts", join(spec.plugin, "../../../skills/orchestrate/scripts/log.ts")),
        ...codexOption,
      },
    },
    ...(spec.pace !== undefined ? [{ package: pacePlugin }] : []),
    ...(laned ? [{ package: riftPlugin }] : []),
  ],
}

/** As much of the fork's SDK as the run uses; the fork is found at run time, so it is typed here. */
interface SessionInfo {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly title?: string
  readonly time?: { readonly created?: unknown }
  readonly model?: Child["model"]
}
interface Embedded {
  readonly sessions: {
    readonly create: (input: { location: { directory: string }; agent?: string; model?: Child["model"] }) => Promise<SessionInfo>
    readonly get: (input: { sessionID: string }) => Promise<SessionInfo>
    readonly list: (input: { parentID: string; directory: string }) => Promise<{ data: ReadonlyArray<SessionInfo> }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    readonly context: (input: { sessionID: string }) => Promise<unknown>
    readonly interrupt: (input: { sessionID: string }) => Promise<unknown>
    readonly move: (input: { sessionID: string; directory: string }) => Promise<unknown>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(externalInput(join(spec.fork, "packages/sdk/src/index.ts")))) as Sdk
/** One OpenCode. */
const open = () =>
  OpenCode.create({
    events: { persist: true },
    // The bundled model catalog only, as tests/compaction-prefix/run.ts says why.
    models: { fetch: false },
    config: { directory: config, project: false, content: JSON.stringify(content) },
  })
const opencode = await open()

const location = { directory: work }
const turn = async (sessionID: string, text: string) => {
  await opencode.sessions.prompt({ sessionID, text })
  await opencode.experimental.session.wait({ sessionID })
}
const messages = (sessionID: string) => opencode.sessions.context({ sessionID })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Polls `ready` every 100 ms for `ms` at most; whether it held. */
const until = async (ready: () => Promise<boolean> | boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ready()) return true
  return false
}
const readLog = (): Result["log"] => {
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

let result: Result
try {
  if (spec.scenario === "lane") {
    const root = await opencode.sessions.create({ location })
    const call = (name: string, input: Record<string, unknown>) => turn(root.id, `${PROBE}${JSON.stringify({ name, input })}`)
    // Each unit starts, hands back ready, and lands alone as it does: no cadence, no batch to wait for.
    for (const unit of ["alpha", "beta", "gamma"]) {
      await call("subagent", {
        agent: "implementor",
        description: `implementor ${unit} r1 (folds: ${unit}/M0)`,
        prompt: `${HAND_BACK} implementor ${unit} r1: ready /nonexistent/loop-probe-x/request.md`,
        background: true,
      })
      await call("rift", { action: "land", rifts: [unit] })
    }
    // A verifier named for a batch runs, held until the end; a second, named for a unit, starts all the same.
    await call("subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `gate:verify-1\n${HAND_BACK} verifier batch-1 r1: accepted /nonexistent/loop-probe-x/findings.md`, background: true })
    await call("subagent", { agent: "verifier", description: "verifier alpha r1", prompt: `${HAND_BACK} verifier alpha r1: changes /nonexistent/loop-probe-x/findings.md`, background: true })
    sim.open("verify-1")
    const page = await opencode.sessions.list({ parentID: root.id, directory: work })
    for (const child of page.data) await opencode.experimental.session.wait({ sessionID: child.id })
    await opencode.experimental.session.wait({ sessionID: root.id })
    const children = await Promise.all(page.data.map((item) => opencode.sessions.get({ sessionID: item.id })))
    const created = (child: SessionInfo) => {
      const at = child.time?.created
      return typeof at === "number" ? at : Date.parse(String(at))
    }
    const rootMessages = await messages(root.id)
    result = {
      root: { id: root.id, messages: rootMessages },
      children: children.map((child) => ({ id: child.id, ...(child.agent ? { agent: child.agent } : {}) })),
      sessions: {},
      seen: sim.seen,
      log: [],
      lane: {
        riftLands: (existsSync(riftLog) ? readFileSync(riftLog, "utf8").split("\n").filter((line) => line !== "") : []).map((line) => JSON.parse(line) as ReadonlyArray<string>),
        agents: [...children].sort((a, b) => created(a) - created(b)).map((child) => child.agent ?? ""),
        said: JSON.stringify(rootMessages),
      },
    }
  } else if (spec.scenario === "subagents") {
    const root = await opencode.sessions.create({ location, ...(spec.rootModel ? { model: spec.rootModel } : {}) })
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
  } else if (spec.scenario === "units") {
    const unit = join(work, "tmp/orchestrate/web/auth")
    mkdirSync(unit, { recursive: true })
    writeFileSync(join(unit, "spec.md"), "")
    const root = await opencode.sessions.create({ location })
    await turn(root.id, `${UNITS_TASK} ${unit}`)
    const page = await opencode.sessions.list({ parentID: root.id, directory: work })
    // The implementor runs in the background (OpenCode runs every subagent so): its hand-back
    // lands when it goes idle, after the root's own turn ended.
    for (const child of page.data) await opencode.experimental.session.wait({ sessionID: child.id })
    await opencode.experimental.session.wait({ sessionID: root.id })
    const file = join(unit, "log.md")
    const unitLog = existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.replace(/^\S+Z /, ""))
      : []
    result = {
      root: { id: root.id, messages: await messages(root.id) },
      children: page.data.map((child) => ({ id: child.id, ...(child.agent ? { agent: child.agent } : {}) })),
      sessions: {},
      seen: sim.seen,
      log: [],
      unitLog,
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
  writeFileSync(join(spec.base, "result.json"), JSON.stringify({ ...result, log: readLog() }, null, 2))
} finally {
  await opencode.close()
  sim.server.stop(true)
}
process.exit(0)
