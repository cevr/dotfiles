import { describe, expect, test } from "bun:test"
import type { LedgerLine } from "./request-log.ts"
import { render, segmentKey, summarize } from "./summary.ts"

const at = (iso: string) => Date.parse(iso)

const line = (iso: string, write: number, cause: LedgerLine["cause"], fields: Partial<LedgerLine> = {}): LedgerLine => ({
  at: at(iso),
  host: "workbox",
  sessionID: "ses_1",
  kind: "primary",
  agent: "build",
  model: "anthropic/claude-x",
  ttlMs: 3_600_000,
  prompt: write,
  read: 0,
  write,
  cause,
  ...fields,
})

const LINES: ReadonlyArray<LedgerLine> = [
  line("2026-11-05T23:00:00Z", 99_000, "prefix"),
  line("2026-11-06T14:01:00Z", 40_000, "first"),
  line("2026-11-06T14:10:00Z", 37_000, "prefix", { change: { segment: "system[1] ¶4", offsetTokens: 3_000 } }),
  line("2026-11-06T14:20:00Z", 2_000, "hit"),
  line("2026-11-06T14:40:00Z", 39_000, "prefix", { change: { segment: "messages[12] user part 0 (text)", offsetTokens: 30_000 } }),
  line("2026-11-06T14:50:00Z", 39_000, "prefix", { change: { segment: "messages[30] user part 0 (text)", offsetTokens: 60_000 } }),
  line("2026-11-06T15:30:00Z", 41_000, "expired", { change: { segment: "system[1] ¶4", offsetTokens: 3_000 } }),
  line("2026-11-06T15:40:00Z", 40_000, "login", { sessionID: "ses_2", host: "mac", from: "a", login: "b" }),
]

describe("summarize", () => {
  const since = at("2026-11-06T00:00:00Z")
  const summary = summarize(LINES, since)

  test("cache writes in the window by cause, most first", () => {
    expect(summary.lines).toBe(7)
    expect(summary.write).toBe(238_000)
    expect(summary.byCause).toEqual([
      ["prefix", { write: 115_000, steps: 3 }],
      ["expired", { write: 41_000, steps: 1 }],
      ["first", { write: 40_000, steps: 1 }],
      ["login", { write: 40_000, steps: 1 }],
      ["hit", { write: 2_000, steps: 1 }],
    ])
  })

  test("the first changed segment, message indexes folded; an expiry's change is not counted", () => {
    expect(summary.bySegment).toEqual([
      ["messages[i] user part 0 (text)", { write: 78_000, steps: 2 }],
      ["system[1] ¶4", { write: 37_000, steps: 1 }],
    ])
    expect(segmentKey("system[1] ¶4")).toBe("system[1] ¶4")
  })

  test("per host and UTC day, with the unexplained part (login, prefix, unchanged)", () => {
    expect(summary.byHostDay).toEqual([
      { host: "mac", day: "2026-11-06", write: 40_000, unexplained: 40_000 },
      { host: "workbox", day: "2026-11-06", write: 198_000, unexplained: 115_000 },
    ])
  })

  test("per session-hour by cause, most written first", () => {
    expect(summary.sessionHours[0]).toEqual({
      host: "workbox",
      sessionID: "ses_1",
      hour: "2026-11-06T14",
      write: 157_000,
      byCause: { first: 40_000, prefix: 115_000, hit: 2_000 },
    })
    expect(summary.sessionHours.map((entry) => `${entry.sessionID} ${entry.hour}`)).toEqual(["ses_1 2026-11-06T14", "ses_1 2026-11-06T15", "ses_2 2026-11-06T15"])
  })

  test("a host narrows it", () => {
    expect(summarize(LINES, since, "mac").write).toBe(40_000)
  })

  test("rendered for the terminal", () => {
    const text = render(summary, 2)
    expect(text).toContain("cache writes: 238k tokens over 7 requests")
    expect(text).toContain("  workbox          2026-11-06    115k of 198k")
    expect(text).toContain("  workbox 2026-11-06T14  ses_1  157k  prefix 115k · first 40k · hit 2k")
    expect(render(summarize([], since), 2)).toBe("no ledger lines in the window")
  })
})
