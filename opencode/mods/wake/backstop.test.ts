import { describe, expect, test } from "bun:test"
import { alarm, monitor } from "./laws.ts"
import { carried, idOfTitle, minuteOf, oneShot, scheduleOf, titleOf } from "./backstop.ts"

// Local times: the cron fields are local, so the cases are too.
const at = (month: number, day: number, hour: number, minute: number, second = 0) => new Date(2026, month - 1, day, hour, minute, second).getTime()

describe("titles", () => {
  test("a wake's title names its id; any other title names none", () => {
    expect(titleOf("w00abcd")).toBe("opencode-wake-w00abcd")
    expect(idOfTitle("opencode-wake-w00abcd")).toBe("w00abcd")
    expect(idOfTitle("opencode-wake-")).toBeUndefined()
    expect(idOfTitle("nightly-report")).toBeUndefined()
  })
})

describe("schedules", () => {
  test("a job runs at the first whole minute at or after the time", () => {
    expect(minuteOf(at(11, 5, 14, 30))).toBe(at(11, 5, 14, 30))
    expect(minuteOf(at(11, 5, 14, 30, 1))).toBe(at(11, 5, 14, 31))
    expect(oneShot(at(11, 5, 14, 30, 1))).toEqual({ cron: "31 14 5 11 *", recurring: false })
    expect(oneShot(at(12, 31, 23, 59, 30))).toEqual({ cron: "0 0 1 1 *", recurring: false })
  })

  test("an alarm and a monitor's deadline get a one-shot", () => {
    expect(scheduleOf({ ...alarm, dueAt: at(11, 5, 14, 30) })).toEqual({ cron: "30 14 5 11 *", recurring: false })
    expect(scheduleOf({ ...monitor, deadline: at(11, 5, 9, 5) })).toEqual({ cron: "5 9 5 11 *", recurring: false })
  })

  test("a repeat the cron fields hit on every tick gets a recurring line from its first tick", () => {
    const every = (seconds: number, dueAt: number) => scheduleOf({ ...alarm, dueAt, everySeconds: seconds })
    expect(every(60, at(11, 5, 14, 30))).toEqual({ cron: "* * * * *", recurring: true })
    expect(every(15 * 60, at(11, 5, 14, 40))).toEqual({ cron: "10,25,40,55 * * * *", recurring: true })
    expect(every(6 * 3600, at(11, 5, 14, 30))).toEqual({ cron: "30 2,8,14,20 * * *", recurring: true })
    expect(every(86_400, at(11, 5, 7, 0))).toEqual({ cron: "0 7 * * *", recurring: true })
    expect(every(7 * 86_400, at(11, 5, 7, 0))).toEqual({ cron: `0 7 * * ${new Date(at(11, 5, 7, 0)).getDay()}`, recurring: true })
  })

  test("any other period rolls a one-shot for its next tick", () => {
    expect(scheduleOf({ ...alarm, dueAt: at(11, 5, 14, 30), everySeconds: 7 * 60 })).toEqual({ cron: "30 14 5 11 *", recurring: false })
    expect(scheduleOf({ ...alarm, dueAt: at(11, 5, 14, 30), everySeconds: 5 * 3600 })).toEqual({ cron: "30 14 5 11 *", recurring: false })
    expect(scheduleOf({ ...alarm, dueAt: at(11, 5, 14, 30), everySeconds: 90 })).toEqual({ cron: "30 14 5 11 *", recurring: false })
  })
})

describe("carried", () => {
  test("keeps only the variables that pick OpenCode's state and config", () => {
    expect(carried({ HOME: "/h", XDG_STATE_HOME: "/s", OPENCODE_DB: "/db", OPENCODE_CONFIG_DIR: "", ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin" })).toEqual({
      HOME: "/h",
      XDG_STATE_HOME: "/s",
      OPENCODE_DB: "/db",
    })
  })
})
