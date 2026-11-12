// The limit tally's CLI view on a recorded fixture: both hosts' dumps of
// 2026-11-12 (pool-limits-dump.ts), cut to the Anthropic weeks, logins
// renamed, each host's tokens per login and model in the login's week summed.
// Fable ran on 6 of 7 accounts at about 1.4% of the weighted tokens, and every
// reading of Fable's own week (`7d:Fable`) said its part of the weekly window.
import { expect, test } from "bun:test"
import { limitsLine, weeklyRatios } from "../mods/pool/limits.ts"
import recorded from "./fixtures/pool-limits-2026-11-12.json"
import { fromDumps, notes } from "./pool-limits.ts"

const computed = fromDumps(Object.entries(recorded) as Parameters<typeof fromDumps>[0])
const family = (window: string, name: string) => computed.recent.find((w) => w.pool === "anthropic" && w.window === window)?.families.find((f) => f.family === name)

test("Fable's rate on the weekly window is its reported part, not the 0 the shared fit gave it", () => {
  const fable = family("7d", "Fable")!
  expect(fable).toMatchObject({ n: 6, reported: true })
  expect(fable.weighted.rate).toBeCloseTo(1.01, 2)
  expect(fable.weighted.low!).toBeGreaterThan(0.8)
  expect(fable.weighted.high!).toBeLessThan(1.2)
  // Opus carries the rest of the rise.
  expect(family("7d", "Opus")!.weighted.rate).toBeCloseTo(0.193, 2)
})

test("Fable's own week has its rate, and the weekly points one own-week point costs", () => {
  expect(family("7d:Fable", "Fable")!.weighted.rate).toBeCloseTo(1.86, 2)
  const ratio = weeklyRatios(computed, "anthropic")["7d:Fable"]!
  // The endpoint's allowance share is 0.5: the measured ratio's range holds it.
  expect(ratio.rate).toBeCloseTo(0.54, 2)
  expect(ratio.low!).toBeLessThan(0.5)
  expect(ratio.high!).toBeGreaterThan(0.5)
})

test("the line and the view show Fable on both weeks and the ratio", () => {
  expect(limitsLine(computed)).toBe(
    "limit/Mtok 7d: Fable 1.0% 0.88–1.1 n 6 (own week 1.9% 1.6–2.2 n 6; weekly/own 0.54) · Opus 0.19% 0.16–0.22 n 7 (last 7 days)",
  )
  expect(notes(computed)).toEqual(["  anthropic 7d:Fable: 0.542 (0.407–0.727) weekly points per own-week point"])
})
