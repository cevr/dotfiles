#!/usr/bin/env bun
// Writes the orchestrate roles (planner, implementor, verifier) and the lean
// worker as OpenCode agents, from the same source as Claude Code's: the
// orchestrate skill's protocol.md and loop/safety.md, through its own
// scripts/agents.ts, so the prompt text is the Claude Code agents' word for
// word. The worker's prompt and description come from its hand-written
// Claude Code agent file.
//
// Out: mods/orchestrate/agents.json, each role as the fields of an
// OpenCode agent (`Agent.Info`: description, mode, permissions, system) plus
// its Claude-family reasoning effort (the skill's role table). The
// orchestrate plugin defines the agents from it through `agent.transform`,
// as OpenCode's own plugins define build, plan and general, so an agent file
// in the owner's config still overrides a role, and the plugin can give each
// role its compaction window (config agent files cannot set it).
// Beside the roles it writes `orchestrator`: the description and prompt
// section of the primary agent a new session opens with (the plugin derives
// its other fields from build), the section carrying SKILL.md's no-block rule.
//
// Usage: bun scripts/agents.ts [--check] [--root <dir>] [--source <orchestrate skill dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Array as Arr, Data, Option } from "effect"
import { immutable } from "../mods/orchestrate/immutable.ts"

/** What this script uses from the orchestrate skill's scripts/agents.ts. */
interface Source {
  readonly ROLES: Readonly<Record<string, string>>
  readonly AGENTS: string
  readonly instructions: (role: string, protocol: string, safety: string) => string
  readonly agentFile: (role: string, protocol: string, safety: string) => string
}

export const ROOT = resolve(import.meta.dir, "..")
export const DEFAULT_SOURCE = resolve(ROOT, "../skills/orchestrate")
export const WORKER = "worker"
const WRITTEN = "Written by dotfiles opencode/scripts/agents.ts from the orchestrate skill. Edit the skill, then run `bun run agents`."

/**
 * The tools Claude Code gives these agents (Bash, Read, Edit, Write, Skill,
 * Monitor, TaskStop, WebFetch, WebSearch) as OpenCode permissions, with the
 * orchestrate plugin's `principles` tool (list, search, get). Everything
 * else is denied, as the built-in explore agent does: no subagent, question,
 * todo, glob/grep tool or MCP tool. Edit and Write are the `edit` permission
 * (edit, write and patch); Monitor and TaskStop are background `shell` work.
 * Reading a .env file still asks, as for every built-in agent.
 * The question tools stay: `ask_orchestrator` and `answer_subagent` (the
 * orchestrate plugin, mods/orchestrate/asking.ts), so a role asks its
 * orchestrator and answers its own subagents, and `ask_user_async` (the
 * questions plugin) for the owner. Which of the two ask tools a session sees
 * is the orchestrate plugin's `subagents` option: by default a subagent agent
 * has `ask_user_async` denied after these rules, and with `subagents: "owner"`
 * it asks the owner as before.
 */
export const PERMISSIONS = immutable([
  { action: "*", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "skill", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "principles", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "allow" },
  { action: "ask_user_async", resource: "*", effect: "allow" },
  { action: "ask_orchestrator", resource: "*", effect: "allow" },
  { action: "answer_subagent", resource: "*", effect: "allow" },
] as const)

export interface Built {
  readonly path: string
  readonly text: string
}

/** A Claude Code agent file's front matter fields and body. */
export const parseAgent = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error("an agent file without front matter")
  const fields = Object.fromEntries(
    match[1]!
      .split("\n")
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
  )
  return { fields, body: match[2]! }
}

/** One role as OpenCode agent fields, and the effort it runs at. */
export interface Definition {
  readonly description: string
  readonly mode: "subagent"
  readonly permissions: typeof PERMISSIONS
  readonly system: string
  readonly effort?: string
}

export const OUT = "mods/orchestrate/agents.json"

/** The primary agent a new session opens with: build's tools, permissions and prompt, with `section` after the prompt. */
export const ORCHESTRATOR = "orchestrator"
const ORCHESTRATOR_DESCRIPTION =
  "The default agent: build with the orchestrate rules. Coordinates a run's units through planner, implementor and verifier subagents; answers a plain question or makes a small edit directly."
/** The skill line the orchestrator carries word for word: SKILL.md's rule under "Between messages". */
export const NO_BLOCK = "- **Never block on the shell.**"

/** SKILL.md no longer holds the rule the orchestrator carries. */
export class LostRule extends Data.TaggedError("LostRule")<{ readonly message: string }> {}

/** The orchestrator's section: who it is, and the skill's no-block rule word for word. */
export const orchestratorSection = (skill: string) => {
  const rule = Option.getOrThrowWith(Arr.findFirst(skill.split("\n"), (line) => line.startsWith(NO_BLOCK)), () => new LostRule({ message: `SKILL.md lost its rule "${NO_BLOCK}" under "Between messages"` }))
  return [
    "# Orchestrator",
    "",
    "When the owner gives you a run, you are its root: you coordinate it through planner, implementor and verifier subagents and write no product code yourself. Load the `orchestrate` skill before you coordinate; it is the source of truth, and this section only repeats one of its rules. A plain question or a small edit needs no run: answer it or make it directly, without ceremony.",
    "",
    rule.slice(2).trim(),
  ].join("\n")
}

const loadSource = async (dir: string): Promise<Source> => {
  const script = join(dir, "scripts/agents.ts")
  if (!existsSync(script)) throw new Error(`no orchestrate skill at ${dir}: ${script} is missing`)
  return (await import(script)) as Source
}

/** The file this script writes, under `root`. */
export const build = async (root = ROOT, sourceDir = DEFAULT_SOURCE): Promise<Built> => {
  const source = await loadSource(sourceDir)
  const protocol = readFileSync(join(sourceDir, "protocol.md"), "utf8")
  const safety = readFileSync(join(sourceDir, "../loop/safety.md"), "utf8")
  const define = (description: string, system: string, effort?: string): Definition => ({
    description,
    mode: "subagent",
    permissions: PERMISSIONS,
    system: system.trim(),
    ...(effort ? { effort } : {}),
  })
  const agents: Record<string, Definition> = {}
  for (const role of Object.keys(source.ROLES)) {
    // The description and prompt as Claude Code has them, from the same functions.
    const claude = parseAgent(source.agentFile(role, protocol, safety))
    // The Effort column found by its header, so a host column added or moved keeps it.
    const lines = readFileSync(join(sourceDir, "SKILL.md"), "utf8").split("\n")
    const cells = (line?: string) => line?.split("|").map((c) => c.trim()) ?? []
    const column = cells(lines.find((line) => line.startsWith("| Role |"))).indexOf("Effort")
    const cell = column > 0 ? cells(lines.find((line) => line.startsWith(`| ${role} |`)))[column] : undefined
    const effort = /^(?:Opus )?(minimal|low|medium|high|xhigh|max)\b/.exec(cell ?? "")?.[1]
    if (!effort) throw new Error(`no Claude-family effort for ${role} in SKILL.md's role table`)
    agents[role] = define(claude.fields.description!, claude.body, effort)
  }
  const worker = parseAgent(readFileSync(join(source.AGENTS, `${WORKER}.md`), "utf8"))
  agents[WORKER] = define(worker.fields.description!, worker.body)
  // The orchestrator is no role: it takes build's fields where the plugin defines it, and only adds its section.
  const orchestrator = { description: ORCHESTRATOR_DESCRIPTION, section: orchestratorSection(readFileSync(join(sourceDir, "SKILL.md"), "utf8")) }
  return { path: join(root, OUT), text: `${JSON.stringify({ written: WRITTEN, agents, [ORCHESTRATOR]: orchestrator }, null, 2)}\n` }
}

/** Whether the file on disk differs from what the source makes. */
export const stale = (built: Built) => !existsSync(built.path) || readFileSync(built.path, "utf8") !== built.text

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const root = resolve(flag("--root") ?? ROOT)
  const built = await build(root, resolve(flag("--source") ?? DEFAULT_SOURCE))
  if (argv.includes("--check")) {
    if (stale(built)) {
      console.error(`stale: ${built.path}; run bun run agents`)
      process.exit(1)
    }
  } else {
    mkdirSync(dirname(built.path), { recursive: true })
    writeFileSync(built.path, built.text)
  }
}
