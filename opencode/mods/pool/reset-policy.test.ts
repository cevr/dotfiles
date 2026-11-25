// Public reset decisions, credit scheduling, and the provider-reported Fable refund.
import { expect, test } from "bun:test"
import { Match, Option } from "effect"
import { decideClaim, type ClaimOption, type ClaimSituation } from "./claim-rule.ts"
import { NO_INFLIGHT, poolPace } from "./pace.ts"
import { claimRequestID, effectOf, pacePlans, staleReason, type Claim } from "./resets.ts"
import { lineOf } from "./weekly-pace.ts"
import type { AccountStatus } from "./status.ts"

const now = Date.parse("2026-11-25T19:00:00Z")
const hour = 3_600_000
const day = 24 * hour
const option = (from = 1, preservesWeekly = true, resetIn = 3 * day): ClaimOption => ({
  credentialID: "a", creditID: "grant", label: "A", window: "weekly", long: true, forecast: "7d", from,
  restored: from, resetAt: now + resetIn, burn: 0.001, expiresAt: Option.some(now + 60 * day), frees: true,
  weekUsed: from, weekResetAt: Option.some(now + resetIn), preservesWeekly,
})
const situation = (running = 1): ClaimSituation => ({
  now, held: 0, running, hosts: 1, settling: false, pushed: false,
  accounts: [{ credentialID: "a", freeAt: Option.none(), windows: [{ name: "7d", used: 1, resetAt: now + 3 * day, burn: 0.001 }] }],
})

test("measured exhaustion redeems a valuable Anthropic reset even at a slow burn", () => {
  expect(decideClaim(situation(), [option()])._tag).toBe("Claim")
})

test("forecast demand does not spend an ordinary reset before exhaustion", () => {
  const projected = { ...option(0.9), burn: 1 }
  const busy = { ...situation(), accounts: [{ credentialID: "a", freeAt: Option.none(), windows: [{ name: "7d", used: 0.9, resetAt: now + 3 * day, burn: 1 }] }] }
  expect(decideClaim(busy, [projected])._tag).toBe("NoClaim")
})

test("an exhausted weekly allowance refills promptly on either provider, each with its own cadence", () => {
  expect(decideClaim(situation(), [option(1, true, 6 * hour)])._tag).toBe("Claim")
  expect(decideClaim(situation(), [option(1, false, 6 * hour)])._tag).toBe("Claim")
})

test("a spent OpenAI short window does not discard its unspent weekly allowance", () => {
  const short = { ...option(1, false), forecast: "5h", long: false, weekUsed: 0.4, resetAt: now + 2 * hour }
  expect(decideClaim(situation(), [short])._tag).toBe("NoClaim")
  expect(decideClaim(situation(), [{ ...short, weekUsed: 1 }])._tag).toBe("Claim")
})

const fableCredit = {
  id: "f", kind: "fable" as const, count: 1, usable: true, givesBack: true,
  expiresAt: now + 60 * day, clears: ["seven_day_overage_included"],
}
const account = (used = 0.7) => ({
  credentialID: "a", live: 0, load: 0, noRoom: false,
  reading: {
    at: now,
    windows: [
      { name: "7d", utilization: used, resetAt: now + 3.5 * day },
      { name: "5h", utilization: 0, resetAt: now + hour },
      { name: "7d:Fable", utilization: 0.6, weeklyUsed: 0.3, ofWeekly: 0.5, resetAt: now + 3.5 * day },
    ],
    resets: { available: 1, credits: [fableCredit] },
  },
} satisfies AccountStatus)

test("a known Anthropic credit schedules existing quota before redemption but cannot bypass exhaustion", () => {
  const fresh = account()
  const plans = pacePlans("claude", [fresh], [], now, [], true)
  expect(plans.a?.capacity?.extra).toBe(0.5)
  expect(lineOf(now + 3.5 * day, now, plans.a)).toBeCloseTo(0.795)
  expect(poolPace([fresh], now, NO_INFLIGHT, "claude-fable-5-2", plans)).toMatchObject({ ok: true, admission: "ordinary", eligible: ["a"] })
  expect(poolPace([account(1)], now, NO_INFLIGHT, "claude-fable-5-2", plans).ok).toBe(false)
})

test("OpenAI stock, unapproved stock and stale credit readings add no scheduled capacity", () => {
  const fresh = account()
  expect(pacePlans("codex", [fresh], [], now, [], true)).toEqual({})
  expect(pacePlans("claude", [fresh], [], now, [], false)).toEqual({})
  const old = { ...fresh, reading: { ...fresh.reading, at: now - 16 * 60_000 } }
  expect(pacePlans("claude", [old], [], now, [], true)).toEqual({})
  const carried = { ...fresh, reading: { ...fresh.reading, resets: { ...fresh.reading.resets, at: now - 16 * 60_000 } } }
  expect(pacePlans("claude", [carried], [], now, [], true)).toEqual({})
})

test("an expiring Anthropic credit schedules exhaustion before its last-call deadline", () => {
  const fresh = account()
  const expiring = { ...fresh, reading: { ...fresh.reading, resets: { available: 1, credits: [{ ...fableCredit, expiresAt: now + day }] } } }
  const plans = pacePlans("claude", [expiring], [], now, [], true)
  expect(plans.a?.capacity?.expiresAt).toBe(now + 18 * hour)
  expect(lineOf(now + 3.5 * day, now + 18 * hour, plans.a)).toBeGreaterThanOrEqual(0.99)
})

test("Fable clears its reported shared contribution, preserving unrelated weekly use and the reset date", () => {
  const fresh = account()
  const effect = effectOf("claude", fresh, fableCredit)
  expect(effect.find((window) => window.window === "7d")).toMatchObject({ from: 0.7, resetAt: now + 3.5 * day })
  expect(effect.find((window) => window.window === "7d")?.to).toBeCloseTo(0.4)
  expect(effect.find((window) => window.window === "7d:Fable")).toMatchObject({ from: 0.6, to: 0 })
  const reported = { ...fresh, reading: { ...fresh.reading, windows: fresh.reading.windows.map((window) =>
    Match.value(window).pipe(Match.when({ name: "7d:Fable" }, (window) => ({ ...window, weeklyUsed: 0.19 })), Match.orElse((window) => window))) } }
  expect(effectOf("claude", reported, fableCredit).find((window) => window.window === "7d")?.to).toBeCloseTo(0.51)
})


test("every approved cadence-preserving credit contributes, including two in one weekly cycle", () => {
  const fresh = account()
  const multiple = { ...fresh, reading: { ...fresh.reading, resets: { available: 3, credits: [{ ...fableCredit, count: 3 }] } } }
  expect(pacePlans("claude", [multiple], [], now, [], true).a?.capacity?.extra).toBe(1.5)
})


test("a carried model share does not make fresh Fable reset capacity", () => {
  const fresh = account()
  const staleShare = { ...fresh, reading: { ...fresh.reading, windows: fresh.reading.windows.map((window) =>
    Match.value(window).pipe(Match.when({ name: "7d:Fable" }, (window) => ({ ...window, at: now - 16 * 60_000 })), Match.orElse((window) => window))) } }
  expect(pacePlans("claude", [staleShare], [], now, [], true)).toEqual({})
})


test("a successful reset whose credit stock lags contributes no phantom planned capacity", () => {
  const fresh = account()
  const claim: Claim = { key: "claimed", pool: "anthropic", provider: "claude", credentialID: "a", label: "A", creditID: "f", requestID: claimRequestID("claude", fresh, fableCredit, now), at: now - hour, outcome: "reset", before: [], weekly: "kept" }
  expect(pacePlans("claude", [fresh], [claim], now, [], true)).toEqual({})
  expect(pacePlans("claude", [fresh], [{ ...claim, outcome: "already-redeemed" }], now, [], true)).toEqual({})
  const replenished = { ...fresh, reading: { ...fresh.reading, resets: { available: 2, credits: [{ ...fableCredit, count: 2 }] } } }
  expect(pacePlans("claude", [replenished], [claim], now, [], true).a?.capacity?.extra).toBe(1)
})

test("the send-time guard rechecks exhaustion instead of spending after usage fell", () => {
  const fresh = account(0.7)
  const spent = account(1)
  const reset = { creditID: "f", why: "forecast" as const, provider: "claude" as const }
  const view = { id: "anthropic", provider: "claude" as const, accounts: [spent], labels: {} }
  expect(staleReason(view, spent, reset, now)).toBeUndefined()
  expect(staleReason(view, fresh, reset, now)).toBe("the account no longer has a claimable exhausted window")
})


test("requires-limit stock keeps its inventory identity when usability flips after redemption", () => {
  const fresh = account()
  const claim: Claim = { key: "claimed", pool: "anthropic", provider: "claude", credentialID: "a", label: "A", creditID: "f", requestID: claimRequestID("claude", fresh, fableCredit, now), at: now - hour, outcome: "reset", before: [], weekly: "kept" }
  const lagging = { ...fresh, reading: { ...fresh.reading, resets: { available: 1, credits: [{ ...fableCredit, usable: false, requiresLimit: true }] } } }
  expect(claimRequestID("claude", lagging, fableCredit, now)).toBe(claim.requestID)
  expect(pacePlans("claude", [lagging], [claim], now, [], true)).toEqual({})
})
