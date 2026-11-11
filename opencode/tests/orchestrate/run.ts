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
 * - `restart`: on a database file, two roots each call a foreground
 *   subagent whose model request hangs; the user interrupts the second root,
 *   then OpenCode shuts down while the first waits, and starts again on the
 *   same database. The run ends once the first root's child answered after
 *   the plugin resumed it, or after a minute.
 * - `machine`: the root runs the sim's machine task (three implementors, a
 *   compaction, a refused verifier and land, the batch's land and verifier),
 *   with a fixture `rift` tool written beside the fake pace plugin and the
 *   plugin's ledger in the scratch dir; the result carries the lands, the
 *   root's children, its ledger lines and its own requests.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ESCAPE_TASK, isMachineRoot, MACHINE_TASK, machineTokens, RESTART_TASK, ROOT_TASK, serve, UNITS_TASK } from "./sim.ts"

export interface Spec {
  readonly scenario: "subagents" | "compaction" | "units" | "restart" | "machine"
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
  /** The plugin's `resume.backoffMs`: the waits before it resumes a subagent a restart cut. */
  readonly resumeBackoffMs?: ReadonlyArray<number>
  /** The root session's model, such as the sim model at `max`; the config's default when absent. */
  readonly rootModel?: Child["model"]
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
}

/** What the `machine` scenario adds (tests/orchestrate-machine.test.ts). */
export interface MachineResult extends Result {
  /** The `rifts` of each land the fixture rift tool ran, in order. */
  readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
  /** Each child of the root, in the order made: its agent and its call's description. */
  readonly steps: ReadonlyArray<{ readonly agent: string; readonly description: string }>
  /** The ledger's lines for the root. */
  readonly ledger: ReadonlyArray<Record<string, unknown>>
  /** The root's own model requests in order, its summary request among them. */
  readonly rootRequests: ReadonlyArray<{ readonly last: string; readonly messages: ReadonlyArray<unknown> }>
}

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Spec
const work = join(spec.base, "work")
const config = join(spec.base, "config")
const logFile = join(spec.base, "agents.jsonl")
mkdirSync(work, { recursive: true })
mkdirSync(config, { recursive: true })

const tokens = spec.promptTokens
const sim = serve(spec.scenario === "machine" ? machineTokens : typeof tokens === "object" ? (task) => tokens[task.split(":")[0]!] ?? 100 : tokens)
// The machine run's `rift` tool: a fixture that only records each land's Rifts and answers as a pushed land does.
const riftPlugin = join(spec.base, "fake-rift")
const riftLog = join(spec.base, "rift-lands.jsonl")
const ledgerFile = join(spec.base, "machine.jsonl")
if (spec.scenario === "machine") {
  mkdirSync(riftPlugin, { recursive: true })
  writeFileSync(join(riftPlugin, "package.json"), JSON.stringify({ type: "module", exports: { "./server": "./server.js" } }))
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
      '          return { content: [{ type: "text", text: `Landed ${rifts.length} Rift(s) as one push: ${rifts.join(", ")}.` }], metadata: { action: "land" } }',
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
  writeFileSync(join(pacePlugin, "package.json"), JSON.stringify({ type: "module", exports: { "./server": "./server.js" } }))
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
      package: spec.plugin,
      options: {
        log: logFile,
        now: spec.now,
        unitLog: join(spec.plugin, "../../../skills/orchestrate/scripts/log.ts"),
        ...codexOption,
        ...(spec.resumeBackoffMs === undefined ? {} : { resume: { backoffMs: spec.resumeBackoffMs } }),
        ...(spec.scenario === "machine" ? { ledger: ledgerFile } : {}),
      },
    },
    ...(spec.pace !== undefined ? [{ package: pacePlugin }] : []),
    ...(spec.scenario === "machine" ? [{ package: riftPlugin }] : []),
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
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
  readonly close: () => Promise<void>
}
interface Sdk {
  readonly OpenCode: { readonly create: (options: Record<string, unknown>) => Promise<Embedded> }
}
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk
/** One OpenCode; the restart scenario keeps its database in a file, so a second one starts on what the first left. */
const open = () =>
  OpenCode.create({
    events: { persist: true },
    config: { directory: config, project: false, content: JSON.stringify(content) },
    ...(spec.scenario === "restart" ? { database: { path: join(spec.base, "opencode.db") } } : {}),
  })
let opencode = await open()

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
const childrenOf = async (parentID: string) => (await opencode.sessions.list({ parentID, directory: work })).data.map((item) => item.id)
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
  if (spec.scenario === "restart") {
    const root = await opencode.sessions.create({ location })
    const escaped = await opencode.sessions.create({ location })
    await opencode.sessions.prompt({ sessionID: root.id, text: RESTART_TASK })
    await opencode.sessions.prompt({ sessionID: escaped.id, text: ESCAPE_TASK })
    if (!(await until(() => sim.hanging() >= 2, 30_000))) throw new Error(`the children did not start: ${sim.hanging()} hang`)
    // The user's Escape on the second root, then a shutdown while the first waits on its child.
    await opencode.sessions.interrupt({ sessionID: escaped.id })
    await opencode.experimental.session.wait({ sessionID: escaped.id })
    const [child] = await childrenOf(root.id)
    const [escapedChild] = await childrenOf(escaped.id)
    if (child === undefined || escapedChild === undefined) throw new Error("a root made no child")
    await opencode.close()
    sim.release()
    opencode = await open()
    // Resumed, answered after the resume prompt, and its parent told.
    const answered = async () => {
      const list = (await messages(child)) as ReadonlyArray<{ type: string; text?: string; time?: { completed?: unknown } }>
      const resumed = list.findIndex((message) => message.type === "user" && message.text?.startsWith("Your turn ended when OpenCode restarted") === true)
      return resumed >= 0 && list.slice(resumed + 1).some((message) => message.type === "assistant" && message.time?.completed !== undefined)
    }
    const done = await until(answered, 60_000)
    if (done) {
      await opencode.experimental.session.wait({ sessionID: child })
      await opencode.experimental.session.wait({ sessionID: root.id })
    }
    // A late resume of the interrupted child would show by now.
    await sleep(1_000)
    const sessions: Result["sessions"] = {}
    for (const [name, id] of [["root", root.id], ["child", child], ["escaped", escaped.id], ["escapedChild", escapedChild]] as const)
      sessions[name] = { messages: await messages(id) }
    const children = [...(await childrenOf(root.id)), ...(await childrenOf(escaped.id))].map((id) => ({ id }))
    result = { children, sessions, seen: sim.seen, log: [] }
  } else if (spec.scenario === "machine") {
    const root = await opencode.sessions.create({ location })
    await turn(root.id, MACHINE_TASK)
    // The verifier's hand-back reaches the ledger on its idle, just after the root's call returns.
    const page = await opencode.sessions.list({ parentID: root.id, directory: work })
    const children = await Promise.all(page.data.map((item) => opencode.sessions.get({ sessionID: item.id })))
    const created = (child: SessionInfo) => {
      const at = child.time?.created
      return typeof at === "number" ? at : Date.parse(String(at))
    }
    const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [])
    const machine: MachineResult = {
      root: { id: root.id, messages: await messages(root.id) },
      children: children.map((child) => ({ id: child.id, ...(child.agent ? { agent: child.agent } : {}) })),
      sessions: {},
      seen: sim.seen,
      log: [],
      riftLands: lines(riftLog).map((line) => JSON.parse(line) as ReadonlyArray<string>),
      steps: [...children].sort((a, b) => created(a) - created(b)).map((child) => ({ agent: child.agent ?? "", description: child.title ?? "" })),
      ledger: lines(ledgerFile)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>]
          } catch {
            return []
          }
        })
        .filter((line) => line.sessionID === root.id),
      rootRequests: sim.seen.filter(isMachineRoot).map((seen) => ({ last: seen.last, messages: seen.messages })),
    }
    result = machine
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
