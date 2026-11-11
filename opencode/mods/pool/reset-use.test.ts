// Using resets before they are lost, and offering them when demand makes them
// worth most (resets.ts): properties over time, decided by the Resets
// aggregate as the sweep and a held pace review it.
//
// - Use it or lose it: a usable reset is claimed on its own, once, when a
//   window it gives back cannot reset by itself before the reset expires and
//   that window is spent, or the reset is in its last day and gives back half
//   of it; a reset whose windows all reset before it expires is left. The
//   owner is told after.
// - Demand: with a start held, a reset is offered for a week-long window the
//   account has (nearly) spent when, at the account's burn this period, most
//   of the use given back would be spent before the window resets by itself:
//   early in the week, not late. Once per account, kind and window period;
//   withdrawn when no longer worth it.
// - A Fable reset empties Fable's own week and takes Fable's part of the
//   weekly use off the weekly window, whose reset stays.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { lineOf } from "./pace.ts"
import type { QuotaWindow, ResetCredit } from "./quota.ts"
import {
  ABOUT_SPENT,
  type Command,
  DEMAND_STARTS,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
  NoteWait,
  offerKey,
  pacePlans,
  type PoolView,
  type Ratio,
  Resets,
  type ResetsState,
  Review,
  SettleClaim,
  shareOf,
  TakeAnswer,
  WAIT_MS,
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

const tags = (events: ReadonlyArray<Event>) => events.map((event) => event._tag)

/** An account reading `windows`, with `credits`. */
const account = (credentialID: string, windows: ReadonlyArray<QuotaWindow>, credits: ReadonlyArray<ResetCredit> = []): AccountStatus => ({
  credentialID,
  load: 0,
  live: 0,
  noRoom: false,
  reading: { at: T0, windows, resets: { available: credits.filter((credit) => credit.usable).length, credits } },
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

/** A fresh second account, so the pool is never wholly held (that is the held start's question, not these rules). */
const roomy = account("room", [window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)])

describe("use it or lose it", () => {
  test("over a grid of use, expiry and natural reset: claimed iff the window outlives the reset and is spent, or half used in its last day", () => {
    for (const used of [0, 0.3, 0.5, 0.9, 1])
      for (const expiresIn of [2 * HOUR, 20 * HOUR, 2 * DAY])
        for (const resetsIn of [HOUR, 3 * DAY]) {
          const view = pool("claude", [account("a", [window("5h", 0.2, T0 + 30 * MINUTE), window("7d", used, T0 + resetsIn)], [grant("g", T0 + expiresIn, WEEKLY)]), roomy])
          const { events } = run([[T0, Review.make({ pools: [view] })]])
          const due = resetsIn > expiresIn && (used >= 1 || (expiresIn <= EXPIRING_MS && used >= 0.5))
          const label = `used ${used}, expires in ${expiresIn / HOUR} h, week resets in ${resetsIn / HOUR} h`
          expect(tags(events), label).toEqual(due ? ["ClaimDue"] : [])
          if (due) expect(events[0], label).toMatchObject({ _tag: "ClaimDue", reset: { key: expiringKey("anthropic", "g", "claude", 1), why: "expiring", kind: "weekly", stage: "claiming" } })
        }
  })

  test("reviewed every ten minutes to its expiry, a useful reset is claimed once, at its first chance; a useless one never", () => {
    const expiresAt = T0 + 30 * HOUR
    // Half used, its week resetting after the grant ends: claimed as the grant's last day begins.
    const useful = pool("claude", [account("a", [window("7d", 0.6, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)]), roomy])
    // A 5-hour grant whose window resets every few hours before the grant ends: never lost, so never claimed.
    const useless = pool("claude", [account("a", [window("5h", 0.95, T0 + 2 * HOUR), window("7d", 0.3, T0 + 3 * DAY)], [grant("g", expiresAt, SESSION)]), roomy])
    for (const [view, wanted] of [
      [useful, [expiresAt - EXPIRING_MS]],
      [useless, []],
    ] as const) {
      let state = Resets.initial
      const claimedAt: Array<number> = []
      for (let now = T0; now < expiresAt; now += 10 * MINUTE) {
        const step = run([[now, Review.make({ pools: [view] })]], state)
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

  test("a Codex credit too: its week spent and outliving the credit, it is claimed with no start waiting", () => {
    const view = pool("codex", [account("c", [window("7d", 1, T0 + 2 * DAY)], [{ id: "credit", count: 1, usable: true, status: "available", expiresAt: T0 + 3 * HOUR }]), roomy])
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toMatchObject([{ _tag: "ClaimDue", reset: { key: expiringKey("openai", "credit"), kind: "codex" } }])
  })

  test("a reset not claimable now (it needs a limit, or is paused) is left", () => {
    const view = pool("claude", [account("a", [window("7d", 0.9, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, { ...WEEKLY, usable: false, requiresLimit: true })]), roomy])
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toEqual([])
  })

  test("once claimed the owner is told after, in the session that waited last; a claim that did not go through tells no one", () => {
    const view = pool("claude", [account("a", [window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)]), roomy])
    const key = expiringKey("anthropic", "g", "claude", 1)
    const claimed = run([
      [T0 - MINUTE, NoteWait.make({ pool: "openai", sessionID: "ses_old" })],
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view] })],
    ])
    const told = run([[T0 + MINUTE, SettleClaim.make({ key, outcome: "reset", before: [] })]], claimed.state)
    expect(tags(told.events)).toEqual(["ClaimSettled", "OwnerTold"])
    expect(told.events[1]).toMatchObject({ key, sessionID: "ses_root", text: "The pool claimed the weekly reset on account a before it expired unused: it gave back weekly 100% → 0%." })
    expect(told.state.resets[key]?.told).toContain("before it expired unused")
    expect(tags(run([[T0 + MINUTE, SettleClaim.make({ key, outcome: "cooldown", before: [] })]], claimed.state).events)).toEqual(["ClaimSettled"])
  })
})

describe("offered on demand", () => {
  const offerView = (elapsedDays: number, used: number, inflight = 0, asker?: string) => ({
    ...pool(
      "claude",
      [account("a", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", used, T0 + WEEK - elapsedDays * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)]), roomy],
      {},
      inflight,
    ),
    ...(asker === undefined ? {} : { asker }),
  })

  test("over day of the week × demand × use: offered iff there is demand to ask in, the week is (nearly) spent, and its burn would spend most of it back before the reset", () => {
    // Demand: a held start from a session, or DEMAND_STARTS starts in flight across the fleet with a session that asked lately.
    const demands = {
      none: { waits: [], inflight: 0, asker: undefined, offered: false },
      "held, no session": { waits: [NoteWait.make({ pool: "anthropic" })], inflight: 0, asker: undefined, offered: false },
      held: { waits: [NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], inflight: 0, asker: undefined, offered: true },
      "few in flight": { waits: [], inflight: DEMAND_STARTS - 1, asker: "ses_root", offered: false },
      "in flight, no asker": { waits: [], inflight: DEMAND_STARTS, asker: undefined, offered: false },
      "in flight": { waits: [], inflight: DEMAND_STARTS, asker: "ses_root", offered: true },
    } as const
    for (const elapsedDays of [0.5, 1, 3, 4.5, 5, 6.5])
      for (const [name, demand] of Object.entries(demands))
        for (const used of [0.5, ABOUT_SPENT, 1]) {
          const { events } = run([
            ...demand.waits.map((wait) => [T0, wait] as const),
            [T0, Review.make({ pools: [offerView(elapsedDays, used, demand.inflight, demand.asker)] })],
          ])
          // The burn this week (used / elapsed) times the days left, against the use given back: at least half of it.
          const left = 7 - elapsedDays
          const offered = demand.offered && used >= ABOUT_SPENT && Math.min(used, (used / elapsedDays) * left) >= 0.5 * used
          const label = `day ${elapsedDays}, demand ${name}, used ${used}`
          expect(events.filter((event) => event._tag === "OwnerAsked").length, label).toBe(offered ? 1 : 0)
          expect(events.some((event) => event._tag === "ClaimDue"), label).toBe(false)
        }
  })

  test("the question shows the demand, what it gives back, the days left, the use expected before the natural reset, and its expiry", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [offerView(1, 1, 3)] })],
    ])
    expect(events[1]).toMatchObject({
      _tag: "OwnerAsked",
      reset: {
        why: "offer",
        sessionID: "ses_root",
        header: "Reset now · a",
        key: offerKey("claude", "anthropic", "a", "weekly", "7d", T0 + 6 * DAY),
        question:
          "weekly reset on account a now? Demand: a start is held and 3 starts are in flight across the fleet. It gives back weekly 100% → 0%. " +
          "6.0 days remain before the weekly window resets by itself (2026-11-15), which a claim does not move; " +
          "at its burn this period (100% in 1.0 days) ~100% of the 100% given back would be used by then. The reset expires 2027-01-08. Claim it?",
      },
    })
  })

  test("asked once per account, kind and window period; a no is kept; withdrawn once late in the week it is no longer worth it", () => {
    const asked = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [offerView(1, 1)] })],
      [T0 + MINUTE, Review.make({ pools: [offerView(1, 1)] })],
    ])
    expect(tags(asked.events)).toEqual(["WaitNoted", "OwnerAsked"])
    const key = offerKey("claude", "anthropic", "a", "weekly", "7d", T0 + 6 * DAY)
    // A no: the same account, kind and window period is not asked again, however long a start waits.
    let declined = run([[T0 + 2 * MINUTE, TakeAnswer.make({ key, answer: "Don't claim" })]], asked.state)
    for (let now = T0 + HOUR; now < T0 + 2 * DAY; now += HOUR) {
      const step = run([[now, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [now, Review.make({ pools: [offerView(1, 1)] })]], declined.state)
      expect(step.events.filter((event) => event._tag === "OwnerAsked")).toEqual([])
      declined = step
    }
    // Unanswered, it is withdrawn when the week is late enough that the use given back would not be spent.
    const late = run([[T0 + 4 * DAY, Review.make({ pools: [offerView(5, 1)] })]], asked.state)
    expect(late.events).toEqual([{ _tag: "AskWithdrawn", key, at: T0 + 4 * DAY, why: "no longer worth it" }])
    // A yes claims it.
    expect(run([[T0 + 2 * MINUTE, TakeAnswer.make({ key, answer: "Claim it" })]], asked.state).events).toMatchObject([{ _tag: "ClaimDue", reset: { key, why: "offer" } }])
  })

  test("a reset just claimed is offered or claimed by no rule while the account's reading predates the claim", () => {
    // A Fable reset expiring in two hours on a spent Fable week: claimed on its own; the reading after it was taken before the claim settled.
    const reading = () =>
      account(
        "a",
        [window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.6, T0 + 5 * DAY), { ...window("7d:Fable", 1, T0 + 5 * DAY), ofWeekly: 0.5 }],
        [grant("g", T0 + 2 * HOUR, FABLE)],
      )
    const stale = (at: number) => {
      const item = reading()
      return { ...item, reading: { ...item.reading!, at } }
    }
    const claimed = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [pool("claude", [stale(T0), roomy])] })],
      [T0 + MINUTE, SettleClaim.make({ key: expiringKey("anthropic", "g", "claude", 1), outcome: "reset", before: [] })],
    ])
    expect(tags(claimed.events)).toEqual(["WaitNoted", "ClaimDue", "ClaimSettled", "OwnerTold"])
    // The same stale reading, reviewed again with a start waiting: no offer of the grant just claimed.
    expect(run([[T0 + 2 * MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + 2 * MINUTE, Review.make({ pools: [pool("claude", [stale(T0), roomy])] })]], claimed.state).events).toEqual([
      { _tag: "WaitNoted", pool: "anthropic", wait: { at: T0 + 2 * MINUTE, sessionID: "ses_root" } },
    ])
  })

  test("no offer when a spent window it does not clear would still hold the account, or for the 5-hour window alone", () => {
    const fiveSpent = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)]), roomy])
    const session = pool("claude", [account("a", [window("5h", 1, T0 + 3 * HOUR), window("7d", 0.3, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, SESSION)]), roomy])
    for (const view of [fiveSpent, session])
      expect(tags(run([[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0, Review.make({ pools: [view] })]]).events)).toEqual(["WaitNoted"])
  })

  test("one question per pool: every account held asks the held start's question alone, and an open offer waits for its answer", () => {
    // The pool's only account is held by its spent week: the held start's question, not an offer beside it.
    const held = pool("claude", [account("a", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)])])
    const asked = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [held] })],
    ])
    expect(asked.events.filter((event) => event._tag === "OwnerAsked").map((event) => event._tag === "OwnerAsked" && event.reset.why)).toEqual(["held"])
    // An offer open: another account's offer waits, and with no start waiting none is made.
    const two = pool("claude", [
      account("a", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", 1, T0 + 6 * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)]),
      account("b", [window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("h", T0 + 60 * DAY, WEEKLY)]),
      roomy,
    ])
    const first = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [two] })],
    ])
    expect(first.events.filter((event) => event._tag === "OwnerAsked")).toHaveLength(1)
    expect(run([[T0 + MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + MINUTE, Review.make({ pools: [two] })]], first.state).events).toHaveLength(1)
    expect(run([[T0 + WAIT_MS, Review.make({ pools: [two] })]], first.state).events).toEqual([])
  })
})

describe("a Fable reset", () => {
  const fableWeek = T0 + 6 * DAY
  const ratio: Ratio = { rate: 0.5, low: 0.4, high: 0.6, source: "tally" }
  const fable = (weekly: number, own: number, ofWeekly?: number) =>
    account(
      "a",
      [window("5h", 0.3, T0 + 3 * HOUR), window("7d", weekly, T0 + 6 * DAY), { ...window("7d:Fable", own, fableWeek), ...(ofWeekly === undefined ? {} : { ofWeekly }) }],
      [grant("g", T0 + 60 * DAY, FABLE)],
    )

  test("empties Fable's week and the 5-hour window, and takes Fable's part off the weekly use, whose reset stays", () => {
    const gives = effectOf("claude", fable(0.8, 0.9), grant("g", T0 + 60 * DAY, FABLE), { "7d:Fable": ratio })
    expect(gives).toEqual([
      { window: "5h", from: 0.3, to: 0, resetAt: T0 + 3 * HOUR },
      { window: "7d:Fable", from: 0.9, to: 0, resetAt: fableWeek },
      { window: "7d", from: 0.8, to: 0.8 - 0.45, resetAt: T0 + 6 * DAY, share: { points: 0.45, low: 0.9 * 0.4, high: 0.9 * 0.6, source: "tally" } },
    ])
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

  test("offered early in Fable's week when it is spent, and the question says what the weekly window gets back and how the part was estimated", () => {
    const view = pool("claude", [fable(0.6, 1), roomy], { "7d:Fable": ratio })
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(events[1]).toMatchObject({ _tag: "OwnerAsked", reset: { kind: "fable", key: offerKey("claude", "anthropic", "a", "fable", "7d:Fable", fableWeek) } })
    const asked = events[1]
    if (asked?._tag !== "OwnerAsked") throw new Error("not asked")
    expect(asked.reset.question).toContain("Fable reset on account a now?")
    expect(asked.reset.question).toContain("Fable week 100% → 0%, weekly 60% → ~10% (Fable's part 50% (40%–60%) by the limit tally)")
    expect(asked.reset.question).toContain("before the Fable week resets by itself")
  })

  test("helps the shared week too: with Fable's week only half used, a weekly window Fable spent is offered back", () => {
    const view = pool("claude", [fable(0.95, 0.6), roomy], { "7d:Fable": { rate: 1, source: "tally" } })
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(events[1]).toMatchObject({ _tag: "OwnerAsked", reset: { key: offerKey("claude", "anthropic", "a", "fable", "7d", T0 + 6 * DAY) } })
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
