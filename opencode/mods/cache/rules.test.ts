import { describe, expect, test } from "bun:test"
import { audit } from "./audit.ts"
import type { LedgerLine } from "./request-log.ts"
import { judgeRules, renderRules, type Facts } from "./rules.ts"

const T0 = Date.parse("2026-11-06T12:00:00Z")

const row = (at: number, fields: Partial<LedgerLine> = {}): LedgerLine => ({
  at,
  host: "mac",
  sessionID: "ses_a",
  kind: "primary",
  agent: "build",
  model: "anthropic/claude-opus",
  ttlMs: 3_600_000,
  prompt: 100_000,
  read: 99_000,
  write: 1_000,
  cause: "hit",
  ...fields,
})

const clean: Facts = {
  forkInstructionsFrozen: true,
  forkSkillsDelta: true,
  systemPushers: [{ file: "cmd/memory/server.ts", frozen: true }],
  billingStampFirst: false,
  kernelCatalogPerRequest: false,
  mcpServers: [],
  toolRemovers: [],
  mainModel: "anthropic/claude-opus",
  memoryDigestChars: 4_000,
  compactionKeepsPrefix: true,
  rolesOwnSystem: true,
  roleCacheTtl: "5m",
}

const quiet = audit([row(T0), row(T0 + 60_000)], { since: T0 })
const statuses = (facts: Facts, lines = quiet) => judgeRules(facts, lines).map((rule) => rule.status)

describe("the caching rules", () => {
  test("a clean setup with a quiet ledger passes every rule", () => {
    expect(statuses(clean)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "pass"])
  })

  test("a source risk warns and names its file", () => {
    const rules = judgeRules({ ...clean, kernelCatalogPerRequest: true, mcpServers: ["browse"], systemPushers: [{ file: "cmd/x/server.ts", frozen: false }] }, quiet)
    expect(rules[0]).toMatchObject({ status: "fail", findings: expect.arrayContaining([expect.objectContaining({ file: "cmd/x/server.ts" })]) })
    expect(rules[2]?.status).toBe("warn")
    expect(rules[2]?.findings[0]?.detail).toContain("MCP: browse")
  })

  test("a fact not found warns: check by hand", () => {
    const { forkSkillsDelta: _, ...rest } = clean
    expect(judgeRules(rest, quiet)[1]?.findings[0]).toMatchObject({ status: "warn", detail: "not found: check by hand" })
  })

  test("the window's breaks fail the rule they broke, with their tokens", () => {
    const broken = audit(
      [
        row(T0),
        row(T0 + 60_000, { read: 0, write: 100_000, cause: "prefix", change: { segment: "tool mcp_kernel", offsetTokens: 0 } }),
        row(T0 + 120_000, { model: "openai/gpt", read: 0, write: 0 }),
      ],
      { since: T0 },
    )
    const rules = judgeRules(clean, broken)
    expect(rules[2]?.status).toBe("fail")
    expect(rules[2]?.findings.at(-1)?.detail).toBe("1 breaks at a tool definition in the window wrote 100k again (measured): tool mcp_kernel ×1")
    expect(rules[3]?.status).toBe("fail")
  })

  test("a short lifetime warns once its expiries inside the hour cost more than the hour's dearer writes", () => {
    const role = { sessionID: "ses_r", agent: "implementor", ttlMs: 300_000 }
    const expiring = audit(
      [row(T0, { ...role, write: 1_000, read: 99_000 }), row(T0 + 600_000, { ...role, cause: "expired", read: 0, write: 100_000 })],
      { since: T0 },
    )
    expect(judgeRules(clean, expiring)[6]?.status).toBe("warn")
  })

  test("the report reads a mark, the rule and each finding's file", () => {
    expect(renderRules(judgeRules(clean, quiet)).split("\n")[0]).toBe("PASS  1. ordering: no dynamic data in the system prompt")
  })
})
