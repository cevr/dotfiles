// The line while the TUI waits for its service, then for its location's plugins: shown past a moment, ticking.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { STARTING_SHOWN_AFTER_MS, startingAfter, startingLine, waited } from "./starting.ts"

describe("what the TUI waits for", () => {
  // The workbox restart (2026-11-17): the stream back at once, the service's info soon after, the location's
  // providers 503 for minutes while its plugins activated. The wait runs from the connection to the providers.
  test("a restart: the service from the connection, then its location's plugins, timed from the connection, then nothing", () => {
    const connected = startingAfter(Option.none(), "connected", 1_000, true)
    expect(connected).toEqual(Option.some({ phase: "service", since: 1_000 }))
    const served = startingAfter(connected, "served", 3_000, true)
    expect(served).toEqual(Option.some({ phase: "plugins", since: 1_000 }))
    expect(startingLine(served, 213_000)).toEqual(Option.some({ lead: "plugins starting", rest: " · 3m32s · a prompt sent now waits for it" }))
    expect(startingAfter(served, "providers", 214_000, true)).toEqual(Option.none())
  })

  test("with no location, a service that serves is all there is to wait for", () => {
    expect(startingAfter(startingAfter(Option.none(), "connected", 0, false), "served", 10, false)).toEqual(Option.none())
  })

  test("a reconnect while the plugins still start waits for the service again, from the reconnect", () => {
    expect(startingAfter(Option.some({ phase: "plugins", since: 0 }), "connected", 5_000, true)).toEqual(Option.some({ phase: "service", since: 5_000 }))
  })
})

describe("the starting line", () => {
  test("names what the TUI waits for, how long, and that a prompt waits too", () => {
    expect(startingLine(Option.some({ phase: "service", since: 0 }), 42_000)).toEqual(Option.some({ lead: "server starting", rest: " · 42s · a prompt sent now waits for it" }))
    expect(startingLine(Option.some({ phase: "plugins", since: 0 }), 72_400)).toEqual(Option.some({ lead: "plugins starting", rest: " · 1m12s · a prompt sent now waits for it" }))
  })

  test("draws nothing while nothing is awaited, nor for a wait a quick reconnect takes", () => {
    expect(Option.isNone(startingLine(Option.none(), 10_000))).toBe(true)
    expect(Option.isNone(startingLine(Option.some({ phase: "service", since: 1_000 }), 1_000 + STARTING_SHOWN_AFTER_MS - 1))).toBe(true)
    expect(Option.isSome(startingLine(Option.some({ phase: "service", since: 1_000 }), 1_000 + STARTING_SHOWN_AFTER_MS))).toBe(true)
  })

  test("counts the wait in whole seconds, minutes past one, hours past one", () => {
    expect([0, 999, 59_999, 60_000, 61_000, 3_599_000, 3_600_000, 3_720_000].map(waited)).toEqual(["0s", "0s", "59s", "1m00s", "1m01s", "59m59s", "1h00m", "1h02m"])
  })
})
