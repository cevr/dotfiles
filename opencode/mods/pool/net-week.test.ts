// A reset in hand adds pace capacity only for the stock its claim gives back, to the consumer it gives it back
// to, on the login that holds it, and only while that claim can still run.
// Law N1 (fable-reset acceptance u1): a held Fable reset moves no other model's pace line. It gives back
//   Fable's reported part of the week and nothing else (resets.ts `effectOf`), so pacing every model faster on
//   it spends into a hole the reset does not clear. Netting Fable's part out of the week (N2 to N4) is unit 1b's.
import { expect, test } from "bun:test"
import { Array as Arr, Match, Option } from "effect"
import { NATURAL_MS } from "./claim-rule.ts"
import { NO_INFLIGHT, poolPace } from "./pace.ts"
import type { ResetCredit } from "./quota.ts"
import { effectOf, pacePlans } from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const now = Date.parse("2026-11-26T00:00:00Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const fable: ResetCredit = {
  id: "grant-fable", count: 1, usable: true, kind: "fable", givesBack: true, requiresLimit: false,
  clears: ["seven_day_overage_included"], expiresAt: now + 60 * DAY,
}
const weekly: ResetCredit = { id: "grant-weekly", count: 1, usable: true, kind: "weekly", requiresLimit: false, clears: ["seven_day", "seven_day_overage_included"], expiresAt: now + 14 * DAY }
/** A give-back grant that also names the shared week: effectOf still takes off it only the model's part. */
const wideFable: ResetCredit = { id: "grant-fable-wide", count: 1, usable: true, givesBack: true, clears: ["seven_day", "seven_day_overage_included"], expiresAt: now + 60 * DAY }

const account = (week: number, own: number, credits: ReadonlyArray<ResetCredit>, resetIn = 3 * DAY, id = "a") => ({
  credentialID: id, load: 0, live: 0, noRoom: false,
  reading: {
    at: now - 1000,
    usage: { at: now - 1000, samples: 2 },
    windows: [
      { name: "7d", utilization: week, resetAt: now + resetIn },
      { name: "7d:Fable", utilization: own, resetAt: now + resetIn, ofWeekly: 0.5, weeklyUsed: Math.round(own * 50) / 100 },
    ],
    resets: { available: credits.length, credits },
  },
}) satisfies AccountStatus
const plans = (week: number, own: number, credits: ReadonlyArray<ResetCredit>, resetIn = 3 * DAY) => pacePlans("claude", [account(week, own, credits, resetIn)], [], now, [], true)
const extraOf = (found: ReturnType<typeof pacePlans>) =>
  Option.flatMap(Option.fromUndefinedOr(found["a"]), (plan) => Option.map(Option.fromUndefinedOr(plan.capacity), (capacity) => capacity.extra))

test("N1: a Fable reset in hand adds no capacity to the pace line; a weekly reset still does", () => {
  expect(plans(0.4, 0.3, [fable])).toEqual({})
  expect(Option.getOrElse(extraOf(plans(0.4, 0.3, [weekly])), () => 0)).toBeCloseTo(0.99, 6)
  expect(Option.getOrElse(extraOf(plans(0.4, 0.3, [weekly, fable])), () => 0)).toBeCloseTo(0.99, 6)
})

test("a grant that gives back a model's part adds nothing even when it names the shared week", () => {
  expect(plans(0.4, 0.3, [wideFable])).toEqual({})
})

test("the live case: a login at week 89% on a Fable reset is held at its even line", () => {
  // Measured 2026-11-26 01:04Z: 61 h of the week left, even line 68%; the extra let it run to the 99% stop.
  const live = account(0.89, 0.04, [fable], 61 * HOUR)
  const found = pacePlans("claude", [live], [], now, [], true)
  expect(found).toEqual({})
  expect(poolPace([live], now, NO_INFLIGHT, "claude-opus-4-6", found).ok).toBe(false)
})

test("no capacity while the claim path cannot run: claims off, the guard before the week's natural reset, a spent, paused or expired reset", () => {
  expect(pacePlans("claude", [account(0.4, 0.3, [weekly])], [], now, [], false)).toEqual({})
  expect(plans(0.4, 0.3, [weekly], NATURAL_MS)).toEqual({})
  expect(Option.getOrElse(extraOf(plans(0.4, 0.3, [weekly], NATURAL_MS + 60_000)), () => 0)).toBeCloseTo(0.99, 6)
  const spent: ReadonlyArray<ResetCredit> = [{ ...weekly, count: 0, usable: false }, { ...weekly, paused: true }, { ...weekly, expiresAt: now - HOUR }]
  for (const credit of spent) expect(plans(0.4, 0.3, [credit])).toEqual({})
})

// Generated logins and inventories of every kind.
const KINDS: ReadonlyArray<ResetCredit> = [
  fable,
  weekly,
  { id: "grant-full", count: 1, usable: true, kind: "full", clears: ["five_hour", "seven_day"] },
  { id: "grant-session", count: 1, usable: true, kind: "session", clears: ["five_hour"] },
  { id: "grant-opus", count: 1, usable: true, clears: ["seven_day_opus"] },
  wideFable,
]
const stateOf = (roll: number, next: () => number): Partial<ResetCredit> =>
  Match.value(roll).pipe(
    Match.when((at) => at < 0.1, () => ({ paused: true })),
    Match.when((at) => at < 0.2, () => ({ expiresAt: now - HOUR })),
    Match.when((at) => at < 0.3, () => ({ usable: false, requiresLimit: true })),
    Match.when((at) => at < 0.4, () => ({ expiresAt: now + Math.floor(next() * 5 * DAY) })),
    Match.orElse(() => ({})),
  )
const inventory = (next: () => number): ReadonlyArray<ResetCredit> =>
  Array.from({ length: Math.floor(next() * 4) }, (_, index) => {
    const credit = KINDS[Math.floor(next() * KINDS.length) % KINDS.length] ?? weekly
    const state = stateOf(next(), next)
    return { ...credit, id: `${credit.id}-${index}`, count: Math.floor(next() * 3), ...state }
  })
const inHand = (credit: ResetCredit) =>
  credit.count > 0 && credit.paused !== true && Option.match(Option.fromUndefinedOr(credit.expiresAt), { onNone: () => true, onSome: (at) => at > now }) && (credit.usable || credit.requiresLimit === true)
/** What claiming each credit gives back to every model on the shared week once the pace ran it to its 99% stop (effectOf), a model's own part (a give-back grant) counted as none. */
const restoredAtStop = (own: number, credits: ReadonlyArray<ResetCredit>, resetIn: number) =>
  credits.filter(inHand).filter((credit) => credit.givesBack !== true).reduce((total, credit) =>
    total + credit.count * Option.match(Arr.findFirst(effectOf("claude", account(0.99, own, credits, resetIn), credit), (give) => give.window === "7d"), { onNone: () => 0, onSome: (week) => week.from - week.to }), 0)

test("planned capacity never exceeds what the login's own claims give back at the stop, nor runs where no claim can", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const next = mulberry(seed)
    const credits = inventory(next)
    const resetIn = Math.floor(next() * 7 * DAY)
    const own = Math.floor(next() * 101) / 100
    const subject = account(Math.floor(next() * 100) / 100, own, credits, resetIn)
    const other = account(0.2, 0.1, [{ ...weekly, count: 3 }], resetIn, "b")
    const extra = Option.getOrElse(extraOf(pacePlans("claude", [subject, other], [], now, [], true)), () => 0)
    const bound = Match.value(resetIn <= NATURAL_MS).pipe(Match.when(true, () => 0), Match.orElse(() => restoredAtStop(own, credits, resetIn)))
    expect({ seed, within: extra <= bound + 1e-9 }).toEqual({ seed, within: true })
    // Codex stock and an unapproved plan schedule nothing.
    expect({ seed, codex: pacePlans("codex", [subject], [], now, [], true), off: pacePlans("claude", [subject], [], now, [], false) }).toEqual({ seed, codex: {}, off: {} })
  }
})

test("with no reset in hand, or only resets that give no week back, the pace answers are those of a login holding none", () => {
  const MODELS = ["claude-opus-4-6", "claude-fable-5-2"]
  for (let seed = 1; seed <= 500; seed++) {
    const next = mulberry(seed)
    const resetIn = HOUR + Math.floor(next() * 7 * DAY)
    const held = inventory(next).filter((credit) => restoredAtStop(0, [credit], resetIn) === 0)
    const week = Math.floor(next() * 100) / 100
    const own = Math.floor(next() * 101) / 100
    const model = MODELS[Math.floor(next() * MODELS.length) % MODELS.length]
    const holding = account(week, own, held, resetIn)
    const bare = account(week, own, [], resetIn)
    const found = pacePlans("claude", [holding], [], now, [], true)
    expect({ seed, plans: found }).toStrictEqual({ seed, plans: pacePlans("claude", [bare], [], now, [], true) })
    expect({ seed, pace: poolPace([holding], now, NO_INFLIGHT, model, found) }).toStrictEqual({ seed, pace: poolPace([bare], now, NO_INFLIGHT, model, {}) })
  }
})
