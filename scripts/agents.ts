#!/usr/bin/env bun
// Writes the orchestrate roles (planner, implementor, verifier) and the lean
// worker as OpenCode agents, from the same source as Claude Code's: the
// orchestrate skill's protocol.md and loop/safety.md, through its own
// scripts/agents.ts, so the prompt text is the Claude Code agents' word for
// word. The worker's prompt and description come from its hand-written
// Claude Code agent file.
//
// Out: plugins/orchestrate/src/agents.json, each role as the fields of an
// OpenCode agent (`Agent.Info`: description, mode, permissions, system) plus
// its Claude-family reasoning effort (the skill's role table). The
// orchestrate plugin defines the agents from it through `agent.transform`,
// as OpenCode's own plugins define build, plan and general, so an agent file
// in the owner's config still overrides a role, and the plugin can give each
// role its compaction window (config agent files cannot set it).
//
// Usage: bun scripts/agents.ts [--check] [--root <dir>] [--source <orchestrate skill dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** What this script uses from the orchestrate skill's scripts/agents.ts. */
interface Source {
  readonly ROLES: Readonly<Record<string, string>>
  readonly AGENTS: string
  readonly instructions: (role: string, protocol: string, safety: string) => string
  readonly agentFile: (role: string, protocol: string, safety: string) => string
}

export const ROOT = resolve(import.meta.dir, "..")
export const DEFAULT_SOURCE = join(homedir(), ".claude/skills/orchestrate")
export const WORKER = "worker"
const WRITTEN = "Written by opencode-gent scripts/agents.ts from the orchestrate skill. Edit the skill, then run `bun run agents`."

/**
 * The tools Claude Code gives these agents (Bash, Read, Edit, Write, Skill,
 * Monitor, TaskStop, WebFetch, WebSearch) as OpenCode permissions. Everything
 * else is denied, as the built-in explore agent does: no subagent, question,
 * todo, glob/grep tool or MCP tool. Edit and Write are the `edit` permission
 * (edit, write and patch); Monitor and TaskStop are background `shell` work.
 * Reading a .env file still asks, as for every built-in agent.
 */
export const PERMISSIONS = [
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
  { action: "external_directory", resource: "*", effect: "allow" },
] as const

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

export const OUT = "plugins/orchestrate/src/agents.json"

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
    const table = readFileSync(join(sourceDir, "SKILL.md"), "utf8")
    const row = table.split("\n").find((line) => line.startsWith(`| ${role} |`))
    const cell = row?.split("|")[4]?.trim()
    const effort = /^(?:Opus )?(minimal|low|medium|high|xhigh|max)\b/.exec(cell ?? "")?.[1]
    if (!effort) throw new Error(`no Claude-family effort for ${role} in SKILL.md's role table`)
    agents[role] = define(claude.fields.description!, claude.body, effort)
  }
  const worker = parseAgent(readFileSync(join(source.AGENTS, `${WORKER}.md`), "utf8"))
  agents[WORKER] = define(worker.fields.description!, worker.body)
  return { path: join(root, OUT), text: `${JSON.stringify({ written: WRITTEN, agents }, null, 2)}\n` }
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
