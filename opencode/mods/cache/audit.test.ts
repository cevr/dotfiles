import { describe, expect, test } from "bun:test"
import { audit, classify, detect, renderAudit, usageOf } from "./audit.ts"
import type { LedgerLine } from "./request-log.ts"

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse("2026-11-06T12:00:00Z")

const row = (at: number, fields: Partial<LedgerLine> = {}): LedgerLine => ({
  at,
  host: "mac",
  sessionID: "ses_a",
  kind: "primary",
  agent: "build",
  model: "anthropic/claude-opus",
  login: "pool:one",
  ttlMs: HOUR,
  prompt: 100_000,
  read: 99_000,
  write: 1_000,
  cause: "hit",
  ...fields,
})

/** A request that read nothing of a 100k prompt and wrote it all again. */
const cold = (at: number, fields: Partial<LedgerLine> = {}) => row(at, { read: 0, write: 100_000, cause: "prefix", ...fields })

describe("a break is a sharp fall of the cache read against the session's request before", () => {
  test("a hit, a miss at the noise floor and a miss under a fifth of the shared prompt are no break", () => {
    const previous = row(T0)
    expect(detect(previous, row(T0 + MIN))).toBeUndefined()
    expect(detect(previous, row(T0 + MIN, { read: 99_000 - 1_024 }))).toBeUndefined()
    expect(detect(previous, row(T0 + MIN, { read: 81_000, write: 19_000 }))).toBeUndefined()
  })

  test("a miss of a fifth or more is a break: the missed part of the shared prompt, and what of it was written again", () => {
    const found = detect(row(T0), row(T0 + MIN, { prompt: 120_000, read: 30_000, write: 90_000, cause: "prefix", change: { segment: "messages[12] user part 0 (text)", offsetTokens: 30_000 } }))
    expect(found).toMatchObject({ missed: 70_000, wasted: 70_000, gapMs: MIN, ttlMs: HOUR, segment: "messages[i] user part 0 (text)", cause: "message-edit" })
  })

  test("a session that never reported cache activity has no breaks", () => {
    expect(detect(row(T0, { read: 0, write: 0 }), row(T0 + MIN, { read: 0, write: 0 }))).toBeUndefined()
  })

  test("a provider that writes nothing still breaks, with nothing wasted on writes", () => {
    expect(detect(row(T0), row(T0 + MIN, { read: 0, write: 0 }))).toMatchObject({ missed: 100_000, wasted: 0 })
  })
})

describe("a break's cause, by the line's evidence, first match wins", () => {
  const previous = row(T0)
  const at = T0 + MIN
  test.each([
    ["model-switch", cold(at, { model: "openai/gpt", kind: "compaction", login: "pool:two" })],
    ["compaction", cold(at, { kind: "compaction" })],
    ["compaction", cold(at, { cause: "compaction" })],
    ["ttl-expiry", cold(T0 + HOUR + 1, { login: "pool:two" })],
    ["login-move", cold(at, { login: "pool:two" })],
    ["restart", cold(at, { cause: "first" })],
    ["tool-set", cold(at, { change: { segment: "tool mcp_kernel", offsetTokens: 0 } })],
    ["system-prompt", cold(at, { change: { segment: "system[1] ¶4", offsetTokens: 3_000, head: "Today is" } })],
    ["message-edit", cold(at, { change: { segment: "messages[3] user part 0 (text)", offsetTokens: 9_000 } })],
    ["dropped", cold(at, { cause: "unchanged" })],
    ["dropped", cold(at, { change: { segment: "end of prompt", offsetTokens: 9_000 } })],
  ] as const)("%s", (cause, line) => {
    expect(classify(previous, line)).toBe(cause)
  })

  test("the request after a compaction's summary request is a compaction break", () => {
    expect(classify(row(T0, { kind: "compaction" }), cold(at))).toBe("compaction")
  })

  test("the lifetime is the previous request's: a 5-minute role expires after 5 minutes", () => {
    expect(classify(row(T0, { ttlMs: 5 * MIN }), cold(T0 + 6 * MIN))).toBe("ttl-expiry")
    expect(classify(row(T0, { ttlMs: 5 * MIN }), cold(T0 + 4 * MIN))).toBe("dropped")
  })
})

describe("usage", () => {
  test("hit rate is read over read, write and uncached input; the write's cost share prices a 1-hour write at 2× and a 5-minute one at 1.25×", () => {
    const usage = usageOf([row(T0, { prompt: 100, read: 80, write: 10 }), row(T0, { prompt: 100, read: 80, write: 10, ttlMs: 5 * MIN })])
    expect(usage).toMatchObject({ requests: 2, prompt: 200, read: 160, write: 20, uncached: 20, hitRate: 0.8, writeShare: 0.1 })
    // writes 10×2 + 10×1.25 = 32.5; reads 16; uncached 20.
    expect(usage.writeCostShare).toBeCloseTo(32.5 / 68.5, 10)
  })
})

describe("the audit over a window", () => {
  const lines: ReadonlyArray<LedgerLine> = [
    // ses_a began before the window: its first request in the window is no cold start.
    row(T0 - 2 * HOUR, { cause: "first", read: 0, write: 100_000 }),
    row(T0 + MIN),
    cold(T0 + 2 * MIN, { change: { segment: "tool mcp_kernel", offsetTokens: 0 } }),
    row(T0 + 3 * MIN),
    // ses_b: a role subagent on a 5-minute lifetime, expired after 10 minutes.
    row(T0 + MIN, { sessionID: "ses_b", agent: "implementor", ttlMs: 5 * MIN, cause: "first", read: 0, write: 40_000, prompt: 40_000 }),
    row(T0 + 11 * MIN, { sessionID: "ses_b", agent: "implementor", ttlMs: 5 * MIN, cause: "expired", read: 0, write: 40_000, prompt: 40_000 }),
    // ses_c starts in the window on a primary agent; another host's line.
    row(T0 + MIN, { sessionID: "ses_c", cause: "first", read: 0, write: 20_000, prompt: 20_000 }),
    row(T0 + MIN, { sessionID: "ses_d", host: "box", cause: "first", read: 0, write: 5_000, prompt: 5_000 }),
  ]

  test("breaks by cause, cold starts by kind, sessions ranked by wasted writes", () => {
    const result = audit(lines, { since: T0 })
    expect(result.overall.requests).toBe(7)
    expect(result.breaks).toMatchObject({ count: 2, wasted: 140_000 })
    expect(result.breaks.byCause.map((tally) => [tally.cause, tally.count, tally.wasted])).toEqual([
      ["tool-set", 1, 100_000],
      ["ttl-expiry", 1, 40_000],
    ])
    expect(result.breaks.byCause[0]?.segments).toEqual([{ segment: "tool mcp_kernel", count: 1, wasted: 100_000 }])
    expect(result.coldStarts.map((tally) => [tally.cause, tally.count, tally.wasted])).toEqual([
      ["subagent-first", 1, 40_000],
      ["session-start", 2, 25_000],
    ])
    expect(result.topSessions.map((session) => [session.sessionID, session.wasted, session.breaks])).toEqual([
      ["ses_a", 100_000, 1],
      ["ses_b", 40_000, 1],
    ])
    expect(result.topBreaks[0]).toMatchObject({ sessionID: "ses_a", cause: "tool-set" })
    expect(result.byHost.map(([host]) => host)).toEqual(["mac", "box"])
  })

  test("the trade of lifetimes under an hour: the writes' extra at 2× against the expiries an hour would have covered", () => {
    expect(audit(lines, { since: T0 }).shortLifetime).toEqual({
      requests: 2,
      write: 80_000,
      extraAtHour: 60_000,
      expiriesInsideHour: 1,
      savedAtHour: 46_000,
    })
  })

  test("a host, a top and the primary agents narrow it", () => {
    const result = audit(lines, { since: T0, host: "box", top: 0, primary: new Set(["plan"]) })
    expect(result.overall.requests).toBe(1)
    expect(result.coldStarts.map((tally) => tally.cause)).toEqual(["subagent-first"])
    expect(result.topBreaks).toEqual([])
  })

  test("it renders the north star first, and an empty window says so", () => {
    expect(renderAudit(audit(lines, { since: T0 })).split("\n")[1]).toContain("overall")
    expect(renderAudit(audit(lines, { since: T0 + 10 * HOUR }))).toBe("no ledger lines in the window")
  })
})
