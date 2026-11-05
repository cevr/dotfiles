import { describe, expect, test } from "bun:test"
import { notice } from "./laws.ts"
import { clockOf, trayLine } from "./tray.ts"
import type { Shown } from "./wake.ts"

const NOW = new Date(2026, 10, 5, 13, 0).getTime()
const shown = (kind: Shown["kind"], dueAt: number, id = "w000001"): Shown => ({ id, kind, sessionID: "ses_a", mode: "wake", note: "n", dueAt })

describe("the tray line", () => {
  test("nothing pending, nothing shown", () => {
    expect(trayLine({ now: NOW, entries: [], notices: [] }, 80)).toBeUndefined()
  })

  test("counts wakes and monitors, the soonest alarm next, and unread notices", () => {
    const pending = {
      now: NOW,
      entries: [shown("alarm", new Date(2026, 10, 5, 16, 0).getTime()), shown("alarm", new Date(2026, 10, 5, 14, 30).getTime(), "w2"), shown("monitor", NOW + 60_000, "w3")],
      notices: [notice],
    }
    expect(trayLine(pending, 80)).toBe("2 wakes · 1 monitor · next 14:30 · 1 notice")
  })

  test("only monitors: the soonest deadline as until", () => {
    expect(trayLine({ now: NOW, entries: [shown("monitor", new Date(2026, 10, 5, 13, 30).getTime())], notices: [] }, 80)).toBe("1 monitor · until 13:30")
  })

  test("parts drop from the right as the width shrinks, keeping the first", () => {
    const pending = { now: NOW, entries: [shown("alarm", new Date(2026, 10, 5, 14, 30).getTime())], notices: [notice] }
    expect(trayLine(pending, 21)).toBe("1 wake · next 14:30")
    expect(trayLine(pending, 3)).toBe("1 wake")
  })

  test("times: the clock today, the weekday this week, the date past it", () => {
    expect(clockOf(new Date(2026, 10, 5, 9, 5).getTime(), NOW)).toBe("09:05")
    expect(clockOf(new Date(2026, 10, 7, 9, 5).getTime(), NOW)).toBe("Sat 09:05")
    expect(clockOf(new Date(2026, 11, 25, 9, 5).getTime(), NOW)).toBe("Dec 25 09:05")
  })
})
