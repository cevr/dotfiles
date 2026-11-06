// The orchestrate port: the role agents against the orchestrate skill they
// come from, and three runs of real OpenCode (the fork, through its SDK) on
// the scripted model: the guard, compaction per role, and the Sabbath stop.
// The plugin's rules on their own are tested beside mods/orchestrate and cmd/orchestrate.
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build, DEFAULT_SOURCE, OUT, parseAgent, ROOT } from "../scripts/agents.ts"
import { definitions, effort, ROLES } from "../mods/orchestrate/role.ts"
import { KEEP } from "../mods/orchestrate/compaction.ts"
import type { Result, Spec } from "./orchestrate/run.ts"
import { REVIEW_TASK, SUMMARY, UNTYPED_TASK } from "./orchestrate/sim.ts"

const fork = process.env.OPENCODE_DEV
const skill = existsSync(join(DEFAULT_SOURCE, "scripts/agents.ts"))
const CLAUDE_AGENTS = resolve(ROOT, "../agents")
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
    mkdirSync(join(root, "mods/orchestrate"), { recursive: true })
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
  writeFileSync(file, JSON.stringify({ ...spec, base, fork: resolve(fork!), plugin: join(ROOT, "cmd/orchestrate") }))
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
  test("pace: with no wakes to keep a latch, an over-limit pool refuses new agents with when it opens; under pace they run", async () => {
    const held = await run("pace-held", { scenario: "subagents", now: WEDNESDAY, pace: true })
    expect(held.children).toEqual([])
    const messages = JSON.stringify(held.root!.messages)
    expect(messages).toContain("pace holds this agent")
    // The fake pool says it opens a minute on; tests/prime-latch.test.ts runs the latch itself.
    expect(messages).toContain(`It opens about ${new Date(Date.parse(WEDNESDAY) + 60_000).toISOString()}`)
    expect(messages).toContain("no latch could be kept for it")
    const open = await run("pace-open", { scenario: "subagents", now: WEDNESDAY, pace: false })
    expect(open.children.map((child) => child.agent).sort()).toEqual(["verifier", "worker"])
  }, RUN_MS)

  test("codex pace: a subagent on a Codex-paced provider asks the Codex admission, with its model and role", async () => {
    const held = await run("codex-held", { scenario: "subagents", now: WEDNESDAY, codex: "hold", pace: false })
    expect(held.children).toEqual([])
    const messages = JSON.stringify(held.root!.messages)
    expect(messages).toContain("the Codex account's pace holds this agent. scripted Codex week is over.")
    // It opens when the admission said the week opens.
    expect(messages).toContain("It opens about 2026-11-04T16:20:00.000Z")
    const asked = readFileSync(join(scratch, "codex-held", "codex-args.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(asked).toContainEqual(["--codex", "--admit", "--model", "sim-model", "--role", "worker"])
    expect(asked).toContainEqual(["--codex", "--admit", "--model", "sim-model", "--role", "verifier"])
    // Admitted, they run, and the pool is not asked: its fake would hold them.
    const open = await run("codex-open", { scenario: "subagents", now: WEDNESDAY, codex: "admit", pace: true })
    expect(open.children.map((child) => child.agent).sort()).toEqual(["verifier", "worker"])
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
    "worker ceiling: under a root at max, the untyped worker runs at its model's default and the parent is told why; the verifier at medium",
    async () => {
      const result = await run("ceiling", { scenario: "subagents", now: WEDNESDAY, rootModel: { providerID: "sim", id: "sim-model", variant: "max" } })
      const byAgent = Object.fromEntries(result.children.map((child) => [child.agent, child]))
      // The host names a model asked with no variant at its `default`.
      expect(byAgent.worker!.model).toEqual({ id: "sim-model", providerID: "sim", variant: "default" })
      expect(byAgent.verifier!.model).toEqual({ id: "sim-model", providerID: "sim", variant: "medium" })
      const calls = result.log.filter((line) => line.kind === "call")
      expect(calls.map(({ agent, model, lowered }) => ({ agent, model, lowered }))).toEqual([
        { agent: "worker", model: "sim/sim-model", lowered: "max" },
        { agent: "verifier", model: "sim/sim-model#medium", lowered: undefined },
      ])
      expect(JSON.stringify(result.root!.messages)).toContain(
        "orchestrate: this worker runs on sim/sim-model at the model's default effort, not max: a worker runs at max only when its description ends `(mechanical)`.",
      )
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
      // The compaction request carried the keep-list after the conversation, right before the summary prompt, not
      // in its system, so its prefix is the normal request's and stays cached; no other request carried it.
      expect(result.seen.filter((request) => request.system.includes(KEEP))).toEqual([])
      const texts = (request: (typeof result.seen)[number]) => request.messages.map((message) => JSON.stringify(message.content ?? ""))
      const keeping = result.seen.filter((request) => texts(request).some((text) => text.includes(KEEP)))
      expect(keeping.length).toBe(1)
      const compaction = keeping[0]!
      expect(compaction.task).toBe("planner: first")
      expect(compaction.last).toContain("You MUST summarize the conversation")
      expect(texts(compaction).at(-2)).toContain(KEEP)
      // Every message the planner's request before it sent opens the compaction request unchanged.
      const before = result.seen[result.seen.indexOf(compaction) - 1]!
      expect(before.task).toBe("planner: first")
      expect(compaction.messages.slice(0, before.messages.length)).toEqual([...before.messages])
      expect(JSON.stringify(messages("planner"))).toContain(SUMMARY.split("\n")[1]!)
    },
    RUN_MS,
  )

  test(
    "restart: a foreground subagent a shutdown cut is resumed once in the background and its parent told once; one the user interrupted is not",
    async () => {
      const result = await run("restart", { scenario: "restart", now: WEDNESDAY, resumeBackoffMs: [500, 500, 500] })
      type Message = { type: string; text?: string; metadata?: Record<string, unknown>; content?: ReadonlyArray<{ type: string; text?: string }> }
      const messages = (name: string) => result.sessions[name]!.messages as Message[]
      const resumes = (name: string) => messages(name).filter((message) => message.type === "user" && message.text?.startsWith("Your turn ended when OpenCode restarted"))
      const notices = (name: string) => messages(name).filter((message) => message.type === "synthetic" && message.metadata?.source === "orchestrate")
      // The cut child got the resume prompt once, and answered after it.
      expect(resumes("child").length).toBe(1)
      const after = messages("child").slice(messages("child").indexOf(resumes("child")[0]!) + 1)
      expect(after.some((message) => message.type === "assistant" && message.content?.some((part) => part.text?.startsWith("sim: ")))).toBe(true)
      // The call log has its one resume, in its parent's call.
      const resumed = result.log.filter((line) => line.kind === "resumed")
      expect(resumed.map(({ child, cause, attempt, description }) => ({ child, cause, attempt, description }))).toEqual([
        { child: result.children[0]!.id, cause: "restart", attempt: 1, description: "restart-root child" },
      ])
      // Its parent was told once, naming it; the interrupted root and its child were left alone.
      expect(notices("root").map((message) => message.metadata?.children)).toEqual([[result.children[0]!.id]])
      expect(resumes("escapedChild")).toEqual([])
      expect(notices("escaped")).toEqual([])
      // No child was made again.
      expect(result.children.length).toBe(2)
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
