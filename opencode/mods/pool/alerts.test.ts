// When a store's failing refreshes are an outage: a run as long as the
// threshold, a pause counting while it holds, and a run gone quiet forgotten.
import { describe, expect, test } from "bun:test"
import { OUTAGE_AFTER_MS, outage, type RefreshRecord } from "./alerts.ts"

const MINUTE = 60_000
const start = 1_800_000_000_000
const cause = { status: 429, server: "cloudflare", retryAfter: "300" }

const run = (minutes: number, fields: Partial<RefreshRecord> = {}): RefreshRecord => ({
  failingSince: start,
  lastFailureAt: start + minutes * MINUTE,
  failures: minutes + 1,
  cause,
  pausedUntil: 0,
  ...fields,
})

describe("outage", () => {
  test("no run is no outage", () => {
    expect(outage({ failures: 0, pausedUntil: 0 }, start)).toBeUndefined()
  })

  test("a run shorter than the threshold is none; one as long is, with its cause", () => {
    expect(outage(run(9), start + 9 * MINUTE)).toBeUndefined()
    expect(outage(run(10), start + 10 * MINUTE)).toEqual({ since: start, lastAt: start + 10 * MINUTE, failures: 11, cause })
    expect(OUTAGE_AFTER_MS).toBe(10 * MINUTE)
  })

  test("the threshold is the caller's", () => {
    expect(outage(run(3), start + 3 * MINUTE, 2 * MINUTE)).toMatchObject({ since: start })
    expect(outage(run(3), start + 3 * MINUTE, 5 * MINUTE)).toBeUndefined()
  })

  test("a pause the endpoint asked for counts as failing while it lasts", () => {
    // One 429 at the start, retry-after an hour: nothing goes out, but nothing can.
    const paused = run(0, { pausedUntil: start + 60 * MINUTE })
    expect(outage(paused, start + 5 * MINUTE)).toBeUndefined()
    expect(outage(paused, start + 10 * MINUTE)).toMatchObject({ since: start, failures: 1 })
    expect(outage(paused, start + 65 * MINUTE)).toMatchObject({ since: start })
  })

  test("a run nothing extended for as long as the threshold is stale", () => {
    expect(outage(run(12), start + 22 * MINUTE)).toMatchObject({ since: start })
    expect(outage(run(12), start + 23 * MINUTE)).toBeUndefined()
  })

  test("a run without a cause, from an endpoint that never answered, names none", () => {
    expect(outage(run(10, { cause: {} }), start + 10 * MINUTE)?.cause).toEqual({})
    const { cause: _, ...bare } = run(10)
    expect(outage(bare, start + 10 * MINUTE)).not.toHaveProperty("cause")
  })
})
