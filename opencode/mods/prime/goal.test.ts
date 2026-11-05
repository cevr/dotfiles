import { describe, expect, test } from "bun:test"
import { GOAL_LINGER_MS, goalLine, goalShown, goalTone, type Goal } from "./goal.ts"

const goal = (over: Partial<Goal> = {}): Goal => ({
  objective: "ship the dock",
  status: "active",
  rounds: 0,
  updatedAt: 1_000,
  ...over,
})
const text = (line: ReturnType<typeof goalLine>) => `${line.lead}${line.body}${line.rest}`

describe("the goal line", () => {
  test("active: the objective, the rounds sent, and how to pause or cancel, in the success colour", () => {
    const line = goalLine(goal({ rounds: 3 }), 120)
    expect(text(line)).toBe("● goal · ship the dock · 3↻ · /goal pause · /goal cancel")
    expect(line.tone).toBe("success")
  })

  test("active before any continuation: no round count", () => {
    expect(text(goalLine(goal(), 120))).toBe("● goal · ship the dock · /goal pause · /goal cancel")
  })

  test("paused: the reason and how to resume or cancel, in the warning colour", () => {
    const line = goalLine(goal({ status: "paused", reason: "paused by user", rounds: 2 }), 120)
    expect(text(line)).toBe("‖ goal paused · paused by user · /goal resume · /goal cancel")
    expect(line.tone).toBe("warning")
  })

  test("paused with no reason: just the commands", () => {
    expect(text(goalLine(goal({ status: "paused" }), 120))).toBe("‖ goal paused · /goal resume · /goal cancel")
  })

  test("met: muted, the objective only", () => {
    const line = goalLine(goal({ status: "complete", rounds: 4 }), 120)
    expect(text(line)).toBe("✓ goal met · ship the dock")
    expect(line.tone).toBe("muted")
  })

  test("a long objective is one line, truncated before anything drops", () => {
    const long = goal({ objective: "make the dock\nshow every wake and the goal state in colour", rounds: 3 })
    const line = goalLine(long, 60)
    expect(text(line)).toBe("● goal · make the dock sh… · 3↻ · /goal pause · /goal cancel")
    expect([...text(line)].length).toBe(60)
  })

  test("narrower: the hints drop, then the round count, then the objective truncates further", () => {
    const long = goal({ objective: "make the dock show every wake and the goal state in colour", rounds: 3 })
    expect(goalLine(long, 40).rest).toBe(" · 3↻")
    expect(text(goalLine(long, 40))).toBe("● goal · make the dock show every… · 3↻")
    expect(goalLine(long, 24).rest).toBe("")
    expect(text(goalLine(long, 24))).toBe("● goal · make the dock…")
    expect(text(goalLine(long, 12))).toBe("● goal · ma…")
  })
})

describe("when the goal shows", () => {
  test("no goal, nothing", () => {
    expect(goalShown(undefined, 0)).toBe(false)
  })

  test("active and paused always; met only for a moment", () => {
    expect(goalShown(goal(), 1e12)).toBe(true)
    expect(goalShown(goal({ status: "paused" }), 1e12)).toBe(true)
    const met = goal({ status: "complete", updatedAt: 1_000 })
    expect(goalShown(met, 1_000 + GOAL_LINGER_MS - 1)).toBe(true)
    expect(goalShown(met, 1_000 + GOAL_LINGER_MS)).toBe(false)
  })

  test("the tone follows the state", () => {
    expect(goalTone(goal())).toBe("success")
    expect(goalTone(goal({ status: "paused" }))).toBe("warning")
    expect(goalTone(goal({ status: "complete" }))).toBe("muted")
  })
})
