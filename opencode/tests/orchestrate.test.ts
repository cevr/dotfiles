// accept: deep (36.5 s alone on a quiet host: 1-minute load 5.3–6.2 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// The orchestrate port: the role agents against the orchestrate skill they
// come from, and a run of real OpenCode (the fork, through its SDK) on
// the scripted model that moves a unit's log.md. The paces, the guard,
// compaction per role and the Sabbath stop run on the simulated host:
// cmd/orchestrate/orchestrate.sim.test.ts (tests/parity/orchestrate.json).
// The plugin's rules on their own are tested beside mods/orchestrate and cmd/orchestrate.
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build, DEFAULT_SOURCE, OUT, parseAgent, ROOT } from "../scripts/agents.ts"
import { effort, ROLES } from "../mods/orchestrate/role.ts"
import type { Result, Spec } from "./orchestrate/run.ts"
import { owned } from "./owned.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
const skill = existsSync(join(DEFAULT_SOURCE, "scripts/agents.ts"))
const CLAUDE_AGENTS = resolve(ROOT, "../agents")
if (!fork) console.warn("tests/orchestrate.test.ts: the OpenCode runs skip. Set OPENCODE_DEV to the fork.")
if (!skill) console.warn(`tests/orchestrate.test.ts: the agent checks skip. No orchestrate skill at ${DEFAULT_SOURCE}.`)

const scratch = scratchDir("orchestrate-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"

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
    expect(ROLES.map((role) => effort(role))).toEqual(["medium", "medium", "medium", undefined])
  })

  test("every role may ask the owner in the background: ask_user_async is not denied under the deny-all rule", () => {
    // The fork hides a tool whose last matching rule denies every resource (packages/core/src/tool.ts `whollyDisabled`).
    const disabled = (action: string, rules: ReadonlyArray<{ action: string; resource: string; effect: string }>) => {
      const rule = rules.findLast((candidate) => candidate.action === "*" || candidate.action === action)
      return rule?.resource === "*" && rule.effect === "deny"
    }
    const written = JSON.parse(readFileSync(join(ROOT, OUT), "utf8")) as { agents: Record<string, { permissions: ReadonlyArray<{ action: string; resource: string; effect: string }> }> }
    for (const role of ROLES) {
      expect([role, disabled("ask_user_async", written.agents[role]!.permissions)]).toEqual([role, false])
      expect([role, disabled("question", written.agents[role]!.permissions)]).toEqual([role, true])
    }
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
  const child = owned([process.execPath, join(import.meta.dir, "orchestrate/run.ts"), file], {
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
  test(
    "units: an implementor's start and its hand-back move its unit in the run's log.md",
    async () => {
      const result = await run("units", { scenario: "units", now: WEDNESDAY })
      expect(result.children.map((child) => child.agent)).toEqual(["implementor"])
      expect(result.unitLog).toEqual(["new → implement r1 spec.md", "implement → ready r1 round-1-request.md ready"])
    },
    RUN_MS,
  )
})
