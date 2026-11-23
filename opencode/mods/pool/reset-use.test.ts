// Spending resets on the pool's own (resets.ts, claim-rule.ts): properties
// over time, decided by the Resets aggregate as the sweep and a held pace
// review it. Nothing here is ever asked of the owner.
//
// - Use it or lose it: a reset that expires within a day is claimed on its
//   own, once, whatever it gives back: at once on a spent window, else at its
//   last call, on the window it gives back most of; never while that window
//   resets by itself within 30 minutes. One expiring later is left without
//   work to use it on. The owner is told after.
// - Demand is a forecast: the pool's burn, scaled by any start held, runs its
//   room out before the window resets by itself; a reset goes on the account
//   near its limit when it frees the account and the work would spend at
//   least half of what it gives back before then: early in the week, not
//   late, and not with too little work.
// - A Fable reset empties Fable's own week and takes Fable's part of the
//   weekly use off the weekly window, whose reset stays.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { BURN_AGENTS, LAST_CALL_MS, NATURAL_MS, NEAR_MS, NEAR_USED, NOT_WORTH_MS, WORTH_SHARE } from "./claim-rule.ts"
import { lineOf } from "./pace.ts"
import type { QuotaWindow, ResetCredit } from "./quota.ts"
import {
  type Claim,
  type Command,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
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
  running: inflight,
})

/** A fresh second account: work goes there, so only an expiring reset is claimed. */
const roomy = account("room", [window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)])

describe("use it or lose it", () => {
  test("over a grid of use, expiry and natural reset: claimed iff it expires within a day and the window it gives back most of is spent or it is the last call, on anything it gives back; never inside 30 minutes of that window's own reset", () => {
    for (const used of [0, 0.05, 0.3, 0.5, 0.9, 1])
      for (const expiresIn of [2 * HOUR, 20 * HOUR, 2 * DAY])
        for (const resetsIn of [20 * MINUTE, HOUR, 3 * DAY]) {
          const view = pool("claude", [account("a", [window("5h", 0.02, T0 + 4 * HOUR), window("7d", used, T0 + resetsIn)], [grant("g", T0 + expiresIn, WEEKLY)]), roomy])
          const { events } = run([[T0, Review.make({ pools: [view] })]])
          const due = expiresIn <= EXPIRING_MS && used > 0 && (used >= 1 || expiresIn <= LAST_CALL_MS) && resetsIn > NATURAL_MS
          const label = `used ${used}, expires in ${expiresIn / HOUR} h, week resets in ${resetsIn / HOUR} h`
          expect(tags(events), label).toEqual(due ? ["ClaimDue"] : [])
          if (due) expect(events[0], label).toMatchObject({ _tag: "ClaimDue", reset: { key: expiringKey("claude", "a", "7d", T0 + resetsIn), why: "expiring", kind: "weekly", stage: "claiming" } })
        }
  })

  test("reviewed every ten minutes to its expiry, a reset is claimed once, at its last call, however little it gives back", () => {
    const expiresAt = T0 + 30 * HOUR
    // Its week 60% used: claimed at the last call, on the window it gives back most of.
    // Once claimed the reset is no longer listed.
    const useful = (now: number, claimed: boolean) => pool("claude", [account("a", [window("7d", 0.6, T0 + 3 * DAY)], Arr.filter([grant("g", expiresAt, WEEKLY)], () => !claimed), now), roomy])
    // A 5-hour reset on a window that never holds more than 5%: lost otherwise, so it goes too.
    const useless = (now: number, claimed: boolean) =>
      pool("claude", [account("a", [window("5h", 0.05, now + 3 * HOUR), window("7d", 0.3, T0 + 3 * DAY)], Arr.filter([grant("g", expiresAt, SESSION)], () => !claimed), now), roomy])
    for (const [view, wanted] of [
      [useful, [expiresAt - LAST_CALL_MS]],
      [useless, [expiresAt - LAST_CALL_MS]],
    ] as const) {
      let state = Resets.initial
      const claimedAt: Array<number> = []
      for (let now = T0; now < expiresAt; now += 10 * MINUTE) {
        const step = run([[now, Review.make({ pools: [view(now, claimedAt.length > 0)] })]], state)
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

/**
 * Whether the rule claims for one account's week `used` with `left` of it to
 * run, `running` agents and `held` starts: the week's burn (its use over the
 * time it ran, five minutes at least), scaled by the held starts (over at
 * least BURN_AGENTS running), runs the room out before the reset, more than
 * a day off, on an account near its limit, and the work would spend half of
 * what the claim gives back before then.
 */
const WAITED: ReadonlyArray<"WaitNoted"> = ["WaitNoted"]
const DUE: ReadonlyArray<"ClaimDue"> = ["ClaimDue"]

const forecastClaims = (left: number, used: number, running: number, held: number) => {
  const burn = (used / Math.max(WEEK - left, HOUR / 12)) * HOUR * (1 + held / Math.max(running, BURN_AGENTS))
  const runsOut = (running > 0 || held > 0) && (used >= 1 || ((1 - used) / burn) * HOUR < left)
  const near = used >= NEAR_USED || ((1 - used) / burn) * HOUR <= NEAR_MS
  const pays = Math.min(used, (burn * left) / HOUR) >= WORTH_SHARE * used
  return runsOut && left > NOT_WORTH_MS && near && pays
}

describe("claimed on demand", () => {
  /** The pool's one account, its week `used` with `left` of it to run, two weekly resets in hand, `inflight` agents running. */
  const heldView = (left: number, used: number, inflight: number) =>
    pool("claude", [account("a", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", used, T0 + left)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, count: 2 })])], {}, inflight)

  test("over day of the week × work × use: claimed iff the forecast runs the week out before it resets, more than a day off, on an account near its limit, and the work would spend half of it back before then", () => {
    for (const leftDays of [0.5, 1, 2, 3, 5, 6.5])
      for (const inflight of [0, 1, 3, 6])
        for (const used of [0.3, 0.5, 0.9, 0.95, 1])
          for (const held of [false, true]) {
            const left = leftDays * DAY
            const waits = Arr.filter([[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root", hard: true })] as const], () => held)
            const { events } = run([...waits, [T0, Review.make({ pools: [heldView(left, used, inflight)] })]])
            const claimed = forecastClaims(left, used, inflight, Number(held))
            const label = `${leftDays} days left, ${inflight} running, used ${used}, held ${held}`
            expect(tags(events), label).toEqual([...Arr.filter(WAITED, () => held), ...Arr.filter(DUE, () => claimed)])
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

  test("no claim when a spent window it does not clear would still hold the account", () => {
    const fiveSpent = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, count: 2 })])], {}, 6)
    const weekSpent = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, { ...SESSION, count: 2 })])], {}, 6)
    for (const view of [fiveSpent, weekSpent]) {
      const { events } = run([[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0, Review.make({ pools: [view] })]])
      expect(tags(events)).toEqual(["WaitNoted"])
      expect(events.find((event) => event._tag === "ClaimWeighed")).toMatchObject({ step: "reset", reasons: ["a: it would not free the account, another spent window still holds it"] })
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
    expect(events[1]).toMatchObject({ reset: { kind: "fable", why: "forecast", key: expiringKey("claude", "a", "7d:Fable", fableWeek) } })
    const due = events[1]
    if (due?._tag !== "ClaimDue") throw new Error("not claimed")
    expect(due.reset.buys).toContain("Fable week 100% used of 100% → 0% used, next reset 2026-11-15 12:00Z, weekly 60% used of 100% → ~10% used, next reset 2026-11-15 12:00Z (Fable's part 50% of the week (40%–60%) by the limit tally)")
  })

  /**
   * An Opus start held by the shared week (100%) on an account whose Fable
   * week took `points` of it: the Fable reset is judged on the week it gives
   * back, and claimed when what it surely gives back frees the week.
   */
  const sharedHeld = (own: number, fields: Partial<QuotaWindow>, credit: Partial<ResetCredit> = FABLE, five = 0.3) =>
    run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root", hard: true, model: "claude-opus-5-5" })],
      [
        T0,
        Review.make({
          pools: [
            pool(
              "claude",
              [account("a", [window("5h", five, T0 + 3 * HOUR), window("7d", 1, T0 + 3.5 * DAY), { ...window("7d:Fable", own, T0 + 3.5 * DAY), ...fields }], [grant("g", T0 + 60 * DAY, credit)])],
              {},
              3,
            ),
          ],
        }),
      ],
    ])

  test("held by the shared week, a Fable reset is judged on the week it surely gives back: the owner's 68% Fable week, 34 shared points, claimed once", () => {
    for (const [own, points] of [[0.6, 0.3], [0.68, 0.34]] as const) {
      const { events } = sharedHeld(own, { ofWeekly: 0.5, weeklyUsed: points })
      expect(tags(events), `Fable ${own}`).toEqual(["WaitNoted", "ClaimDue"])
      expect(events[1], `Fable ${own}`).toMatchObject({ reset: { kind: "fable", why: "forecast", key: expiringKey("claude", "a", "7d", T0 + 3.5 * DAY) } })
    }
  })

  test("held by the shared week, no claim on a Fable part only estimated from its allowance share, unread, or too small to free the week", () => {
    for (const [label, fields] of [
      ["allowance share alone", { ofWeekly: 0.5 }],
      ["unread", {}],
      ["reported too small", { ofWeekly: 0.5, weeklyUsed: 0.002 }],
    ] as const) {
      const { events } = sharedHeld(0.6, fields)
      expect(tags(events), label).toEqual(["WaitNoted"])
    }
  })

  test("held by the shared week and a spent 5-hour window it does not clear, a Fable reset frees nothing and is not claimed", () => {
    const { events } = sharedHeld(0.6, { ofWeekly: 0.5, weeklyUsed: 0.3 }, { clears: ["seven_day_overage_included"], kind: "fable", givesBack: true }, 1)
    expect(tags(events)).toEqual(["WaitNoted"])
    expect(events.find((event) => event._tag === "ClaimWeighed")).toMatchObject({ reasons: ["a: it would not free the account, another spent window still holds it"] })
  })
})

describe("the pace's line", () => {
  test("with no plan it is the even line; a claim starts it again from the week observed after the claim", () => {
    const resetAt = T0 + 6 * DAY
    for (const elapsed of [0, 1, 3, 6.9]) {
      const now = resetAt - WEEK + elapsed * DAY
      expect(lineOf(resetAt, now, undefined)).toBeCloseTo(0.99 * (elapsed / 7) + 0.05)
      expect(lineOf(resetAt, now, {})).toBeCloseTo(0.99 * (elapsed / 7) + 0.05)
    }
    // A claim on day one that left the week at 0: the line starts at 0 then, and spends the rest evenly to the reset.
    const claimAt = resetAt - 6 * DAY
    expect(lineOf(resetAt, claimAt, { rebase: { at: claimAt, from: 0 } })).toBeCloseTo(0.05)
    expect(lineOf(resetAt, claimAt + 3 * DAY, { rebase: { at: claimAt, from: 0 } })).toBeCloseTo(0.99 / 2 + 0.05)
  })

  test("plans: a reset in hand moves no line; only a claim its own readings observed giving back the week re-bases its account", () => {
    const resetAt = T0 + 6 * DAY
    const accounts = [
      account("weekly", [window("7d", 0.5, resetAt)], [grant("g", T0 + 60 * DAY, { ...WEEKLY, usable: false, requiresLimit: true })]),
      account("fable", [window("7d", 0.5, resetAt), { ...window("7d:Fable", 0.5, resetAt), ofWeekly: 0.5 }], [grant("f", T0 + 60 * DAY, FABLE)]),
      account("session", [window("7d", 0.5, resetAt)], [grant("s", T0 + 60 * DAY, SESSION)]),
      account("claimed", [window("7d", 0.1, resetAt)]),
      account("redeemed", [window("7d", 0.9, resetAt)]),
      account("stale", [window("7d", 0.9, resetAt)]),
      account("late", [window("7d", 0.4, resetAt)]),
    ]
    const claim = (credentialID: string, fields: Partial<Claim> = {}): Claim => ({
      key: `k-${credentialID}`,
      pool: "anthropic",
      provider: "claude",
      credentialID,
      label: credentialID,
      creditID: "g",
      requestID: "r",
      at: T0 - HOUR,
      outcome: "reset",
      before: [window("7d", 1, resetAt)],
      after: [window("7d", 0.05, resetAt)],
      weekly: "kept",
      ...fields,
    })
    /** A claim whose reading after it could not be taken. */
    const unread = ({ after: _after, ...rest }: Claim): Claim => rest
    const claims = [
      claim("claimed"),
      // Last week's claim does not move this week's line.
      claim("weekly", { at: resetAt - 8 * DAY, before: [window("7d", 1, resetAt - 7 * DAY)], after: [window("7d", 0, resetAt - 7 * DAY)] }),
      // A 5-hour reset left the week as it was: no give-back observed, no rebase.
      claim("session", { before: [window("5h", 1, T0), window("7d", 0.5, resetAt)], after: [window("5h", 0, T0), window("7d", 0.5, resetAt)] }),
      // Already redeemed: no send of this claim's own went through, so a lower week around it (another actor's refund) is not its room.
      claim("redeemed", { outcome: "already-redeemed" }),
      // The reading after was carried over from an older one (a 429 after the claim): unread, no rebase.
      claim("stale", { after: [{ ...window("7d", 0.3, resetAt), at: T0 - 2 * HOUR }] }),
      // A claim that failed gives nothing back, whatever a reading after it shows.
      claim("fable", { outcome: "failed" }),
      // Its reading right after was unread; the first one taken later (`observed`) is its observation.
      unread(claim("late", { observed: [window("7d", 0.3, resetAt)] })),
    ]
    // Two requests admitted on the claimed room so far: their shares count on it until a reading shows them.
    const spends = [0.04, 0.04].map((cost, index) => ({ id: `s${index}`, claim: "k-claimed", credentialID: "claimed", at: T0, cost }))
    expect(pacePlans("claude", accounts, claims, T0, spends)).toEqual({
      claimed: { rebase: { at: T0 - HOUR, from: 0.05, key: "k-claimed", spent: 0.08 } },
      late: { rebase: { at: T0 - HOUR, from: 0.3, key: "k-late", spent: 0 } },
    })
  })
})
