// What the sidebar's Pool section draws: the session's account by its label,
// its hold, its weekly then 5-hour use with when each resets, and the colour
// each line takes; nothing when the pool names no account.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { SidebarAnswer, sidebarLines, until, when } from "./sidebar.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// A Wednesday.
const now = Date.parse("2026-11-04T15:00:00Z")

describe("until", () => {
  test("the two largest units, or now", () => {
    expect(until(now + 30_000, now)).toBe("now")
    expect(until(now + 12 * MINUTE, now)).toBe("in 12m")
    expect(until(now + 2 * HOUR + 5 * MINUTE, now)).toBe("in 2h 5m")
    expect(until(now + 28 * HOUR, now)).toBe("in 1d 4h")
  })
})

describe("when", () => {
  test("relative, then the stamp's time: alone today, with its weekday this week, with its date after", () => {
    expect(when(now + HOUR, now)).toBe("in 1h 0m · 16:00Z")
    expect(when(now + 47 * HOUR, now)).toBe("in 1d 23h · Fri 14:00Z")
    expect(when(now + 8 * 24 * HOUR, now)).toBe("in 8d 0h · 11-12 15:00Z")
  })
})

describe("sidebarLines", () => {
  test("the account's label, then week and 5h with their resets, muted below 80%", () => {
    const answer = {
      account: {
        label: "claude-max-2",
        on: "placed" as const,
        reading: {
          windows: [
            { name: "5h", utilization: 0.12, resetAt: now + 6 * HOUR + 40 * MINUTE },
            { name: "7d", utilization: 0.41, resetAt: now + 47 * HOUR },
          ],
        },
      },
    }
    expect(sidebarLines(answer, now)).toEqual([
      { text: "claude-max-2", tone: "base" },
      { text: "week 41% · in 1d 23h · Fri 14:00Z", tone: "muted" },
      { text: "5h 12% · in 6h 40m · 21:40Z", tone: "muted" },
    ])
  })

  test("a window at 80% is a warning, at 95% an error; a held account says until when", () => {
    const answer = {
      account: {
        label: "beta",
        on: "placed" as const,
        hold: { kind: "usage-limit", until: now + 2 * HOUR },
        reading: {
          windows: [
            { name: "5h", utilization: 1, resetAt: now + 2 * HOUR },
            { name: "7d", utilization: 0.8 },
          ],
        },
      },
    }
    expect(sidebarLines(answer, now)).toEqual([
      { text: "beta", tone: "warning" },
      { text: "held · in 2h 0m · 17:00Z", tone: "warning" },
      { text: "week 80%", tone: "warning" },
      { text: "5h 100% · in 2h 0m · 17:00Z", tone: "error" },
    ])
  })

  test("before the session's first request it is the pool's next pick; without a reading it says so", () => {
    expect(sidebarLines({ account: { label: "alpha", on: "next" } }, now)).toEqual([
      { text: "alpha · next", tone: "base" },
      { text: "no reading yet", tone: "muted" },
    ])
  })

  test("a window that has reset since the answer reads empty, and a past hold is gone", () => {
    const answer = {
      account: {
        label: "alpha",
        on: "placed" as const,
        hold: { kind: "rate-limit", until: now - 1 },
        reading: { windows: [{ name: "5h", utilization: 0.97, resetAt: now - 1 }] },
      },
    }
    expect(sidebarLines(answer, now)).toEqual([
      { text: "alpha", tone: "base" },
      { text: "5h 0%", tone: "muted" },
    ])
  })

  test("nothing when the pool names no account", () => {
    expect(sidebarLines({}, now)).toEqual([])
  })

  test("reads the pool's answer, which carries more than it draws, and not a malformed one", () => {
    const decode = Schema.decodeUnknownOption(SidebarAnswer)
    const answer = {
      account: { pool: "anthropic", credentialID: "gent:alpha", label: "alpha", on: "placed", reading: { at: now, windows: [] } },
    }
    expect(Option.isSome(decode(answer))).toBe(true)
    expect(Option.isSome(decode({}))).toBe(true)
    expect(Option.isNone(decode({ account: { label: 7 } }))).toBe(true)
  })
})
