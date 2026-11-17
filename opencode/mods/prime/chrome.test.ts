import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { dockShown, queueItem, usageLabel } from "./chrome.ts"

const none = { subagents: 0, shells: 0, jobs: 0, wakes: 0, monitors: 0, notices: 0, queued: 0 }

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
  test("is not drawn with no subagent, shell, running job, wake, monitor, unread notice or queued item", () => {
    expect(dockShown(none)).toBe(false)
  })

  test("shows as soon as any one of them is there", () => {
    expect(dockShown({ ...none, subagents: 1 })).toBe(true)
    expect(dockShown({ ...none, shells: 1 })).toBe(true)
    expect(dockShown({ ...none, jobs: 1 })).toBe(true)
    expect(dockShown({ ...none, wakes: 1 })).toBe(true)
    expect(dockShown({ ...none, monitors: 1 })).toBe(true)
    expect(dockShown({ ...none, notices: 1 })).toBe(true)
    expect(dockShown({ ...none, queued: 1 })).toBe(true)
  })
})

describe("the dock's queue item", () => {
  test("counts what is queued, and apart what needs the owner; nothing with nothing queued", () => {
    expect(queueItem({ open: 0, needsYou: 0 })).toEqual(Option.none())
    expect(queueItem({ open: 5, needsYou: 0 })).toEqual(Option.some({ text: "5 queued", needs: Option.none() }))
    expect(queueItem({ open: 5, needsYou: 1 })).toEqual(Option.some({ text: "5 queued", needs: Option.some("1 needs you") }))
    expect(queueItem({ open: 5, needsYou: 2 })).toEqual(Option.some({ text: "5 queued", needs: Option.some("2 need you") }))
  })
})
