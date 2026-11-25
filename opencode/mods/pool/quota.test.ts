// A reading from another plugin, checked field by field, and the names of a
// window scoped to one model.
import { describe, expect, test } from "bun:test"
import { accountWide, asReading, limitsModel, scopeOf } from "./quota.ts"

describe("asReading", () => {
  test("preserves explicit absences over RPC, dropping malformed or contradictory evidence", () => {
    const read = { at: 10, windows: [{ name: "7d", utilization: 0.2, resetAt: 100 }] }
    const absent = [{ name: "5h", at: 9 }]
    expect(asReading({ ...read, absent })).toEqual({ ...read, absent })
    // A host at 04287dc0 names the same absence `fiveHourAbsentAt`.
    expect(asReading({ ...read, fiveHourAbsentAt: 9 })).toEqual({ ...read, absent })
    for (const at of ["9", Number.NaN, 11]) {
      expect(asReading({ ...read, absent: [{ name: "5h", at }] })).toEqual(read)
      expect(asReading({ ...read, fiveHourAbsentAt: at })).toEqual(read)
    }
    // Only a tracked window can be absent, and never one the reading reports.
    expect(asReading({ ...read, absent: [{ name: "7d:Fable", at: 9 }, { name: "7d", at: 9 }] })).toEqual(read)
    const limited = { at: 10, windows: [{ name: "5h", utilization: 1, resetAt: 100 }] }
    expect(asReading({ ...limited, absent })).toEqual(limited)
    expect(asReading({ ...read, unrecognised: ["five_hour"] })).toEqual({ ...read, unrecognised: ["five_hour"] })
  })

  test("keeps the resets an auth plugin read, leaving out a malformed credit", () => {
    const reading = asReading({
      at: 1,
      windows: [{ name: "7d:Fable", utilization: 2 }],
      resets: {
        available: 2,
        nextExpiresAt: 5,
        credits: [{ id: "g-1", count: 2, usable: true, expiresAt: 5 }, { id: "broken", count: "2" }],
      },
    })
    expect(reading).toEqual({
      at: 1,
      windows: [{ name: "7d:Fable", utilization: 1 }],
      resets: { available: 2, nextExpiresAt: 5, credits: [{ id: "g-1", count: 2, usable: true, expiresAt: 5 }] },
    })
    expect(asReading({ at: 1, windows: [], resets: { available: "2" } })).toEqual({ at: 1, windows: [] })
  })
})

describe("a window scoped to one model", () => {
  test("names its model after the window's length, and limits the models whose id names it", () => {
    expect(scopeOf("7d:Fable")).toBe("Fable")
    expect(scopeOf("7d")).toBeUndefined()
    expect(accountWide({ name: "seven_day_opus", utilization: 1 })).toBe(true)
    expect(accountWide({ name: "7d:Fable", utilization: 1 })).toBe(false)
    expect(limitsModel("Fable", "claude-fable-5-2")).toBe(true)
    expect(limitsModel("Fable", "claude-opus-5-5")).toBe(false)
    expect(limitsModel("GPT-6-Astra", "gpt-6-astra")).toBe(true)
  })
})
