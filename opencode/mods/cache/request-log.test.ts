import { describe, expect, test } from "bun:test"
import { segments } from "./fingerprint.ts"
import { judge, lineOf, type Previous, type Sent, type Tokens } from "./request-log.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const prompt = (date: string) => ({
  system: [{ type: "text", text: `You are Claude Code.\n\nToday is ${date}.\n\n${"rules ".repeat(500)}` }],
  messages: [{ role: "user", content: "Run the check." }],
})

const sent = (at: number, fields: Partial<Sent> = {}): Sent => ({
  at,
  kind: "primary",
  agent: "build",
  model: "anthropic/claude-x",
  ttlMs: HOUR,
  segments: segments(prompt("Friday")),
  ...fields,
})

const tokens = (prompt: number, read: number, write: number): Tokens => ({ prompt, read, write })

const previous = (fields: Partial<Sent> = {}): Previous => ({ sent: sent(0, fields), tokens: tokens(40_000, 30_000, 10_000) })

describe("judge", () => {
  test("the session's first request, and a hit", () => {
    expect(judge(undefined, sent(0), tokens(40_000, 0, 40_000), false)).toEqual({ cause: "first" })
    // The new end of the prompt is written; everything before it read.
    expect(judge(previous(), sent(MINUTE), tokens(45_000, 40_000, 5_000), false)).toEqual({ cause: "hit", gapMs: MINUTE })
  })

  test("after the lifetime: expired, whatever else changed", () => {
    expect(judge(previous({ ttlMs: 5 * MINUTE }), sent(6 * MINUTE, { login: "b" }), tokens(40_000, 0, 40_000), false)).toEqual({
      cause: "expired",
      gapMs: 6 * MINUTE,
      missed: 40_000,
    })
  })

  test("inside the lifetime with ~3k read: the changed segment and the tokens before it", () => {
    const judged = judge(previous(), sent(MINUTE, { segments: segments(prompt("Saturday")) }), tokens(40_000, 3_000, 37_000), false)
    expect(judged).toMatchObject({ cause: "prefix", missed: 37_000, change: { segment: "system[0] ¶2", head: "Today is Saturday." } })
  })

  test("the pool moved the login: named, with where it came from and what else changed", () => {
    expect(judge(previous({ login: "a" }), sent(MINUTE, { login: "b" }), tokens(40_000, 0, 40_000), false)).toEqual({
      cause: "login",
      gapMs: MINUTE,
      missed: 40_000,
      from: "a",
    })
  })

  test("a compaction's request, and the request after a compaction", () => {
    expect(judge(previous(), sent(MINUTE, { kind: "compaction" }), tokens(40_000, 0, 40_000), false).cause).toBe("compaction")
    expect(judge(previous(), sent(MINUTE), tokens(8_000, 0, 8_000), true).cause).toBe("compaction")
  })

  test("an unchanged prefix the cache did not read: unchanged, not a changed prefix", () => {
    expect(judge(previous(), sent(MINUTE), tokens(40_000, 0, 40_000), false)).toEqual({ cause: "unchanged", gapMs: MINUTE, missed: 40_000 })
  })

  test("another model, and a provider that reports no cache", () => {
    expect(judge(previous(), sent(MINUTE, { model: "anthropic/claude-y" }), tokens(40_000, 0, 40_000), false).cause).toBe("model")
    const silent: Previous = { sent: sent(0), tokens: tokens(40_000, 0, 0) }
    expect(judge(silent, sent(MINUTE), tokens(40_000, 0, 0), false).cause).toBe("uncached")
  })

  test("a miss at the noise floor is a hit", () => {
    expect(judge(previous(), sent(MINUTE), tokens(40_000, 38_976, 1_024), false).cause).toBe("hit")
  })
})

test("a line keeps the evidence and no prompt text but a system paragraph's first words", () => {
  const next = sent(MINUTE, { login: "cred-b", segments: segments(prompt("Saturday")) })
  const judgement = judge(previous({ login: "cred-b" }), next, tokens(40_000, 3_000, 37_000), false)
  const line = lineOf({ host: "workbox", sessionID: "ses_1", messageID: "msg_2", sent: next, tokens: tokens(40_000, 3_000, 37_000), judgement })
  expect(line).toEqual({
    at: MINUTE,
    host: "workbox",
    sessionID: "ses_1",
    messageID: "msg_2",
    kind: "primary",
    agent: "build",
    model: "anthropic/claude-x",
    login: "cred-b",
    ttlMs: HOUR,
    gapMs: MINUTE,
    prompt: 40_000,
    read: 3_000,
    write: 37_000,
    missed: 37_000,
    cause: "prefix",
    change: { segment: "system[0] ¶2", offsetTokens: expect.any(Number), head: "Today is Saturday." },
  })
  expect(JSON.stringify(line)).not.toContain("Run the check")
})
