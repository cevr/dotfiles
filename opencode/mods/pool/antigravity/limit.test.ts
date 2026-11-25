// An agy pane's quota message as a usage limit: its reset is the time it was
// seen plus the Go duration it prints, over generated durations (hours,
// minutes, seconds, milliseconds, fractions) and generated text that is no
// quota refusal.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { durationMs, isLimit, parseLimit } from "./limit.ts"

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
        const amount = fractional ? Math.round(random() * 5900) / 100 : Math.floor(random() * 60)
        expected += amount * ms
        return [`${amount}${unit}`]
      })
      const duration = parts.length === 0 ? "1s" : parts.join("")
      if (parts.length === 0) expected = 1_000
      const prefix = random() < 0.5 ? "RESOURCE_EXHAUSTED (code 429): " : ""
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
