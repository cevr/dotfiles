import { describe, expect, test } from "bun:test"
import { Duration, Option } from "effect"
import { iso } from "./gate.ts"
import { stalledFor, statusOf } from "./watch.ts"

/** 2026-11-12T15:41:15Z, when a TUI's `service ensure` started the workbox's service. */
const STARTED = 1_794_498_075_000
const EVERY = Duration.minutes(10)
const minutes = (count: number) => Duration.toMillis(Duration.minutes(count))

describe("the checks' status", () => {
  test("counts from the last check, or from the start before the first; stalled past two intervals", () => {
    expect(stalledFor(STARTED + minutes(20), Option.none(), STARTED, EVERY)).toEqual(Option.none())
    expect(stalledFor(STARTED + minutes(21), Option.none(), STARTED, EVERY)).toEqual(Option.some(Duration.minutes(21)))
    expect(stalledFor(STARTED + minutes(21), Option.some(STARTED + minutes(5)), STARTED, EVERY)).toEqual(Option.none())
    expect(stalledFor(STARTED + minutes(30), Option.some(STARTED - minutes(60)), STARTED, EVERY)).toEqual(Option.some(Duration.minutes(30)))
  })

  test("the status RPC's answer names the last check", () => {
    expect(statusOf(STARTED + minutes(5), Option.none(), STARTED, EVERY)).toEqual({ stalled: false })
    expect(statusOf(STARTED + minutes(40), Option.some(STARTED + minutes(10)), STARTED, EVERY)).toEqual({ lastCheck: iso(STARTED + minutes(10)), stalled: true })
  })
})
