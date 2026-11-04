// The orchestrate port: the role agents against the orchestrate skill they
// come from, and three runs of real OpenCode (the fork, through its SDK) on
// the scripted model: the guard, compaction per role, and the Sabbath stop.
// The plugin's rules on their own are plugins/orchestrate/test.
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build, DEFAULT_SOURCE, OUT, parseAgent, ROOT } from "../scripts/agents.ts"
import { definitions, effort, ROLES } from "../plugins/orchestrate/src/roles.ts"
import { KEEP } from "../plugins/orchestrate/src/windows.ts"
import type { Result, Spec } from "./orchestrate/run.ts"
import { REVIEW_TASK, SUMMARY, UNTYPED_TASK } from "./orchestrate/sim.ts"

const fork = process.env.OPENCODE_DEV
const skill = existsSync(join(DEFAULT_SOURCE, "scripts/agents.ts"))
const CLAUDE_AGENTS = join(homedir(), ".claude/agents")
if (!fork) console.warn("tests/orchestrate.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")
if (!skill) console.warn(`tests/orchestrate.test.ts: the agent checks skip. No orchestrate skill at ${DEFAULT_SOURCE}.`)

const scratch = mkdtempSync(join(tmpdir(), "orchestrate-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

describe.skipIf(!skill)("the role agents", () => {
  test("each role's prompt and description are the Claude Code agent's, word for word", async () => {
    const built = JSON.parse((await build(ROOT)).text) as { agents: Record<string, { description: string; system: string }> }
    expect(Object.keys(built.agents)).toEqual([...ROLES])
    for (const role of ROLES) {
      const claude = parseAgent(readFileSync(join(CLAUDE_AGENTS, `${role}.md`), "utf8"))
      expect(built.agents[role]!.system).toBe(claude.body.trim())
      expect(built.agents[role]!.description).toBe(claude.fields.description!)
    }
    // Claude-family efforts from the skill role table; the worker uses the model default.
    expect(ROLES.map((role) => effort(role))).toEqual(["high", "medium", "medium", undefined])
  })

  test("--check passes on the written file and fails on a hand edit", () => {
    const root = join(scratch, "check")
    mkdirSync(join(root, "plugins/orchestrate/src"), { recursive: true })
    const file = join(root, OUT)
    const check = () =>
      Bun.spawnSync([process.execPath, join(ROOT, "scripts/agents.ts"), "--check", "--root", root], { stderr: "pipe" })
    expect(check().exitCode).toBe(1)
    cpSync(join(ROOT, OUT), file)
    expect(check().exitCode).toBe(0)
    writeFileSync(file, readFileSync(file, "utf8").replace("Writes one orchestrate unit", "Writes an orchestrate unit"))
    const edited = check()
    expect(edited.exitCode).toBe(1)
    expect(edited.stderr.toString()).toContain(`stale: ${file}`)
  })
})

/** One run of real OpenCode in a scratch home; see tests/orchestrate/run.ts. */
const run = async (name: string, spec: Omit<Spec, "base" | "fork" | "plugin">): Promise<Result> => {
  const base = join(scratch, name)
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ ...spec, base, fork: resolve(fork!), plugin: join(ROOT, "plugins/orchestrate") }))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrate/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result))
    throw new Error(`the ${name} run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

const RUN_MS = 150_000

describe.skipIf(!fork)("in real OpenCode, on the scripted model", () => {
  test("Codex completion wakes its initiating idle session with the final message, once", async () => {
    const result = await run("codex", { scenario: "codex", now: WEDNESDAY, codexPlugin: join(ROOT, "plugins/codex") })
    const messages = result.root!.messages as Array<{ type: string; text?: string }>
    expect(messages.filter((m) => m.type === "synthetic" && m.text?.includes("SCRIPTED CODEX FINAL"))).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain("root: received SCRIPTED CODEX FINAL")
    expect(result.acked).toBe(true)
    const start = result.bridgeCalls!.find((c) => c.path === "/start")!
    expect(start.body).toMatchObject({ owner: result.root!.id, role: "implementor", model: "luna", description: "implementor wake r1" })
    expect(result.bridgeCalls!.filter((c) => c.path === "/ack")).toHaveLength(2)
  }, RUN_MS)

  test(
    "guard: an untyped subagent runs as the worker, `orchestrate-reviewer` as the verifier at medium effort",
    async () => {
      const result = await run("guard", { scenario: "subagents", now: WEDNESDAY })
      const byAgent = Object.fromEntries(result.children.map((child) => [child.agent, child]))
      // The child sessions, as OpenCode's session API reports them.
      expect(result.children.map((child) => child.agent).sort()).toEqual(["verifier", "worker"])
      expect(byAgent.verifier!.model).toEqual({ id: "sim-model", providerID: "sim", variant: "medium" })
      expect(byAgent.worker!.model?.variant).toBeUndefined()
      // Each child ran on its role's prompt.
      const system = (task: string) => result.seen.find((request) => request.task === task)!.system
      expect(system(UNTYPED_TASK)).toContain(definitions.worker.system)
      expect(system(REVIEW_TASK)).toContain(definitions.verifier.system)
      // The worker is offered only its permitted tools: no subagent, no question.
      const tools = result.seen.find((request) => request.task === UNTYPED_TASK)!.tools
      expect(tools).not.toContain("subagent")
      expect(tools).toContain("shell")
      // The call log: what was asked, what ran and why, then each child's session and outcome.
      const calls = result.log.filter((line) => line.kind === "call")
      expect(calls.map(({ asked, agent, reason, model }) => ({ asked, agent, reason, model }))).toEqual([
        { asked: undefined, agent: "worker", reason: "untyped", model: undefined },
        { asked: "orchestrate-reviewer", agent: "verifier", reason: "renamed", model: "sim/sim-model#medium" },
      ])
      const done = result.log.filter((line) => line.kind === "done")
      expect(done.map(({ child, status }) => ({ child, status }))).toEqual([
        { child: byAgent.worker!.id, status: "completed" },
        { child: byAgent.verifier!.id, status: "completed" },
      ])
      expect(done.map((line) => line.callID)).toEqual(calls.map((line) => line.callID))
    },
    RUN_MS,
  )

  test(
    "compaction: a planner session over its 50k window compacts; a worker session at 100k does not",
    async () => {
      // 40k tokens of input on every reply: over the planner's ceiling (50k less the 16k reserve), under the worker's.
      const result = await run("compaction", {
        scenario: "compaction",
        now: WEDNESDAY,
        windows: { planner: 50_000, worker: 100_000 },
        promptTokens: 40_000,
      })
      type Message = { type: string; status?: string; reason?: string; summary?: string }
      const messages = (agent: string) => result.sessions[agent]!.messages as Message[]
      const compactions = (agent: string) => messages(agent).filter((message) => message.type === "compaction")
      expect(result.sessions.planner!.agent).toBe("planner")
      expect(compactions("planner").map(({ status, reason }) => ({ status, reason }))).toEqual([
        { status: "completed", reason: "auto" },
      ])
      // The planner's second turn went on from the summary.
      expect(messages("planner").at(-2)?.type).toBe("assistant")
      expect(compactions("worker")).toEqual([])
      // The compaction request carried the keep-list; no other request did.
      const keeping = result.seen.filter((request) => request.system.includes(KEEP))
      expect(keeping.length).toBe(1)
      expect(keeping[0]!.task).toBe("planner: first")
      expect(keeping[0]!.last).toContain("You MUST summarize the conversation")
      expect(JSON.stringify(messages("planner"))).toContain(SUMMARY.split("\n")[1]!)
    },
    RUN_MS,
  )

  test(
    "Sabbath: on Friday evening the subagent calls are refused with when work resumes, and no child starts",
    async () => {
      const result = await run("sabbath", { scenario: "subagents", now: FRIDAY_EVENING })
      expect(result.children).toEqual([])
      const denied = result.log.filter((line) => line.kind === "denied")
      expect(denied.map((line) => line.tool)).toEqual(["subagent", "subagent"])
      for (const line of denied) expect(line.why).toMatch(SABBATH)
      // The model was told, in the tool result.
      const results = result.seen.filter((request) => request.task === "orchestrate").map((request) => request.last)
      expect(results.slice(1).every((text) => text.includes("No agent starts now."))).toBe(true)
      expect(results.slice(1).every((text) => /It is the Sabbath; agent work resumes at Sat 18:\d\d/.test(text))).toBe(true)
    },
    RUN_MS,
  )
})
