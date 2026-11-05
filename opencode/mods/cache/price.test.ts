import { describe, expect, test } from "bun:test"
import { missCostUsd, rateFor, writeRate, type Rate } from "./price.ts"

/** Claude Sonnet's prices: $3 input, $0.30 cache read, $3.75 cache write (5 min), $6 input above 200k. */
const SONNET: ReadonlyArray<Rate> = [
  { input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
  { tier: 200_000, input: 6, cacheRead: 0.6, cacheWrite: 7.5 },
]

describe("rateFor", () => {
  test("a prompt past a tier pays that tier, else the untiered entry", () => {
    expect(rateFor(SONNET, 150_000)?.input).toBe(3)
    expect(rateFor(SONNET, 200_000)?.input).toBe(3)
    expect(rateFor(SONNET, 200_001)?.input).toBe(6)
    expect(rateFor([], 1_000)).toBeUndefined()
  })
})

describe("writeRate", () => {
  const [rate = expect.unreachable()] = SONNET
  test("the catalog's write is the 5-minute one; an hour on Anthropic pays twice the input", () => {
    expect(writeRate(rate, "anthropic", 5 * 60_000)).toBe(3.75)
    expect(writeRate(rate, "anthropic", 3_600_000)).toBe(6)
    expect(writeRate(rate, "openai", 3_600_000)).toBe(3.75)
    expect(writeRate(rate, undefined, undefined)).toBe(3.75)
  })
})

describe("missCostUsd", () => {
  const [rate = expect.unreachable()] = SONNET
  test("the missed tokens fill the step's cache writes first, at the write rate over the read rate", () => {
    // 48k missed, all rewritten: 48k × (3.75 − 0.30) = $0.1656.
    expect(missCostUsd({ missedTokens: 48_000, cacheWriteTokens: 50_000 }, rate, 3.75)).toBeCloseTo(0.1656, 6)
  })

  test("the rest paid the input rate over the read rate", () => {
    // 30k rewritten × 3.45 + 18k uncached × 2.70 = $0.1035 + $0.0486.
    expect(missCostUsd({ missedTokens: 48_000, cacheWriteTokens: 30_000 }, rate, 3.75)).toBeCloseTo(0.1521, 6)
  })

  test("a provider that bills no writes pays every missed token at the input rate", () => {
    const gpt: Rate = { input: 1.25, cacheRead: 0.125, cacheWrite: 0 }
    expect(missCostUsd({ missedTokens: 100_000, cacheWriteTokens: 0 }, gpt, 0)).toBeCloseTo(0.1125, 6)
  })

  test("a model the catalog does not price costs nothing", () => {
    expect(missCostUsd({ missedTokens: 100_000, cacheWriteTokens: 0 }, undefined, 0)).toBe(0)
  })
})
