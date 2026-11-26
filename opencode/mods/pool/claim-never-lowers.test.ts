// Law 2 of the pace-hit diagnosis (2026-11-26): claiming a reset only ever adds room. The line after a claim is
// never below the line the login would have with no claim, and a login under its line with no claim is never held
// by the even line because of one. Measured: a Fable claim observed at 75% rebased a login's line to 80.0% while its
// natural line was 85.4%, so a host that made the claim held a login the other host (no claim) admitted.
import { expect, test } from "bun:test"
import { NO_INFLIGHT, dispatchPace, poolPace } from "./pace.ts"
import type { AccountStatus } from "./status.ts"
import { lineOf, ordinaryPlan, WEEK, type PacePlan } from "./weekly-pace.ts"

const now = Date.parse("2026-11-26T04:00:00Z")
const HOUR = 3_600_000

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const account = (week: number, resetAt: number): AccountStatus => ({
  credentialID: "a", load: 0, live: 0, noRoom: false,
  reading: {
    at: now - 1000,
    usage: { at: now - 1000, samples: 2 },
    windows: [{ name: "7d", utilization: week, resetAt }, { name: "5h", utilization: 0.1, resetAt: now + HOUR }],
  },
})

/** A generated plan: a claim observed some time in the current week, with or without capacity. */
const planOf = (next: () => number, resetAt: number): PacePlan => {
  const at = resetAt - WEEK + 1 + Math.floor(next() * (now - (resetAt - WEEK)))
  const rebase = { at, from: Math.floor(next() * 100) / 100, key: "k", spent: 0 }
  if (next() >= 0.3) return { rebase }
  const extra = Math.floor(next() * 200) / 100
  if (next() < 0.5) return { rebase, capacity: { extra } }
  return { rebase, capacity: { extra, expiresAt: now + Math.floor(next() * 4 * 24 * HOUR) } }
}

test("the line after a claim is never below the line with no claim, at any time after the claim", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const next = mulberry(seed)
    const resetAt = now + HOUR + Math.floor(next() * (WEEK - HOUR))
    const plan = planOf(next, resetAt)
    for (let t = plan.rebase!.at; t < resetAt; t += Math.max(HOUR, Math.floor((resetAt - plan.rebase!.at) / 9))) {
      const claimed = lineOf(resetAt, t, plan)
      const none = lineOf(resetAt, t, ordinaryPlan(plan))
      expect({ seed, t, below: claimed < none - 1e-12 }).toEqual({ seed, t, below: false })
    }
  }
})

test("the measured case: a claim observed at 75% when the natural line was 85.4% leaves the line at least natural", () => {
  // Natural line 0.854 at the claim: (0.854 - 0.05) / 0.99 of the week gone.
  const resetAt = now + 2 * 24 * HOUR
  const claimAt = resetAt - WEEK + Math.round(((0.854 - 0.05) / 0.99) * WEEK)
  const plan: PacePlan = { rebase: { at: claimAt, from: 0.75, key: "k", spent: 0 } }
  expect(lineOf(resetAt, claimAt, plan)).toBeGreaterThanOrEqual(lineOf(resetAt, claimAt) - 1e-12)
  expect(lineOf(resetAt, now, plan)).toBeGreaterThanOrEqual(lineOf(resetAt, now) - 1e-12)
  // A login at 85% under its natural line is admitted, claim or no claim.
  const used = Math.min(lineOf(resetAt, now) - 0.01, 0.9)
  expect(dispatchPace([account(used, resetAt)], now, {}, 0.005, "claude-opus-5-5")).toMatchObject({ ok: true })
  expect(dispatchPace([account(used, resetAt)], now, { a: plan }, 0.005, "claude-opus-5-5")).toMatchObject({ ok: true, admission: "ordinary" })
})

test("a login the even line admits with no claim is admitted with one", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const next = mulberry(seed)
    const resetAt = now + HOUR + Math.floor(next() * (WEEK - HOUR))
    const plan = planOf(next, resetAt)
    const used = Math.floor(next() * 99) / 100
    const login = account(used, resetAt)
    const none = poolPace([login], now, NO_INFLIGHT, "claude-opus-5-5", { a: ordinaryPlan(plan) })
    const claimed = poolPace([login], now, NO_INFLIGHT, "claude-opus-5-5", { a: plan })
    expect({ seed, tighter: none.ok && !claimed.ok }).toEqual({ seed, tighter: false })
  }
})
