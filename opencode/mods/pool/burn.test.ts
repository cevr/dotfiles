// An account's burn per window (burn.ts): measured over its readings of the
// last two hours in one window period, else the period's average; a spent
// window burns at the average that spent it.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { averagedOf, BURN_MS, burnsOf, MIN_SPAN_MS, periodBurn, remember, type Sample } from "./burn.ts"
import type { QuotaReading } from "./quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-15T12:00:00Z")
const WEEK_AT = T0 + 3 * DAY

const reading = (at: number, week: number, weekAt = WEEK_AT): QuotaReading => ({ at, windows: [{ name: "7d", utilization: week, resetAt: weekAt }] })
const kept = (readings: ReadonlyArray<QuotaReading>, now: number) => readings.reduce<ReadonlyArray<Sample>>((samples, read) => remember(samples, Option.some(read), read.at), []).filter((sample) => sample.at > now - BURN_MS)

describe("the burn", () => {
  test("over readings far enough apart in one period: the rise per hour", () => {
    const samples = kept([reading(T0, 0.4), reading(T0 + 30 * MINUTE, 0.45), reading(T0 + HOUR, 0.5)], T0 + HOUR)
    expect(burnsOf(samples, T0 + HOUR)["7d"]).toBeCloseTo(0.1)
  })

  test("with readings closer than MIN_SPAN_MS, or one alone: the period's average", () => {
    const now = T0 + MIN_SPAN_MS - MINUTE
    const average = periodBurn({ name: "7d", utilization: 0.5, resetAt: WEEK_AT }, now)
    // Four days and the minutes since of the week run, half of it used.
    expect(average).toBeCloseTo(0.5 / ((4 * DAY + MIN_SPAN_MS - MINUTE) / HOUR), 8)
    expect(burnsOf(kept([reading(T0, 0.45), reading(now, 0.5)], now), now)["7d"]).toBeCloseTo(average)
    expect(burnsOf(kept([reading(now, 0.5)], now), now)["7d"]).toBeCloseTo(average)
    // Said so: the window is averaged, for want of a measure.
    expect(averagedOf(kept([reading(now, 0.5)], now))).toEqual(["7d"])
  })

  test("a window is averaged only while open and not measured", () => {
    const now = T0 + HOUR
    expect(averagedOf(kept([reading(T0, 0.4), reading(now, 0.5)], now))).toEqual([])
    // A spent window burns at its average by design, not for want of a measure.
    expect(averagedOf(kept([reading(now, 1)], now))).toEqual([])
    expect(averagedOf([])).toEqual([])
  })

  test("a claim or a reset between readings starts it over: only the readings since count", () => {
    const now = T0 + 2 * HOUR - MINUTE
    // The week was at 90%, a claim emptied it at T0 + 1 h, it rose 5% in the 50 minutes since.
    const claimed = kept([reading(T0, 0.85), reading(T0 + 30 * MINUTE, 0.9), reading(T0 + HOUR + 9 * MINUTE, 0.01), reading(now, 0.06)], now)
    expect(burnsOf(claimed, now)["7d"]).toBeCloseTo(0.05 / (50 / 60))
    // A new period (the reset moved) likewise.
    const moved = kept([reading(T0, 0.85), reading(T0 + HOUR, 0.1, WEEK_AT + 4 * DAY), reading(now, 0.15, WEEK_AT + 4 * DAY)], now)
    expect(burnsOf(moved, now)["7d"]).toBeCloseTo(0.05 / ((now - T0 - HOUR) / HOUR))
  })

  test("a spent window burns at the average that spent it, not the nothing it shows now", () => {
    const now = T0 + HOUR
    const samples = kept([reading(T0, 1), reading(now, 1)], now)
    expect(burnsOf(samples, now)["7d"]).toBeCloseTo(periodBurn({ name: "7d", utilization: 1, resetAt: WEEK_AT }, now))
    expect(burnsOf(samples, now)["7d"]).toBeGreaterThan(0)
  })

  test("readings are kept for BURN_MS, newer ones only", () => {
    const samples = kept([reading(T0, 0.1), reading(T0 + HOUR, 0.2), reading(T0 + 2 * HOUR + MINUTE, 0.3)], T0 + 2 * HOUR + MINUTE)
    expect(samples.map((sample) => sample.at)).toEqual([T0 + HOUR, T0 + 2 * HOUR + MINUTE])
    expect(remember(samples, Option.some(reading(T0 + HOUR, 0.9)), T0 + 2 * HOUR + MINUTE)).toEqual(samples)
    expect(remember(samples, Option.none(), T0 + 2 * HOUR + MINUTE)).toEqual(samples)
  })
})
