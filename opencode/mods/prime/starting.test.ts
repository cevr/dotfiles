// The line while the TUI waits for its service, then for its location's plugins: shown past a moment, ticking.
import { describe, expect, test } from "bun:test"
import { STARTING_SHOWN_AFTER_MS, startingLine, waited } from "./starting.ts"

describe("the starting line", () => {
  test("names what the TUI waits for, how long, and that a prompt waits too", () => {
    expect(startingLine({ phase: "service", since: 0 }, 42_000)).toEqual({ lead: "server starting", rest: " · 42s · a prompt sent now waits for it" })
    expect(startingLine({ phase: "plugins", since: 0 }, 72_400)).toEqual({ lead: "plugins starting", rest: " · 1m12s · a prompt sent now waits for it" })
  })

  test("draws nothing while nothing is awaited, nor for a wait a quick reconnect takes", () => {
    expect(startingLine(undefined, 10_000)).toBeUndefined()
    expect(startingLine({ phase: "service", since: 1_000 }, 1_000 + STARTING_SHOWN_AFTER_MS - 1)).toBeUndefined()
    expect(startingLine({ phase: "service", since: 1_000 }, 1_000 + STARTING_SHOWN_AFTER_MS)).toBeDefined()
  })

  test("counts the wait in whole seconds, minutes past one, hours past one", () => {
    expect([0, 999, 59_999, 60_000, 61_000, 3_599_000, 3_600_000, 3_720_000].map(waited)).toEqual(["0s", "0s", "59s", "1m00s", "1m01s", "59m59s", "1h00m", "1h02m"])
  })
})
