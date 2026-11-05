import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { billOf, type Price, rateFor } from "./price.ts"

const HOUR = 3_600_000
const opus: Price = { rates: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }], anthropic: true }

describe("what compacting an idle session costs and avoids", () => {
  test("on an hour's Anthropic cache: the summary read from cache and written out, and its prompt written at twice the input rate", () => {
    const bill = Option.getOrUndefined(billOf(opus, 160_000, HOUR))
    // Avoided: 160k written at $8. Cost: 160k read at $0.20, 32k out at $20, 64k written at $8.
    expect(bill?.avoided).toBeCloseTo(1.28, 10)
    expect(bill?.cost).toBeCloseTo(0.032 + 0.64 + 0.512, 10)
    expect(bill?.breakEven).toEqual(Option.some(147_693))
  })

  test("a five-minute cache is written at the catalog's write price", () => {
    const bill = Option.getOrUndefined(billOf(opus, 160_000, 5 * 60_000))
    expect(bill?.avoided).toBeCloseTo(0.8, 10)
    expect(bill?.breakEven).toEqual(Option.some(200_000))
  })

  test("the tier the prompt passes prices it, the untiered entry the summary's prompt", () => {
    const rates = [
      { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      { tier: 200_000, input: 8, output: 30, cacheRead: 0.4, cacheWrite: 10 },
    ]
    expect(rateFor(rates, 200_000)?.input).toBe(4)
    expect(rateFor(rates, 200_001)?.input).toBe(8)
    const bill = Option.getOrUndefined(billOf({ rates, anthropic: true }, 300_000, HOUR))
    expect(bill?.avoided).toBeCloseTo(300_000 * 16 / 1e6, 10)
    expect(bill?.cost).toBeCloseTo((300_000 * 0.4 + 32_000 * 30 + 64_000 * 8) / 1e6, 10)
  })

  test("no bill for a model the catalog does not price", () => {
    expect(billOf(undefined, 500_000, HOUR)).toEqual(Option.none())
    expect(billOf({ rates: [], anthropic: true }, 500_000, HOUR)).toEqual(Option.none())
    expect(billOf({ rates: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }], anthropic: false }, 500_000, HOUR)).toEqual(Option.none())
  })
})
