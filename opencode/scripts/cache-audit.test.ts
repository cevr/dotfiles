import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_DIR, FILE_NAME } from "../mods/cache/filestore/request-log.ts"
import { parseArgs, probe } from "./cache-audit.ts"

const NOW = Date.parse("2026-11-06T12:00:00Z")
const DAY = 86_400_000

describe("cache-audit's command line", () => {
  test("by default: the last 7 days of this machine's ledger, build and plan as the primary agents, no static check", () => {
    expect(parseArgs([], NOW)).toEqual({
      since: NOW - 7 * DAY,
      top: 10,
      json: false,
      static: false,
      primary: new Set(["build", "plan"]),
      files: [join(DEFAULT_DIR, FILE_NAME)],
    })
  })

  test("flags", () => {
    expect(parseArgs(["--since", "24h", "--host", "box", "--top", "3", "--json", "--static", "--primary", "build,chat", "--file", "a.jsonl"], NOW)).toEqual({
      since: NOW - DAY,
      host: "box",
      top: 3,
      json: true,
      static: true,
      primary: new Set(["build", "chat"]),
      files: ["a.jsonl"],
    })
    expect(() => parseArgs(["--since", "last week"], NOW)).toThrow("--since last week: give 30m, 24h, 7d or an ISO time")
    expect(() => parseArgs(["--verbose"], NOW)).toThrow("unknown flag --verbose")
  })
})

describe("the static probes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "cache-audit-"))
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(scratch, path)), { recursive: true })
    writeFileSync(join(scratch, path), text)
  }
  put("opencode/cmd/memory/server.ts", "event.system.push({ type: 'text', text: digest })")
  put("opencode/mods/memory/model.ts", "// digest: chosen once per session")
  put("opencode/cmd/notes/server.ts", "event.system.push({ type: 'text', text: new Date().toString() })")
  put("opencode/cmd/rift/server.ts", "for (const id of WORKTREE_TOOLS) editor.remove(id)")
  put("opencode/cmd/flip/server.ts", "if (on) editor.remove(name)")
  put("opencode/cmd/kernel/server.ts", "runtime: { describe: (tools) => description(options, tools) }")
  put("opencode/mods/memory/digest.ts", "export const LIMITS: Limits = { notes: 30, chars: 4_000 }")
  put("opencode/cmd/orchestrate/server.ts", 'ctx.session.hook("compaction", (event) =>\n  Effect.sync(() => {\n    event.messages.push(keepMessage())\n  item.system = definition.system')
  put("opencode/mods/orchestrate/role.ts", 'export const ROLE_CACHE_TTL = "5m"')
  put("fork/packages/core/src/instructions/builtins.ts", "changed: (_previous, date) => `Today's date is now: ${date}`")
  put("fork/packages/core/src/session/instruction-state.ts", "state.initial_values")
  put("config.json", JSON.stringify({ model: "anthropic/opus#medium", agents: { compaction: { model: "anthropic/haiku" } }, mcp: { servers: { browse: {} } } }))

  test("read what each rule needs, and only model and MCP server names from the config", () => {
    expect(probe(join(scratch, "opencode"), join(scratch, "fork"), join(scratch, "config.json"))).toEqual({
      forkInstructionsFrozen: true,
      systemPushers: [
        { file: "cmd/memory/server.ts", frozen: true },
        { file: "cmd/notes/server.ts", frozen: false },
      ],
      kernelCatalogPerRequest: true,
      mcpServers: ["browse"],
      toolRemovers: ["cmd/flip/server.ts"],
      compactionModel: "anthropic/haiku",
      mainModel: "anthropic/opus",
      memoryDigestChars: 4_000,
      compactionKeepsPrefix: true,
      rolesOwnSystem: true,
      roleCacheTtl: "5m",
    })
  })

  test("nothing found reads as unknown, not as a pass", () => {
    expect(probe(join(scratch, "none"), join(scratch, "none"), join(scratch, "none.json"))).toEqual({ systemPushers: [], mcpServers: [], toolRemovers: [] })
  })
})
