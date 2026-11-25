// An agy pane's quota message as a usage limit: its reset is the time it was
// seen plus the Go duration it prints, over generated durations (hours,
// minutes, seconds, milliseconds, fractions) and generated text that is no
// quota refusal.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { durationMs, isLimit, parseLimit, parsePaneLimits } from "./limit.ts"

const NOW = Date.parse("2026-11-25T00:37:00Z")

describe("Antigravity limit messages", () => {
  test("the pane's message and the API's form read as a usage limit with its reset", () => {
    const pane = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h8m38s."
    expect(parseLimit(pane, NOW)).toEqual(Option.some({ class: "usage_limit", seenAt: NOW, resetAt: Option.some(NOW + (3600 + 8 * 60 + 38) * 1000) }))
    const api = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4m42s."
    expect(Option.flatMap(parseLimit(api, NOW), (limit) => limit.resetAt)).toEqual(Option.some(NOW + 282_000))
    const stamped = "Error 429, Message: quota, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-25T02:00:00Z]"
    expect(Option.flatMap(parseLimit(stamped, NOW), (limit) => limit.resetAt)).toEqual(Option.some(Date.parse("2026-11-25T02:00:00Z")))
    expect(Option.flatMap(parseLimit("RESOURCE_EXHAUSTED (code 429): try later [retryDelay:30s]", NOW), (limit) => limit.resetAt)).toEqual(Option.some(NOW + 30_000))
  })

  test("a limit with no reset time is still a limit, its reset unknown", () => {
    expect(parseLimit("Individual quota reached. Please upgrade your subscription.", NOW)).toEqual(
      Option.some({ class: "usage_limit", seenAt: NOW, resetAt: Option.none() }),
    )
  })

  test("text that is no quota refusal is none", () => {
    for (const text of ["", "Resets in 4m", "Done. The tests pass.", "error: code 500", "quota", "the quota was fine (code 200)"]) expect(parseLimit(text, NOW)).toEqual(Option.none())
  })

  test("parsePaneLimits classifies Individual (gemini) and Third-party (claude-gpt), ignores expired frames, and keys by Error ID else frame text hash", () => {
    const scrollback = [
      "Working on task...",
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h8m38s.",
      "Error ID: err-gemini-001",
      "",
      "Later on another model:",
      "Third-party quota reached. Please upgrade your subscription to increase your limits. Resets in 45m.",
      "Error ID: err-3p-002",
      "",
      // An older frame whose absolute reset timestamp is already in the past -> MUST BE IGNORED
      "Error 429, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-24T23:00:00Z]",
      "Error ID: err-expired-003",
    ].join("\n")

    const parsed = parsePaneLimits(scrollback, NOW)
    expect(parsed.length).toBe(2)
    expect(parsed[0]).toEqual({
      class: "usage_limit",
      group: Option.some("gemini"),
      seenAt: NOW,
      resetAt: Option.some(NOW + (3600 + 8 * 60 + 38) * 1000),
      errorId: Option.some("err-gemini-001"),
      key: "id:err-gemini-001",
    })
    expect(parsed[1]).toEqual({
      class: "usage_limit",
      group: Option.some("claude-gpt"),
      seenAt: NOW,
      resetAt: Option.some(NOW + 45 * 60_000),
      errorId: Option.some("err-3p-002"),
      key: "id:err-3p-002",
    })

    // Frame with relative duration whose frameAt + dur <= now (older than its own reset) -> ignored
    const staleFrame = "Individual quota reached. Resets in 10m."
    expect(parsePaneLimits(staleFrame, NOW, NOW - 15 * 60_000)).toEqual([])

    // Frame without Error ID is keyed by a time-independent hash of its exact text (never by `now` or `seenAt`)
    const noIdText = "Third-party quota reached. Resets in 30m."
    const noIdFirst = parsePaneLimits(noIdText, NOW)
    const noIdLater = parsePaneLimits(noIdText, NOW + 10 * 60_000)
    expect(noIdFirst.length).toBe(1)
    expect(noIdLater.length).toBe(1)
    expect(noIdFirst[0]?.group).toEqual(Option.some("claude-gpt"))
    expect(noIdFirst[0]?.errorId).toEqual(Option.none())
    expect(noIdFirst[0]?.key).toBe(noIdLater[0]?.key)
    expect(noIdFirst[0]?.key).toStartWith("text:")

    // A reset-less frame without Error ID also has a time-independent key
    const noResetFirst = parsePaneLimits("Individual quota reached. Please upgrade your subscription.", NOW)
    const noResetLater = parsePaneLimits("Individual quota reached. Please upgrade your subscription.", NOW + 25 * 60_000)
    expect(noResetFirst[0]?.key).toBe(noResetLater[0]?.key)
    expect(noResetFirst[0]?.key).toStartWith("text:")
  })
})

/** A seeded generator: the same seed, the same sequence. */
const generator = (seed: number) => {
  let state = Math.max((seed * 2654435761) >>> 0, 1)
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

const UNITS = [
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
] as const

describe("Antigravity limit messages, generated", () => {
  test("a generated Go duration after \"Resets in\" resets at the time seen plus its length", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = generator(seed)
      let expected = 0
      const parts = UNITS.flatMap(([unit, ms]) => {
        if (random() < 0.4) return []
        const fractional = unit !== "ms" && random() < 0.3
        const amount = Math.round(random() * 5900) / 100 * Number(fractional) + Math.floor(random() * 60) * Number(!fractional)
        expected += amount * ms
        return [`${amount}${unit}`]
      })
      const duration = parts.join("") || "1s"
      if (parts.length === 0) expected = 1_000
      const prefix = ["", "RESOURCE_EXHAUSTED (code 429): "][Number(random() < 0.5)]
      const text = `${prefix}Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${duration}.`
      const reset = Option.flatMap(parseLimit(text, NOW), (limit) => limit.resetAt)
      if (expected === 0) expect(reset).toEqual(Option.none())
      else expect(Option.getOrThrow(reset)).toBeCloseTo(NOW + expected, 3)
      expect(Option.getOrElse(durationMs(duration), () => 0)).toBeCloseTo(expected, 3)
    }
  })

  test("generated text without a quota refusal is never a limit", () => {
    const words = ["Resets", "in", "4m42s", "quota", "code", "(code 500)", "done", "upgrade", "limits", "Individual", "reached", "RESOURCE", "EXHAUSTED_", "429"]
    for (let seed = 1; seed <= 500; seed++) {
      const random = generator(seed)
      const text = Array.from({ length: 1 + Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]).join(" ")
      expect(Option.isSome(parseLimit(text, NOW))).toBe(isLimit(text))
      if (!/Individual quota reached|RESOURCE_EXHAUSTED|\(code 429\)|quota (reached|exceeded|exhausted)/i.test(text)) expect(parseLimit(text, NOW)).toEqual(Option.none())
    }
  })
})
