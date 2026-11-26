// What the sidebar's Pool section draws: the session's account by its label,
// its hold, its weekly then 5-hour use with when each resets, and the colour
// each line takes; nothing when the pool names no account.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { SIDEBAR_COLUMNS, SidebarAnswer, sidebarLines, until, when } from "./sidebar.ts"

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
      { text: "week 41%/100% used · in 1d 23h", tone: "muted" },
      { text: "5h 12%/100% used · in 6h 40m · 21:40Z", tone: "muted" },
    ])
  })

  test("a model's own week follows the account's windows, by the model's name", () => {
    const answer = {
      account: {
        label: "claude-max-2",
        on: "placed" as const,
        reading: {
          windows: [
            { name: "7d", utilization: 0.41, resetAt: now + 47 * HOUR },
            { name: "7d:Fable", utilization: 1, resetAt: now + 47 * HOUR },
          ],
        },
      },
    }
    expect(sidebarLines(answer, now)).toEqual([
      { text: "claude-max-2", tone: "base" },
      { text: "week 41%/100% used · in 1d 23h", tone: "muted" },
      { text: "Fable week 100%/100% used · in 1d 23h", tone: "error" },
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
      { text: "week 80%/100% used", tone: "warning" },
      { text: "5h 100%/100% used · in 2h 0m · 17:00Z", tone: "error" },
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
      { text: "5h 0%/100% used", tone: "muted" },
    ])
  })

  test("each row fits the sidebar: the stamp shortens to its time, then goes, keeping X%/100% used and the relative time", () => {
    // Sunday 22:45Z: the 5h window resets after midnight, on Monday.
    const late = Date.parse("2026-11-15T22:45:00Z")
    const answer = {
      account: {
        label: "alpha",
        on: "placed" as const,
        hold: { kind: "usage-limit", until: late + 3 * 24 * HOUR },
        reading: {
          windows: [
            { name: "5h", utilization: 0.23, resetAt: late + HOUR + 29 * MINUTE },
            { name: "7d", utilization: 0.44, resetAt: late + 24 * HOUR },
            { name: "7d:Fable", utilization: 1, resetAt: late + 6 * 24 * HOUR + 23 * HOUR },
          ],
        },
      },
    }
    const lines = sidebarLines(answer, late).map((line) => line.text)
    expect(lines).toEqual([
      "alpha",
      "held · in 3d 0h · Wed 22:45Z",
      "week 44%/100% used · in 1d 0h",
      "5h 23%/100% used · in 1h 29m · 00:14Z",
      "Fable week 100%/100% used · in 6d 23h",
    ])
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(SIDEBAR_COLUMNS)
  })

  test("over a whole day of clocks, every window's row stays within the sidebar's columns", () => {
    const start = Date.parse("2026-11-15T00:00:00Z")
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const at = start + minute * MINUTE
      const answer = {
        account: {
          label: "alpha",
          on: "placed" as const,
          hold: { kind: "usage-limit", until: at + 5 * 24 * HOUR + 23 * HOUR + 59 * MINUTE },
          reading: {
            windows: [
              { name: "5h", utilization: 1, resetAt: at + 4 * HOUR + 59 * MINUTE },
              { name: "7d", utilization: 1, resetAt: at + 6 * 24 * HOUR + 23 * HOUR + 59 * MINUTE },
              { name: "7d:Fable", utilization: 1, resetAt: at + 6 * 24 * HOUR + 23 * HOUR + 59 * MINUTE },
            ],
          },
        },
      }
      for (const line of sidebarLines(answer, at)) {
        expect(line.text.length).toBeLessThanOrEqual(SIDEBAR_COLUMNS)
        if (line.text.includes("used")) expect(line.text).toMatch(/\d+%\/100% used · in \d+[dhm]/)
      }
    }
  })

  test("when both windows are absent it says no usage windows reported; weekly-only shows only week", () => {
    const none = {
      account: { label: "alpha", on: "placed" as const, reading: { windows: [], absent: [{ name: "5h" }, { name: "7d" }] } },
    }
    expect(sidebarLines(none, now)).toEqual([
      { text: "alpha", tone: "base" },
      { text: "no usage windows reported", tone: "muted" },
    ])
    const ultra = {
      account: { label: "ultra", on: "placed" as const, reading: { windows: [{ name: "7d", utilization: 0.2 }], absent: [{ name: "5h" }] } },
    }
    expect(sidebarLines(ultra, now)).toEqual([
      { text: "ultra", tone: "base" },
      { text: "week 20%/100% used", tone: "muted" },
    ])
  })

  test("nothing when the pool names no account", () => {
    expect(sidebarLines({}, now)).toEqual([])
  })

  test("reads the pool's answer, which carries more than it draws, and not a malformed one", () => {
    const decode = Schema.decodeUnknownOption(SidebarAnswer)
    const answer = {
      account: { pool: "anthropic", credentialID: "store:alpha", label: "alpha", on: "placed", reading: { at: now, windows: [] } },
    }
    expect(Option.isSome(decode(answer))).toBe(true)
    expect(Option.isSome(decode({}))).toBe(true)
    expect(Option.isNone(decode({ account: { label: 7 } }))).toBe(true)
  })
})
