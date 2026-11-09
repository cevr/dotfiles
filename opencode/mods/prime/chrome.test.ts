import { describe, expect, test } from "bun:test"
import { dockShown } from "./chrome.ts"

const none = { subagents: 0, shells: 0, wakes: 0, monitors: 0, notices: 0 }

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
