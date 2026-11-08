// Audit prompt-cache efficiency from the cache mod's ledger: the hit rate
// (read / (read + write + uncached)) overall and per host, agent and model,
// the cache writes' share of the cost, and the breaks (a session's read
// falling sharply against its request before) by cause, with the sessions
// that wrote the most again. `--static` adds our setup held against the six
// caching rules (mods/cache/rules.ts), each finding naming its file.
//
//   bun scripts/cache-audit.ts [--since 7d] [--host <name>] [--top 10] [--json] [--static]
//                              [--primary build,plan] [--file <ledger.jsonl>]...
//
// The dream runs it on each machine; the north star is the overall hit rate
// and the wasted write tokens.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { audit, PRIMARY_AGENTS, renderAudit } from "../mods/cache/audit.ts"
import { DEFAULT_DIR, FILE_NAME, parse } from "../mods/cache/filestore/request-log.ts"
import { judgeRules, renderRules, type Facts } from "../mods/cache/rules.ts"
import { parseTtl } from "../mods/cache/ttl.ts"

export interface Args {
  readonly since: number
  readonly host?: string
  readonly top: number
  readonly json: boolean
  readonly static: boolean
  readonly primary: ReadonlySet<string>
  readonly files: ReadonlyArray<string>
}

/** The command line, read; `now` anchors a relative `--since`. Throws on a malformed flag. */
export const parseArgs = (argv: ReadonlyArray<string>, now: number): Args => {
  let since = now - 7 * 86_400_000
  let host: string | undefined
  let top = 10
  let json = false
  let statics = false
  let primary: ReadonlySet<string> = PRIMARY_AGENTS
  const files: Array<string> = []
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === "--since") {
      const raw = value()
      const relative = parseTtl(raw)
      const absolute = Date.parse(raw)
      if (relative !== undefined) since = now - relative
      else if (!Number.isNaN(absolute)) since = absolute
      else throw new Error(`--since ${raw}: give 30m, 24h, 7d or an ISO time`)
    } else if (flag === "--host") host = value()
    else if (flag === "--top") {
      top = Number(value())
      if (!Number.isInteger(top) || top < 0) throw new Error("--top takes a whole number")
    } else if (flag === "--json") json = true
    else if (flag === "--static") statics = true
    else if (flag === "--primary") primary = new Set(value().split(",").filter((name) => name !== ""))
    else if (flag === "--file") files.push(value())
    else throw new Error(`unknown flag ${flag}`)
  }
  return { since, ...(host === undefined ? {} : { host }), top, json, static: statics, primary, files: files.length > 0 ? files : [join(DEFAULT_DIR, FILE_NAME)] }
}

const read = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The facts the rules read, from the dotfiles' `opencode/` at `root`, the
 * fork at `fork` and the config at `config`. Only the config's model names
 * and MCP server names are read; nothing else of it is kept or printed.
 */
export const probe = (root: string, fork: string, config: string): Facts => {
  const builtins = read(join(fork, "packages/core/src/instructions/builtins.ts"))
  const state = read(join(fork, "packages/core/src/session/instruction-state.ts"))
  const skills = read(join(fork, "packages/core/src/skill/instructions.ts"))
  const servers = existsSync(join(root, "cmd"))
    ? readdirSync(join(root, "cmd")).flatMap((name) => {
        const text = read(join(root, "cmd", name, "server.ts"))
        return text === undefined ? [] : [{ name, file: `cmd/${name}/server.ts`, text }]
      })
    : []
  const modText = (name: string) => {
    const dir = join(root, "mods", name)
    return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => read(join(dir, file)) ?? "").join("\n") : ""
  }
  const billing = read(join(root, "mods/anthropic-auth/request-body.ts"))
  const kernel = read(join(root, "cmd/kernel/server.ts"))
  const digest = read(join(root, "mods/memory/digest.ts"))
  const orchestrate = read(join(root, "cmd/orchestrate/server.ts"))
  const role = read(join(root, "mods/orchestrate/role.ts"))
  let parsed: unknown
  try {
    parsed = JSON.parse(read(config) ?? "null")
  } catch {
    parsed = undefined
  }
  const settings = isRecord(parsed) ? parsed : {}
  const mcp = isRecord(settings["mcp"]) ? settings["mcp"] : {}
  const mcpServers = Object.keys(isRecord(mcp["servers"]) ? mcp["servers"] : mcp)
  const agents = isRecord(settings["agents"]) ? settings["agents"] : isRecord(settings["agent"]) ? settings["agent"] : {}
  const compaction = isRecord(agents["compaction"]) ? agents["compaction"]["model"] : undefined
  const model = (value: unknown) => (typeof value === "string" ? value.replace(/#.*$/, "") : undefined)
  const compactionModel = model(compaction)
  const mainModel = model(settings["model"])
  const chars = digest === undefined ? undefined : /chars:\s*([\d_]+)/.exec(digest)?.[1]
  const ttl = role === undefined ? undefined : /ROLE_CACHE_TTL\s*=\s*"([^"]+)"/.exec(role)?.[1]
  return {
    ...(builtins === undefined ? {} : { forkInstructionsFrozen: builtins.includes("Today's date is now") && (state ?? "").includes("initial_values") }),
    ...(skills === undefined ? {} : { forkSkillsDelta: skills.includes("The available skills have changed") }),
    systemPushers: servers
      .filter((server) => /event\.system\.push\(/.test(server.text))
      .map((server) => ({ file: server.file, frozen: /once per session/i.test(modText(server.name)) })),
    ...(billing === undefined ? {} : { billingStampFirst: billing.includes("buildBillingHeaderValue") && billing.includes("system.unshift") }),
    ...(kernel === undefined ? {} : { kernelCatalogPerRequest: /describe:\s*\(tools\)\s*=>\s*description\(/.test(kernel) }),
    mcpServers,
    // A loop over a constant list (`for (const id of WORKTREE_TOOLS) editor.remove(id)`) removes the same tools at every start.
    toolRemovers: servers
      .filter((server) => (server.text.match(/editor\.remove\(/g) ?? []).length > (server.text.match(/for \(const \w+ of [A-Z_]+\) editor\.remove\(/g) ?? []).length)
      .map((server) => server.file),
    ...(compactionModel === undefined ? {} : { compactionModel }),
    ...(mainModel === undefined ? {} : { mainModel }),
    ...(chars === undefined ? {} : { memoryDigestChars: Number(chars.replaceAll("_", "")) }),
    ...(orchestrate === undefined ? {} : { compactionKeepsPrefix: /hook\("compaction"[\s\S]{0,200}event\.messages\.push\(/.test(orchestrate), rolesOwnSystem: orchestrate.includes("item.system = definition.system") }),
    ...(ttl === undefined ? {} : { roleCacheTtl: ttl }),
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2), Date.now())
    const lines = args.files.flatMap((file) => (existsSync(file) ? parse(readFileSync(file, "utf8")) : []))
    const result = audit(lines, { since: args.since, ...(args.host === undefined ? {} : { host: args.host }), top: args.top, primary: args.primary })
    const rules = args.static
      ? judgeRules(
          probe(resolve(import.meta.dir, ".."), process.env["OPENCODE_DEV"] ?? join(homedir(), "Developer/personal/opencode"), join(homedir(), ".config/opencode/opencode.json")),
          result,
        )
      : undefined
    if (args.json) console.log(JSON.stringify(rules === undefined ? { audit: result } : { audit: result, rules }, null, 2))
    else console.log(rules === undefined ? renderAudit(result) : `${renderAudit(result)}\n\nrules:\n${renderRules(rules)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
