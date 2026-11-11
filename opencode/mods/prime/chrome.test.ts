import { describe, expect, test } from "bun:test"
import { dockShown, usageLabel } from "./chrome.ts"

const none = { subagents: 0, shells: 0, wakes: 0, monitors: 0, notices: 0 }

describe("the tray's usage", () => {
  test("adds the latest turn's cache share after the context share", () => {
    expect(usageLabel({ tokens: 207_000, percent: 52, cache: 95 })).toBe("207k (52%) · cache 95%")
  })

  test("leaves it out with no cache data yet", () => {
    expect(usageLabel({ tokens: 207_000, percent: 52 })).toBe("207k (52%)")
    expect(usageLabel({ tokens: 64_000, cache: 0 })).toBe("64k · cache 0%")
    expect(usageLabel(undefined)).toBeUndefined()
  })
})

describe("the dock's count line", () => {
  test("is not drawn with no subagent, shell, wake, monitor or unread notice", () => {
    expect(dockShown(none)).toBe(false)
  })

  test("shows as soon as any one of them is there", () => {
    expect(dockShown({ ...none, subagents: 1 })).toBe(true)
    expect(dockShown({ ...none, shells: 1 })).toBe(true)
    expect(dockShown({ ...none, wakes: 1 })).toBe(true)
    expect(dockShown({ ...none, monitors: 1 })).toBe(true)
    expect(dockShown({ ...none, notices: 1 })).toBe(true)
  })
})
