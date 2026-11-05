import { describe, expect, test } from "bun:test"
import { clockOf, wakeItem, type Wakes } from "./wakes.ts"

const NOW = new Date(2026, 10, 5, 13, 0).getTime()
const at = (hours: number, minutes: number) => new Date(2026, 10, 5, hours, minutes).getTime()
const wakes = (entries: Wakes["entries"], notices = 0): Wakes => ({ now: NOW, entries, notices })

describe("the dock's wake item", () => {
  test("nothing pending or unread, nothing shown", () => {
    expect(wakeItem(wakes([]), 80)).toBeUndefined()
  })

  test("counts wakes and monitors, the soonest alarm next, and unread notices, in the success colour", () => {
    const pending = wakes(
      [
        { kind: "alarm", dueAt: at(16, 0) },
        { kind: "alarm", dueAt: at(14, 30) },
        { kind: "monitor", dueAt: NOW + 60_000 },
      ],
      1,
    )
    expect(wakeItem(pending, 80)).toEqual({ text: "⏰ 2 wakes · 1 monitor · next 14:30 · 1 notice", tone: "success" })
  })

  test("only monitors: the soonest deadline as until", () => {
    expect(wakeItem(wakes([{ kind: "monitor", dueAt: at(13, 30) }]), 80)?.text).toBe("⏰ 1 monitor · until 13:30")
  })

  test("only notices unread: the warning colour", () => {
    expect(wakeItem(wakes([], 1), 80)).toEqual({ text: "⏰ 1 notice", tone: "warning" })
  })

  test("parts drop from the right as the width shrinks, keeping the first; the glyph takes three cells", () => {
    const pending = wakes([{ kind: "alarm", dueAt: at(14, 30) }], 1)
    expect(wakeItem(pending, 33)?.text).toBe("⏰ 1 wake · next 14:30 · 1 notice")
    expect(wakeItem(pending, 32)?.text).toBe("⏰ 1 wake · next 14:30")
    expect(wakeItem(pending, 22)?.text).toBe("⏰ 1 wake · next 14:30")
    expect(wakeItem(pending, 21)?.text).toBe("⏰ 1 wake")
    expect(wakeItem(pending, 3)?.text).toBe("⏰ 1 wake")
  })

  test("times: the clock today, the weekday this week, the date past it", () => {
    expect(clockOf(at(9, 5), NOW)).toBe("09:05")
    expect(clockOf(new Date(2026, 10, 7, 9, 5).getTime(), NOW)).toBe("Sat 09:05")
    expect(clockOf(new Date(2026, 11, 25, 9, 5).getTime(), NOW)).toBe("Dec 25 09:05")
  })
})
