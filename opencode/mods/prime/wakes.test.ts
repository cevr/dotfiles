import { describe, expect, test } from "bun:test"
import { wakeItem, type Wakes } from "./wakes.ts"

const NOW = new Date(2026, 10, 5, 13, 0).getTime()
const wakes = (entries: Wakes["entries"], notices = 0): Wakes => ({ now: NOW, entries, notices })

describe("the dock's wake item", () => {
  test("nothing pending or unread, nothing shown", () => {
    expect(wakeItem(wakes([]), 80)).toBeUndefined()
  })

  test("counts wakes, monitors and unread notices, plain, in the success colour", () => {
    const pending = wakes(
      [
        { kind: "alarm", dueAt: NOW + 3_600_000 },
        { kind: "alarm", dueAt: NOW + 5_400_000 },
        { kind: "monitor", dueAt: NOW + 60_000 },
      ],
      1,
    )
    expect(wakeItem(pending, 80)).toEqual({ text: "2 wakes · 1 monitor · 1 notice", tone: "success" })
  })

  test("only monitors", () => {
    expect(wakeItem(wakes([{ kind: "monitor", dueAt: NOW + 60_000 }]), 80)?.text).toBe("1 monitor")
  })

  test("only notices unread: the warning colour", () => {
    expect(wakeItem(wakes([], 1), 80)).toEqual({ text: "1 notice", tone: "warning" })
  })

  test("parts drop from the right as the width shrinks, keeping the first", () => {
    const pending = wakes([{ kind: "alarm", dueAt: NOW + 60_000 }, { kind: "monitor", dueAt: NOW + 60_000 }], 1)
    expect(wakeItem(pending, 29)?.text).toBe("1 wake · 1 monitor · 1 notice")
    expect(wakeItem(pending, 28)?.text).toBe("1 wake · 1 monitor")
    expect(wakeItem(pending, 18)?.text).toBe("1 wake · 1 monitor")
    expect(wakeItem(pending, 17)?.text).toBe("1 wake")
    expect(wakeItem(pending, 1)?.text).toBe("1 wake")
  })
})
