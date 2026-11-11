// The limit tally at its public seams: readings and uses in, rates per family
// and window out, with the confounds the attribution has to survive.
import { describe, expect, test } from "bun:test"
import {
  emptyState,
  familyOf,
  limitsLine,
  merge,
  observe,
  recount,
  reportOf,
  resetInside,
  rowKey,
  tally,
  takePeer,
  weightedOf,
  type LimitsState,
  type Use,
} from "./limits.ts"
import type { QuotaReading } from "./quota.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 1)

const tokens = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 })
const use = (at: number, credentialID: string, model: string, input: number, pool = "anthropic"): Use => ({
  at,
  pool,
  credentialID,
  model,
  tokens: tokens(input),
})
const reading = (at: number, windows: QuotaReading["windows"]): QuotaReading => ({ at, windows })

/**
 * `accounts` 5-hour periods, one per account, each with its own mix of Opus and
 * Fable tokens (Mtok), read at the period's end with `rise` points: the truth
 * is `opus` and `fable` points per Mtok, and readings round to whole points.
 */
const periods = (mixes: ReadonlyArray<readonly [number, number]>, opus: number, fable: number, round = true) => {
  let state = emptyState(T0)
  const uses: Array<Use> = []
  mixes.forEach(([o, f], i) => {
    const credentialID = `acct-${i}`
    const resetAt = T0 + 6 * HOUR
    uses.push(use(T0 + 2 * HOUR, credentialID, "claude-opus-5-5", o * 1e6), use(T0 + 3 * HOUR, credentialID, "claude-fable-5-2", f * 1e6))
    const points = opus * o + fable * f
    state = observe(state, "anthropic", credentialID, reading(T0 + 4 * HOUR, [{ name: "5h", utilization: (round ? Math.round(points) : points) / 100, resetAt }]))
  })
  return recount(state, uses, T0 + 4 * HOUR)
}

describe("families and weights", () => {
  test("a model's family is its name: Claude's word, GPT's after its version", () => {
    expect(familyOf("claude-opus-5-5")).toBe("Opus")
    expect(familyOf("anthropic/claude-fable-5-2")).toBe("Fable")
    expect(familyOf("gpt-6.1-sol")).toBe("sol")
    expect(familyOf("gpt-6.1-sol-ultrafast")).toBe("sol-ultrafast")
    expect(familyOf("gpt-6-luna")).toBe("luna")
  })

  test("weighted tokens are input-equivalent at list price, so cache reads count at their price", () => {
    // Opus: read 0.2 / input 4 = 1/20, output 20 / 4 = 5.
    expect(weightedOf("claude-opus-5-5", { input: 10, output: 2, cacheRead: 2000, cacheWrite: 0 })).toBe(10 + 10 + 100)
    // A model with no row weighs as its family's: ultrafast as sol.
    expect(weightedOf("gpt-6.1-sol-ultrafast", { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 })).toBe(5)
    // An unknown model is raw.
    expect(weightedOf("mystery-1", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBe(4)
  })
})

describe("attribution", () => {
  test("several models on one account: least squares over periods recovers each family's rate", () => {
    // Every account runs both models, in different mixes; Fable costs 2x Opus per Mtok.
    const state = periods(
      [
        [10, 1],
        [4, 6],
        [12, 2],
        [2, 9],
        [7, 4],
        [9, 0],
        [1, 7],
      ],
      0.9,
      1.8,
      false,
    )
    const [window] = tally(state, T0 + 4 * HOUR).recent
    const rate = (family: string) => window!.families.find((f) => f.family === family)!
    expect(window!.rows).toBe(7)
    expect(rate("Opus").weighted.rate).toBeCloseTo(0.9, 6)
    expect(rate("Fable").weighted.rate).toBeCloseTo(1.8, 6)
    expect(rate("Opus").n).toBe(7)
    expect(rate("Fable").n).toBe(6)
  })

  test("readings coarse to a whole point: the rate lands near the truth, inside its 95% range", () => {
    const mixes: Array<readonly [number, number]> = [
      [3, 0.5],
      [1, 2],
      [5, 0.2],
      [0.5, 3],
      [2.5, 1.5],
      [4, 1],
      [1.5, 2.5],
      [6, 0.3],
    ]
    const [window] = tally(periods(mixes, 0.9, 1.8), T0 + 4 * HOUR).recent
    for (const [family, truth] of [
      ["Opus", 0.9],
      ["Fable", 1.8],
    ] as const) {
      const rate = window!.families.find((f) => f.family === family)!.weighted
      expect(rate.low).toBeDefined()
      expect(rate.low!).toBeLessThanOrEqual(truth)
      expect(rate.high!).toBeGreaterThanOrEqual(truth)
      expect(Math.abs(rate.rate - truth)).toBeLessThan(0.25)
    }
  })

  test("a reset inside a period drops its row; so does a period begun before the tokens were recorded", () => {
    const resetAt = T0 + 3 * DAY
    let state = emptyState(T0)
    state = observe(state, "anthropic", "a", reading(T0 + DAY, [{ name: "7d", utilization: 0.4, resetAt }]))
    // A claimed reset empties the week under the same reset time.
    state = observe(state, "anthropic", "a", reading(T0 + DAY + HOUR, [{ name: "7d", utilization: 0.05, resetAt }]))
    // Another account's week began four days before the store did.
    state = observe(state, "anthropic", "b", reading(T0 + DAY, [{ name: "7d", utilization: 0.3, resetAt }]))
    state = recount(state, [use(T0 + HOUR, "a", "claude-opus-5-5", 1e6), use(T0 + HOUR, "b", "claude-opus-5-5", 1e6)], T0 + DAY + HOUR)
    expect(state.rows[rowKey("anthropic", "a", "7d", resetAt)]!.broken).toBe(true)
    expect(tally(state, T0 + DAY + HOUR).recent).toEqual([])
  })

  test("an older reading changes nothing; a later one in the same period moves the row's end", () => {
    const resetAt = T0 + 5 * HOUR
    let state = observe(emptyState(T0), "anthropic", "a", reading(T0 + 2 * HOUR, [{ name: "5h", utilization: 0.2, resetAt }]))
    const later = observe(state, "anthropic", "a", reading(T0 + 3 * HOUR, [{ name: "5h", utilization: 0.3, resetAt: resetAt + 2_000 }]))
    expect(observe(later, "anthropic", "a", reading(T0 + HOUR, [{ name: "5h", utilization: 0.1, resetAt }]))).toBe(later)
    const row = Object.values(later.rows)[0]!
    expect(Object.keys(later.rows)).toHaveLength(1)
    expect([row.at, row.rise]).toEqual([T0 + 3 * HOUR, 30])
    state = recount(later, [use(T0 + 2.5 * HOUR, "a", "claude-opus-5-5", 5), use(T0 + 4 * HOUR, "a", "claude-opus-5-5", 7)], T0 + 4 * HOUR)
    // Only the tokens up to the row's last reading count.
    expect(Object.values(state.rows)[0]!.own["Opus"]!.raw).toBe(5)
  })

  test("a model's own week counts only that model's tokens", () => {
    const resetAt = T0 + 7 * DAY
    let state = observe(emptyState(T0), "anthropic", "a", reading(T0 + HOUR * 2, [{ name: "7d:Fable", utilization: 0.02, resetAt }]))
    state = recount(state, [use(T0 + HOUR, "a", "claude-opus-5-5", 9e6), use(T0 + HOUR, "a", "claude-fable-5-2", 1e6)], T0 + 2 * HOUR)
    expect(Object.keys(Object.values(state.rows)[0]!.own)).toEqual(["Fable"])
  })

  test("a peer's tokens on the same account count with this host's, from its report", () => {
    const resetAt = T0 + 5 * HOUR
    const at = T0 + 4 * HOUR
    const host = (since: number): LimitsState => observe(emptyState(since), "anthropic", "a", reading(at, [{ name: "5h", utilization: 0.03, resetAt }]))
    const peer = recount(host(T0), [use(T0 + HOUR, "a", "claude-opus-5-5", 2e6)], at)
    let mine = recount(host(T0), [use(T0 + HOUR, "a", "claude-opus-5-5", 1e6)], at)
    mine = takePeer(mine, "workbox", reportOf(peer, at))
    const opus = tally(mine, at).recent[0]!.families[0]!
    expect(opus.mtok).toBeCloseTo(3, 9)
    expect(opus.weighted.rate).toBeCloseTo(1, 9)
    expect(tally(mine, at).peers).toEqual({ workbox: T0 })
  })
})

describe("confounds", () => {
  test("a family with a sliver of a window's tokens is left out of the fit, not given the residual", () => {
    const state = periods(
      [
        [10, 0.01],
        [4, 0],
        [12, 0.02],
      ],
      1,
      1,
    )
    const [window] = tally(state, T0 + 4 * HOUR).recent
    expect(window!.families.map((f) => f.family)).toEqual(["Opus"])
    expect(window!.ignored).toEqual([{ family: "Fable", mtok: expect.closeTo(0.03, 9) }])
  })

  test("a claimed reset inside a period breaks it; one after its last reading leaves it", () => {
    const resetAt = T0 + 7 * DAY
    const state = observe(emptyState(T0), "anthropic", "a", reading(T0 + 2 * DAY, [{ name: "7d", utilization: 0.4, resetAt }]))
    const key = rowKey("anthropic", "a", "7d", resetAt)
    expect(resetInside(state, "anthropic", "a", T0 + DAY).rows[key]!.broken).toBe(true)
    expect(resetInside(state, "anthropic", "a", T0 + 3 * DAY).rows[key]!.broken).toBeUndefined()
    expect(resetInside(state, "anthropic", "b", T0 + DAY).rows[key]!.broken).toBeUndefined()
  })

  test("a peer that knows the account by another login id adds its tokens to the one row of the same period", () => {
    const resetAt = T0 + 7 * DAY
    const at = T0 + DAY
    const week = (credentialID: string) => observe(emptyState(T0), "openai", credentialID, reading(at, [{ name: "7d", utilization: 0.05, resetAt }]))
    const peer = recount(week("cred-peer"), [use(T0 + HOUR, "cred-peer", "gpt-6.1-sol", 4e6, "openai")], at)
    const mine = takePeer(recount(week("cred-mine"), [use(T0 + HOUR, "cred-mine", "gpt-6.1-sol", 1e6, "openai")], at), "workbox", reportOf(peer, at))
    expect(tally(mine, at).recent[0]!.families[0]).toMatchObject({ family: "sol", mtok: 5, weighted: { rate: 1 } })
  })
})

describe("persistence", () => {
  test("two copies of one host's state merge to the newer reading and the larger sums, the same either way", () => {
    const resetAt = T0 + 5 * HOUR
    const a = recount(observe(emptyState(T0), "anthropic", "a", reading(T0 + HOUR, [{ name: "5h", utilization: 0.1, resetAt }])), [use(T0 + 0.5 * HOUR, "a", "claude-opus-5-5", 5)], T0 + HOUR)
    const b = recount(observe(emptyState(T0 + HOUR), "anthropic", "a", reading(T0 + 2 * HOUR, [{ name: "5h", utilization: 0.2, resetAt }])), [use(T0 + 0.5 * HOUR, "a", "claude-opus-5-5", 5), use(T0 + 1.5 * HOUR, "a", "claude-opus-5-5", 5)], T0 + 2 * HOUR)
    const merged = merge(a, b)
    expect(merge(b, a)).toEqual(merged)
    const row = Object.values(merged.rows)[0]!
    expect([row.rise, row.own["Opus"]!.raw, merged.since]).toEqual([20, 10, T0])
    expect(JSON.parse(JSON.stringify(merged))).toEqual(merged)
  })
})

describe("the line", () => {
  test("per family on the shared week, a model's own week beside it, with range and n", () => {
    const resetAt = T0 + 7 * DAY
    let state = emptyState(T0 - 7 * DAY)
    const uses: Array<Use> = []
    ;[
      [4, 1],
      [1, 3],
      [3, 2],
    ].forEach(([o, f], i) => {
      const id = `acct-${i}`
      uses.push(use(T0 + HOUR / 2, id, "claude-opus-5-5", o! * 1e6), use(T0 + HOUR / 2, id, "claude-fable-5-2", f! * 1e6))
      state = observe(state, "anthropic", id, reading(T0 + HOUR, [
        { name: "7d", utilization: (0.9 * o! + 1.6 * f!) / 100, resetAt },
        { name: "7d:Fable", utilization: (0.3 * f!) / 100, resetAt },
      ]))
    })
    state = recount(state, uses, T0 + HOUR)
    // Exact readings: each range closes on its rate.
    expect(limitsLine(tally(state, T0 + HOUR))).toBe(
      "limit/Mtok 7d: Fable 1.6% 1.6–1.6 n 3 (own week 0.30%) · Opus 0.90% 0.90–0.90 n 3 (last 7 days)",
    )
    expect(limitsLine(tally(emptyState(T0), T0))).toBeUndefined()
  })
})
