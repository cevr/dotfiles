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
 * - `machine`: the root runs the sim's machine task (three implementors, a
 *   compaction, a refused verifier and land, the batch's land and verifier),
 *   with a fixture `rift` tool written beside the fake pace plugin and the
 *   plugin's ledger in the scratch dir; the result carries the lands, the
 *   root's children, its ledger lines and its own requests.
 * - `pipeline`: one root, each turn one `probe:` call, runs two batches as
 *   a pipeline: batch-1's verifier runs in the background (the sim holds it
 *   until the test opens its gate) while batch-2 fans out; its findings file
 *   is written to `run/`; one finding folds into a running implementor (a
 *   follow-up with its sessionID), one into a new fix unit; batch-2 lands
 *   without export, whose finding rides with it, and its verifier starts;
 *   export lands as batch-3, whose verifier is told its finding. The result carries the root's ledger lines, the
 *   lands and every model request.
 * - `move`: two roots, each turn one `probe:` call, move between `work` and
 *   `other` (two plugin copies, one per location) between their steps: one
 *   lands one of two ready units, the other keeps the machine through a land,
 *   a verifier's hand-back and the next land; the result carries each one's
 *   ledger lines and the lands.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HAND_BACK, isMachineRoot, MACHINE_DONE, MACHINE_TASK, machineTokens, PROBE, ROOT_TASK, serve, UNITS_TASK } from "./sim.ts"

export interface Spec {
  readonly scenario: "subagents" | "compaction" | "units" | "machine" | "move" | "pipeline"
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

/** What the `pipeline` scenario adds (tests/orchestrate-machine.test.ts). */
export interface PipelineResult extends Result {
  /** The `rifts` of each land the fixture rift tool ran, in order. */
  readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
  /** The ledger's lines of the root. */
  readonly ledger: ReadonlyArray<Record<string, unknown>>
  /** The second root's run of round 1's edges (M2, a covered unit's next round; M1, an unread report): its lines, its lands and its messages. */
  readonly edges: {
    readonly ledger: ReadonlyArray<Record<string, unknown>>
    readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
    readonly messages: unknown
  }
}

/** What the `move` scenario adds (tests/orchestrate-machine.test.ts). */
export interface MoveResult extends Result {
  /** The `rifts` of each land the fixture rift tool ran, in order. */
  readonly riftLands: ReadonlyArray<ReadonlyArray<string>>
  /** The ledger's lines of the root that lands one of two ready units after its moves. */
  readonly partial: ReadonlyArray<Record<string, unknown>>
  /** The ledger's lines of the root that keeps the machine across its moves. */
  readonly legal: ReadonlyArray<Record<string, unknown>>
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
const machined = spec.scenario === "machine" || spec.scenario === "move" || spec.scenario === "pipeline"
if (machined) {
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
        ...(machined ? { ledger: ledgerFile } : {}),
      },
    },
    ...(spec.pace !== undefined ? [{ package: pacePlugin }] : []),
    ...(machined ? [{ package: riftPlugin }] : []),
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
const { OpenCode } = (await import(join(spec.fork, "packages/sdk/src/index.ts"))) as Sdk
/** One OpenCode. */
const open = () =>
  OpenCode.create({
    events: { persist: true },
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
  if (spec.scenario === "pipeline") {
    const lines = () =>
      (existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n") : []).flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
    // Batch-1's findings, as its verifier writes them: a batch file naming each unit's findings file.
    const run = join(spec.base, "run")
    for (const unit of ["auth", "billing"]) {
      mkdirSync(join(run, unit), { recursive: true })
      writeFileSync(join(run, unit, "round-1-findings.md"), `Verdict: CHANGES REQUIRED\n\n## Blockers\nNone.\n\n## Major\n\n### M1 — ${unit} drops a line\n`)
    }
    const report = join(run, "batch-1-findings.md")
    writeFileSync(report, "changes\n\n| Unit | Round | Verdict | Findings |\n| --- | --- | --- | --- |\n| auth | 1 | changes | auth/round-1-findings.md |\n| billing | 1 | changes | billing/round-1-findings.md |\n")
    const root = await opencode.sessions.create({ location })
    const call = (name: string, input: Record<string, unknown>) => turn(root.id, `${PROBE}${JSON.stringify({ name, input })}`)
    const implement = (unit: string, extra: Record<string, unknown> = {}, gate?: string) =>
      call("subagent", {
        agent: "implementor",
        description: `implementor ${unit} r1`,
        prompt: `${gate === undefined ? "" : `gate:${gate}\n`}${HAND_BACK} implementor ${unit} r1: ready /nonexistent/loop-probe-x/request.md`,
        ...extra,
      })
    const land = (rifts: ReadonlyArray<string>) => call("rift", { action: "land", rifts })
    const has = (match: (line: Record<string, unknown>) => boolean) => until(() => lines().some((line) => line.sessionID === root.id && match(line)), 20_000)
    // Batch 1: two units, landed together; its verifier runs in the background, held until the gate opens.
    await implement("auth")
    await implement("billing")
    await land(["auth", "billing"])
    await call("subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `gate:verify-1\n${HAND_BACK} verifier batch-1 r1: changes ${report}`, background: true })
    // Batch 2 fans out while it verifies: search hands back, export still runs.
    await implement("search")
    await implement("export", { background: true }, "export")
    await land(["search"])
    // The verdict comes in; its findings are not folded yet.
    sim.open("verify-1")
    if (!(await has((line) => line.kind === "VerifierEnded"))) throw new Error("batch-1's verdict never reached the ledger")
    await land(["search"])
    // auth/M1 goes to export's running implementor as a round message, billing/M1 to a new fix unit.
    const exported = lines().find((line) => line.sessionID === root.id && line.kind === "StepSpawned" && line.name === "export")
    if (exported === undefined) throw new Error("export's session never reached the ledger")
    await call("subagent", {
      agent: "implementor",
      description: "implementor export r1 (folds: auth/M1)",
      prompt: `Fold auth/M1 (${join(run, "auth/round-1-findings.md")}) into this round.`,
      sessionID: exported.child,
      background: true,
    })
    await implement("billing-fix1", { description: "implementor billing-fix1 r1 (folds: billing/M1)" })
    await implement("docs")
    // auth/M1 rides with export, still implementing: it holds no land, so the three ready units land without it.
    await land(["search", "billing-fix1", "docs"])
    await call("subagent", { agent: "verifier", description: "verifier batch-2 r1", prompt: `${HAND_BACK} verifier batch-2 r1: accepted /nonexistent/loop-probe-x/findings.md` })
    if (!(await has((line) => line.kind === "VerifierEnded" && line.batch === "batch-2"))) throw new Error("batch-2's verdict never reached the ledger")
    // Export hands back and lands in its own batch; that batch's verifier is told auth/M1.
    sim.open("export")
    if (!(await has((line) => line.kind === "UnitHandedBack" && line.unit === "export" && line.ready === true))) throw new Error("export never handed back ready")
    await opencode.experimental.session.wait({ sessionID: String(exported.child) })
    await land(["export"])
    await call("subagent", { agent: "verifier", description: "verifier batch-3 r1", prompt: `${HAND_BACK} verifier batch-3 r1: accepted /nonexistent/loop-probe-x/findings.md` })
    const riftLands = () => (existsSync(riftLog) ? readFileSync(riftLog, "utf8").split("\n").filter((line) => line !== "") : []).map((line) => JSON.parse(line) as ReadonlyArray<string>)
    const lands = riftLands()

    // The edges round 1's verifier proved live (orch-pipeline r1 M1, M2), on a root of their own.
    const edge = await opencode.sessions.create({ location })
    const at = (name: string, input: Record<string, unknown>) => turn(edge.id, `${PROBE}${JSON.stringify({ name, input })}`)
    const step = (unit: string, round = 1, extra: Record<string, unknown> = {}) =>
      at("subagent", { agent: "implementor", description: `implementor ${unit} r${round}`, prompt: `${HAND_BACK} implementor ${unit} r${round}: ready /nonexistent/loop-probe-x/request.md`, ...extra })
    const landEdge = (rifts: ReadonlyArray<string>) => at("rift", { action: "land", rifts })
    const edgeHas = (match: (line: Record<string, unknown>) => boolean) => until(() => lines().some((line) => line.sessionID === edge.id && match(line)), 20_000)
    // M2: the covered unit's round 2 hands back while its batch's verifier runs; its land waits for the verdict.
    await step("repeat")
    await landEdge(["repeat"])
    await at("subagent", { agent: "verifier", description: "verifier batch-r1 r1", prompt: `gate:repeat-verifier\n${HAND_BACK} verifier batch-r1 r1: accepted /nonexistent/loop-probe-x/findings.md`, background: true })
    await step("repeat", 2)
    await landEdge(["repeat"])
    sim.open("repeat-verifier")
    if (!(await edgeHas((line) => line.kind === "VerifierEnded" && line.batch === "batch-r1"))) throw new Error("batch-r1's verdict never reached the ledger")
    await landEdge(["repeat"])
    // M1: a `changes` whose report does not read yet holds the next land; once written, it is read again, and its finding folds.
    const edgeRun = join(run, "edge")
    const missing = join(edgeRun, "batch-m1-findings.md")
    await at("subagent", { agent: "verifier", description: "verifier batch-m1 r1", prompt: `${HAND_BACK} verifier batch-m1 r1: changes ${missing}` })
    if (!(await edgeHas((line) => line.kind === "VerifierEnded" && line.batch === "batch-m1"))) throw new Error("batch-m1's verdict never reached the ledger")
    await step("after")
    await landEdge(["after"])
    mkdirSync(join(edgeRun, "repeat"), { recursive: true })
    writeFileSync(join(edgeRun, "repeat", "round-1-findings.md"), "Verdict: CHANGES REQUIRED\n\n## Major\n\n### M1 — repeat drops a line\n")
    writeFileSync(missing, "changes\n\n| repeat | 1 | changes | repeat/round-1-findings.md |\n")
    await landEdge(["after"])
    await step("repeat-fix1", 1, { description: "implementor repeat-fix1 r1 (folds: repeat/M1)" })
    await landEdge(["after", "repeat-fix1"])
    const piped: PipelineResult = {
      children: [],
      sessions: {},
      seen: sim.seen,
      log: [],
      riftLands: lands,
      ledger: lines().filter((line) => line.sessionID === root.id),
      root: { id: root.id, messages: await messages(root.id) },
      edges: { ledger: lines().filter((line) => line.sessionID === edge.id), riftLands: riftLands().slice(lands.length), messages: await messages(edge.id) },
    }
    result = piped
  } else if (spec.scenario === "move") {
    const other = join(spec.base, "other")
    mkdirSync(other, { recursive: true })
    const call = (sessionID: string, name: string, input: Record<string, unknown>) => turn(sessionID, `${PROBE}${JSON.stringify({ name, input })}`)
    const implement = (sessionID: string, unit: string) =>
      call(sessionID, "subagent", { agent: "implementor", description: `implementor ${unit} r1`, prompt: `${HAND_BACK} implementor ${unit} r1: ready /nonexistent/loop-probe-x/request.md` })
    const moveTo = async (sessionID: string, directory: string) => {
      await opencode.sessions.move({ sessionID, directory })
      await opencode.experimental.session.wait({ sessionID })
    }
    // A root that drifts across a move: a ready unit here, one there, then a land of the first alone.
    const partial = await opencode.sessions.create({ location })
    await implement(partial.id, "move-a")
    await moveTo(partial.id, other)
    await implement(partial.id, "move-b")
    await moveTo(partial.id, work)
    await call(partial.id, "rift", { action: "land", rifts: ["move-a"] })
    // A root that keeps the machine across moves: both units land, the batch's verifier hands back, the next unit lands.
    const legal = await opencode.sessions.create({ location })
    await implement(legal.id, "legal-a")
    await moveTo(legal.id, other)
    await implement(legal.id, "legal-b")
    await moveTo(legal.id, work)
    await call(legal.id, "rift", { action: "land", rifts: ["legal-a", "legal-b"] })
    await moveTo(legal.id, other)
    // `accepted`: a `changes` whose report does not read would hold legal-c's land (orch-pipeline r1 M1), and this run is the compliant one.
    await call(legal.id, "subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `${HAND_BACK} verifier batch-1 r1: accepted /nonexistent/loop-probe-x/findings.md` })
    await moveTo(legal.id, work)
    await implement(legal.id, "legal-c")
    await call(legal.id, "rift", { action: "land", rifts: ["legal-c"] })
    const lines = (existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n") : []).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
    const moved: MoveResult = {
      children: [],
      sessions: {},
      seen: [],
      log: [],
      riftLands: (existsSync(riftLog) ? readFileSync(riftLog, "utf8").split("\n").filter((line) => line !== "") : []).map((line) => JSON.parse(line) as ReadonlyArray<string>),
      partial: lines.filter((line) => line.sessionID === partial.id),
      legal: lines.filter((line) => line.sessionID === legal.id),
    }
    result = moved
  } else if (spec.scenario === "machine") {
    const root = await opencode.sessions.create({ location })
    await turn(root.id, MACHINE_TASK)
    // OpenCode runs every subagent in the background: each child's report wakes the root for its next step,
    // until the batch's verifier hands back and the root says it is done.
    const done = await until(async () => JSON.stringify(await messages(root.id)).includes(MACHINE_DONE), 90_000)
    if (!done) throw new Error("the machine run's root never finished its script")
    await opencode.experimental.session.wait({ sessionID: root.id })
    // The verifier's hand-back reaches the ledger on its idle.
    await until(() => readFileSync(ledgerFile, "utf8").includes("VerifierEnded"), 10_000)
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
