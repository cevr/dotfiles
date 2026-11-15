// Spending resets on the pool's own (resets.ts, claim-rule.ts): properties
// over time, decided by the Resets aggregate as the sweep and a held pace
// review it. Nothing here is ever asked of the owner.
//
// - Use it or lose it: a reset that expires within a day is claimed on its
//   own, once: at once on a spent window, else at its last call, on the window
//   it gives back most of; never while that window resets by itself within 30
//   minutes. One expiring later is left without work to use it on. The owner
//   is told after.
// - Demand: a start held by a window the reset frees, with no fresh account
//   to take it, has a reset claimed when the work would spend at least half
//   of what it gives back before the window resets by itself: early in the
//   week, not late, and not with too little work.
// - A Fable reset empties Fable's own week and takes Fable's part of the
//   weekly use off the weekly window, whose reset stays.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { BURN_AGENTS, LAST_CALL_MS, NATURAL_MS, NOT_WORTH_MS, WORTH_SHARE } from "./claim-rule.ts"
import { lineOf, TARGET } from "./pace.ts"
import type { QuotaWindow, ResetCredit } from "./quota.ts"
import {
  type Command,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
  MIN_RESTORE,
  NoteWait,
  pacePlans,
  type PoolView,
  type Ratio,
  Resets,
  type ResetsState,
  Review,
  SettleClaim,
  shareOf,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const T0 = Date.parse("2026-11-09T12:00:00Z")

const run = (commands: ReadonlyArray<readonly [number, Command]>, state: ResetsState = Resets.initial) =>
  Effect.runSync(
    Effect.gen(function* () {
      let current = state
      const events: Array<Event> = []
      for (const [now, command] of commands) {
        const decided = yield* Resets.decide(current, command, now)
        events.push(...decided)
        current = fold(Resets, decided, current)
      }
      return { events, state: current }
    }),
  )

/** The tags of what changes state or the world: a pool weighed with no claim only logs. */
const tags = (events: ReadonlyArray<Event>) => events.flatMap((event) => [event._tag].filter((tag) => tag !== "ClaimWeighed"))

/** An account reading `windows`, with `credits`, both read at `at` (the usage endpoint's read, which lists the credits). */
const account = (credentialID: string, windows: ReadonlyArray<QuotaWindow>, credits: ReadonlyArray<ResetCredit> = [], at = T0): AccountStatus => ({
  credentialID,
  load: 0,
  live: 0,
  noRoom: false,
  reading: { at, windows, resets: { available: credits.filter((credit) => credit.usable).length, credits } },
})

const window = (name: string, utilization: number, resetAt: number): QuotaWindow => ({ name, utilization, resetAt })

/** A Claude grant of `kind`'s fields, usable now, expiring at `expiresAt`. */
const grant = (id: string, expiresAt: number, fields: Partial<ResetCredit> = {}): ResetCredit => ({
  id,
  count: 1,
  usable: true,
  expiresAt,
  requiresLimit: false,
  ...fields,
})
const WEEKLY: Partial<ResetCredit> = { clears: ["seven_day"], kind: "weekly" }
const SESSION: Partial<ResetCredit> = { clears: ["five_hour"], kind: "session" }
const FABLE: Partial<ResetCredit> = { clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }

const pool = (provider: "claude" | "codex", accounts: ReadonlyArray<AccountStatus>, ratios: Readonly<Record<string, Ratio>> = {}, inflight = 0): PoolView => ({
  id: provider === "claude" ? "anthropic" : "openai",
  provider,
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID])),
  ratios,
  inflight,
})

/** A fresh second account: work goes there, so only an expiring reset is claimed. */
const roomy = account("room", [window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)])

describe("use it or lose it", () => {
  test("over a grid of use, expiry and natural reset: claimed iff it expires within a day, gives some back, and the window is spent or it is the last call; never inside 30 minutes of the window's own reset", () => {
    for (const used of [0, 0.05, 0.3, 0.5, 0.9, 1])
      for (const expiresIn of [2 * HOUR, 20 * HOUR, 2 * DAY])
        for (const resetsIn of [20 * MINUTE, HOUR, 3 * DAY]) {
          const view = pool("claude", [account("a", [window("5h", 0.02, T0 + 4 * HOUR), window("7d", used, T0 + resetsIn)], [grant("g", T0 + expiresIn, WEEKLY)]), roomy])
          const { events } = run([[T0, Review.make({ pools: [view] })]])
          const due = expiresIn <= EXPIRING_MS && used >= MIN_RESTORE && (used >= 1 || expiresIn <= LAST_CALL_MS) && resetsIn > NATURAL_MS
          const label = `used ${used}, expires in ${expiresIn / HOUR} h, week resets in ${resetsIn / HOUR} h`
          expect(tags(events), label).toEqual(due ? ["ClaimDue"] : [])
          if (due) expect(events[0], label).toMatchObject({ _tag: "ClaimDue", reset: { key: expiringKey("claude", "a", "7d", T0 + resetsIn), why: "expiring", kind: "weekly", stage: "claiming" } })
        }
  })

  test("reviewed every ten minutes to its expiry, a useful reset is claimed once, at its last call; one that gives back too little never", () => {
    const expiresAt = T0 + 30 * HOUR
    // Its week 60% used: claimed at the last call, on the window it gives back most of.
    const useful = (now: number) => pool("claude", [account("a", [window("7d", 0.6, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)], now), roomy])
    // A 5-hour reset on a window that never holds more than 5%: nothing worth sending.
    const useless = (now: number) => pool("claude", [account("a", [window("5h", 0.05, now + 3 * HOUR), window("7d", 0.3, T0 + 3 * DAY)], [grant("g", expiresAt, SESSION)], now), roomy])
    for (const [view, wanted] of [
      [useful, [expiresAt - LAST_CALL_MS]],
      [useless, []],
    ] as const) {
      let state = Resets.initial
      const claimedAt: Array<number> = []
      for (let now = T0; now < expiresAt; now += 10 * MINUTE) {
        const step = run([[now, Review.make({ pools: [view(now)] })]], state)
        state = step.state
        // The model settles each claim it sends (a claim never settled would go again, as the same claim).
        for (const event of step.events)
          if (event._tag === "ClaimDue") {
            claimedAt.push(now)
            state = run([[now, SettleClaim.make({ key: event.reset.key, outcome: "reset", before: [] })]], state).state
          }
      }
      expect(claimedAt).toEqual([...wanted])
    }
  })

  test("a Codex credit too: its week spent, it is claimed with no start waiting", () => {
    const view = pool("codex", [account("c", [window("7d", 1, T0 + 2 * DAY)], [{ id: "credit", count: 1, usable: true, status: "available", expiresAt: T0 + 3 * HOUR }]), roomy])
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toMatchObject([{ _tag: "ClaimDue", reset: { key: expiringKey("codex", "c", "7d", T0 + 2 * DAY), kind: "codex" } }])
  })

  test("a reset not claimable now (it needs a limit, or is paused) is left", () => {
    const view = pool("claude", [account("a", [window("7d", 0.9, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, { ...WEEKLY, usable: false, requiresLimit: true })]), roomy])
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toEqual([])
  })

  test("once claimed the owner is told after, in the session that waited last, in the usage wording; a claim that did not go through tells no one", () => {
    const view = pool("claude", [account("a", [window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)]), roomy])
    const key = expiringKey("claude", "a", "7d", T0 + 3 * DAY)
    const claimed = run([
      [T0 - MINUTE, NoteWait.make({ pool: "openai", sessionID: "ses_old" })],
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view] })],
    ])
    const told = run([[T0 + MINUTE, SettleClaim.make({ key, outcome: "reset", before: [] })]], claimed.state)
    expect(tags(told.events)).toEqual(["ClaimSettled", "OwnerTold"])
    expect(told.events[1]).toMatchObject({
      key,
      sessionID: "ses_root",
      text: "Claimed the weekly reset on a: weekly 100% used of 100% → 0% used, next reset 2026-11-12 12:00Z (about to expire unused: it expires 2026-11-09 14:00Z, lost unused otherwise). No resets left this week.",
    })
    expect(told.state.resets[key]?.told).toStartWith("Claimed the weekly reset on a")
    expect(tags(run([[T0 + MINUTE, SettleClaim.make({ key, outcome: "cooldown", before: [] })]], claimed.state).events)).toEqual(["ClaimSettled"])
  })
})

describe("claimed on demand", () => {
  /** The pool's one account, its week `used` with `left` of it to run, two weekly resets in hand, `inflight` agents running. */
  const heldView = (left: number, used: number, inflight: number) =>
    pool("claude", [account("a", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", used, T0 + left)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, count: 2 })])], {}, inflight)

  test("over day of the week × work × use: claimed iff the week holds the start, it resets more than a day off, and the work would spend half of it back before then", () => {
    for (const leftDays of [0.5, 1, 2, 3, 5, 6.5])
      for (const inflight of [0, 1, 3, 6])
        for (const used of [0.5, 0.95, 1]) {
          const left = leftDays * DAY
          const { events } = run([
            [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root", hard: true })],
            [T0, Review.make({ pools: [heldView(left, used, inflight)] })],
          ])
          // The week's burn (its use over the time it ran), scaled to the work there (the held start and those running, over at least BURN_AGENTS), times the time left.
          const projected = Math.min(used, (used / (WEEK - left)) * ((1 + inflight) / Math.max(inflight, BURN_AGENTS)) * left)
          const claimed = used >= TARGET && left > NOT_WORTH_MS && projected >= WORTH_SHARE * used
          const label = `${leftDays} days left, ${inflight} running, used ${used}`
          expect(tags(events), label).toEqual(claimed ? ["WaitNoted", "ClaimDue"] : ["WaitNoted"])
          expect(events.some((event) => event._tag === "ClaimWeighed"), label).toBe(!claimed)
        }
  })

  test("a reset just claimed is claimed by no rule while the account's reading predates the claim", () => {
    // A Fable reset expiring in two hours on a spent Fable week: claimed on its own; the reading after it was taken before the claim settled.
    const stale = account(
      "a",
      [window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.6, T0 + 5 * DAY), { ...window("7d:Fable", 1, T0 + 5 * DAY), ofWeekly: 0.5 }],
      [grant("g", T0 + 2 * HOUR, { ...FABLE, count: 2 })],
    )
    const claimed = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [pool("claude", [stale, roomy])] })],
      [T0 + MINUTE, SettleClaim.make({ key: expiringKey("claude", "a", "7d:Fable", T0 + 5 * DAY), outcome: "reset", before: [] })],
    ])
    expect(tags(claimed.events)).toEqual(["WaitNoted", "ClaimDue", "ClaimSettled", "OwnerTold"])
    // The same stale reading, reviewed again with a start waiting: nothing.
    const again = run([[T0 + 2 * MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + 2 * MINUTE, Review.make({ pools: [pool("claude", [stale, roomy])] })]], claimed.state)
    expect(tags(again.events)).toEqual(["WaitNoted"])
  })

  test("no claim when a spent window it does not clear would still hold the start", () => {
    const fiveSpent = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, count: 2 })])], {}, 6)
    const weekSpent = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, { ...SESSION, count: 2 })])], {}, 6)
    for (const view of [fiveSpent, weekSpent]) {
      const { events } = run([[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0, Review.make({ pools: [view] })]])
      expect(tags(events)).toEqual(["WaitNoted"])
      expect(events.find((event) => event._tag === "ClaimWeighed")).toMatchObject({ step: "reset", reasons: ["a: it would not free the held work"] })
    }
  })
})

describe("a Fable reset", () => {
  const fableWeek = T0 + 6 * DAY
  const ratio: Ratio = { rate: 0.5, low: 0.4, high: 0.6, source: "tally" }
  const fable = (weekly: number, own: number, ofWeekly?: number) =>
    account(
      "a",
      [window("5h", 0.3, T0 + 3 * HOUR), window("7d", weekly, T0 + 6 * DAY), { ...window("7d:Fable", own, fableWeek), ...(ofWeekly === undefined ? {} : { ofWeekly }) }],
      [grant("g", T0 + 60 * DAY, { ...FABLE, count: 2 })],
    )

  test("empties Fable's week and the 5-hour window, and takes Fable's part off the weekly use, whose reset stays", () => {
    const gives = effectOf("claude", fable(0.8, 0.9), grant("g", T0 + 60 * DAY, FABLE), { "7d:Fable": ratio })
    expect(gives).toEqual([
      { window: "5h", from: 0.3, to: 0, resetAt: T0 + 3 * HOUR },
      { window: "7d:Fable", from: 0.9, to: 0, resetAt: fableWeek },
      { window: "7d", from: 0.8, to: 0.8 - 0.45, resetAt: T0 + 6 * DAY, share: { points: 0.45, low: 0.9 * 0.4, high: 0.9 * 0.6, source: "tally" } },
    ])
  })

  test("Fable's part as the usage endpoint reports it wins over any estimate, never more than the weekly use", () => {
    for (const reported of [0, 0.1, 0.4, 0.9])
      for (const weekly of [0.2, 0.6])
        expect(
          shareOf({ ...window("7d:Fable", 0.8, fableWeek), ofWeekly: 0.5, weeklyUsed: reported }, window("7d", weekly, fableWeek), { rate: 1, source: "tally" }),
        ).toEqual({ points: Math.min(reported, weekly), low: Math.min(reported, weekly), high: Math.min(reported, weekly), source: "reported" })
    // As measured on 2026-11-09: Fable's week 12% used took none of the weekly window, so a Fable reset gives the weekly nothing back.
    const measured = account(
      "a",
      [window("7d", 0.09, T0 + 6 * DAY), { ...window("7d:Fable", 0.12, fableWeek), ofWeekly: 0.5, weeklyUsed: 0 }],
      [grant("g", T0 + 60 * DAY, FABLE)],
    )
    const gives = effectOf("claude", measured, grant("g", T0 + 60 * DAY, FABLE))
    expect(gives.find((give) => give.window === "7d")).toMatchObject({ from: 0.09, to: 0.09, share: { points: 0, source: "reported" } })
  })

  test("Fable's part, as a property: ratio × its week's use, within the range, never more than the weekly use; the endpoint's share when the tally has none; else unread", () => {
    for (const own of [0, 0.25, 0.5, 1])
      for (const weekly of [0, 0.2, 0.6, 1])
        for (const rate of [0.25, 0.5, 1]) {
          const share = shareOf(window("7d:Fable", own, fableWeek), window("7d", weekly, fableWeek), { rate, low: rate * 0.8, high: rate * 1.2, source: "tally" })
          expect(share.points).toBeCloseTo(Math.min(rate * own, weekly))
          expect(share.low).toBeLessThanOrEqual(share.points + 1e-12)
          expect(share.high).toBeGreaterThanOrEqual(share.points - 1e-12)
          expect(share.high).toBeLessThanOrEqual(weekly + 1e-12)
        }
    expect(shareOf({ ...window("7d:Fable", 0.8, fableWeek), ofWeekly: 0.5 }, window("7d", 0.9, fableWeek), undefined)).toEqual({ points: 0.4, low: 0.4, high: 0.4, source: "api" })
    expect(shareOf(window("7d:Fable", 0.8, fableWeek), window("7d", 0.9, fableWeek), undefined)).toEqual({ points: 0, low: 0, high: 0, source: "unread" })
  })

  test("claimed early in Fable's week for a Fable start its spent week holds, saying what the weekly window gets back and how the part was estimated", () => {
    const view = pool("claude", [fable(0.6, 1)], { "7d:Fable": ratio }, 3)
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root", hard: true, model: "claude-fable-5-2" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(events[1]).toMatchObject({ _tag: "ClaimDue", reset: { kind: "fable", why: "held", key: expiringKey("claude", "a", "7d:Fable", fableWeek) } })
    const due = events[1]
    if (due?._tag !== "ClaimDue") throw new Error("not claimed")
    expect(due.reset.buys).toContain("Fable week 100% used of 100% → 0% used, next reset 2026-11-15 12:00Z, weekly 60% used of 100% → ~10% used, next reset 2026-11-15 12:00Z (Fable's part 50% of the week (40%–60%) by the limit tally)")
  })

  test("a start of another model, which Fable's week does not hold, takes the account: nothing claimed", () => {
    const view = pool("claude", [fable(0.6, 1)], { "7d:Fable": ratio }, 3)
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root", hard: true, model: "claude-opus-5-5" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted"])
  })
})

describe("the pace's line", () => {
  test("with no plan it is the even line; a reset in hand raises it by what it gives back, fading with the week; a claim starts it again from the claim", () => {
    const resetAt = T0 + 6 * DAY
    for (const elapsed of [0, 1, 3, 6.9]) {
      const now = resetAt - WEEK + elapsed * DAY
      expect(lineOf(resetAt, now, undefined)).toBeCloseTo(0.99 * (elapsed / 7) + 0.05)
      expect(lineOf(resetAt, now, { spare: 0.99 }) - lineOf(resetAt, now, undefined)).toBeCloseTo(0.99 * (1 - elapsed / 7))
    }
    // Spent on day one with a weekly reset in hand: within its line, so the first 100% may go fast.
    expect(lineOf(resetAt, resetAt - 6 * DAY, { spare: 0.99 })).toBeGreaterThan(1)
    // A claim on day one that left the week at 0: the line starts at 0 then, and spends the rest evenly to the reset.
    const claimAt = resetAt - 6 * DAY
    expect(lineOf(resetAt, claimAt, { rebase: { at: claimAt, from: 0 } })).toBeCloseTo(0.05)
    expect(lineOf(resetAt, claimAt + 3 * DAY, { rebase: { at: claimAt, from: 0 } })).toBeCloseTo(0.99 / 2 + 0.05)
  })

  test("plans: a claim this week re-bases its account; a Codex credit or a weekly grant in hand is a full spare, a Fable reset its part", () => {
    const resetAt = T0 + 6 * DAY
    const accounts = [
      account("weekly", [window("7d", 0.5, resetAt)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, usable: false, requiresLimit: true })]),
      account("fable", [window("7d", 0.5, resetAt), { ...window("7d:Fable", 0.5, resetAt), ofWeekly: 0.5 }], [grant("f", T0 + 60 * DAY, FABLE)]),
      account("session", [window("7d", 0.5, resetAt)], [grant("s", T0 + 60 * DAY, SESSION)]),
      account("claimed", [window("7d", 0.1, resetAt)]),
    ]
    const claims = [
      { key: "k", pool: "anthropic", provider: "claude" as const, credentialID: "claimed", label: "c", creditID: "g", requestID: "r", at: T0 - HOUR, outcome: "reset" as const, before: [], after: [window("7d", 0.05, resetAt)], weekly: "kept" as const },
      // Last week's claim does not move this week's line.
      { key: "old", pool: "anthropic", provider: "claude" as const, credentialID: "weekly", label: "w", creditID: "g", requestID: "r", at: resetAt - 8 * DAY, outcome: "reset" as const, before: [], after: [window("7d", 0, resetAt - 7 * DAY)], weekly: "kept" as const },
    ]
    expect(pacePlans("claude", accounts, claims, T0)).toEqual({ weekly: { spare: 0.99 }, fable: { spare: 0.5 }, claimed: { rebase: { at: T0 - HOUR, from: 0.05 } } })
  })
})
