// A push (push.ts) as its aggregates decide it: the Pushes aggregate starts
// and ends pushes; the Resets aggregate spends a push's approved
// resets (resets.ts `pushDue`), by value, one at a time, in its scope only;
// the plan and the use-or-lose forecast are measured from the readings; and
// an account's line counts every reset in hand that would expire before it
// are reported individually with their expiry and cadence.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  EndPush,
  forecastOf,
  forecastText,
  grantOf,
  MAX_PUSH_MS,
  planOf,
  planText,
  type Push,
  Pushes,
  type PushState,
  StartPush,
  Tick,
} from "./push.ts"
import type { QuotaWindow, ResetCredit } from "./quota.ts"
import {
  type Command,
  type Event,
  NoteWait,
  type PoolView,
  pushKey,
  pushUsed,
  Resets,
  type ResetsState,
  Review,
  SettleClaim,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-11T12:00:00Z")

const decide = <S, C, E>(decider: { decide: (s: S, c: C, n: number) => Effect.Effect<ReadonlyArray<E>>; evolve: (s: S, e: E) => S }) =>
  (commands: ReadonlyArray<readonly [number, C]>, state: S) =>
    Effect.runSync(
      Effect.gen(function* () {
        let current = state
        const events: Array<E> = []
        for (const [now, command] of commands) {
          const decided = yield* decider.decide(current, command, now)
          events.push(...decided)
          current = decided.reduce(decider.evolve, current)
        }
        return { events, state: current }
      }),
    )
const pushes = (commands: ReadonlyArray<readonly [number, Parameters<typeof Pushes.decide>[1]]>, state: PushState = Pushes.initial) =>
  decide(Pushes)(commands, state)
const resets = (commands: ReadonlyArray<readonly [number, Command]>, state: ResetsState = Resets.initial) => decide<ResetsState, Command, Event>(Resets)(commands, state)

const window = (name: string, utilization: number, resetAt: number): QuotaWindow => ({ name, utilization, resetAt })
const grant = (id: string, expiresAt: number, fields: Partial<ResetCredit> = {}): ResetCredit => ({ id, count: 1, usable: true, expiresAt, requiresLimit: false, ...fields })
const WEEKLY: Partial<ResetCredit> = { clears: ["seven_day"], kind: "weekly" }
const FULL: Partial<ResetCredit> = { clears: ["five_hour", "seven_day"], kind: "full" }
const SESSION: Partial<ResetCredit> = { clears: ["five_hour"], kind: "session" }
const FABLE: Partial<ResetCredit> = { clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }

const account = (credentialID: string, windows: ReadonlyArray<QuotaWindow>, credits: ReadonlyArray<ResetCredit> = [], at = T0): AccountStatus => ({
  credentialID,
  load: 0,
  live: 0,
  noRoom: false,
  reading: { at, windows, resets: { available: credits.length, credits } },
})
const pool = (accounts: ReadonlyArray<AccountStatus>): PoolView => ({
  id: "anthropic",
  provider: "claude",
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID.toUpperCase()])),
})

/** Both windows spent, the week resetting in `weekIn`. */
const spent = (id: string, credits: ReadonlyArray<ResetCredit>, weekIn = 4 * DAY) => account(id, [window("5h", 1, T0 + 2 * HOUR), window("7d", 1, T0 + weekIn)], credits)

const push = (fields: Partial<Push> = {}): Push => ({
  id: "push-1",
  goal: "ergo",
  scope: { host: "workbox" },
  startedAt: T0,
  endsAt: T0 + DAY,
  untilDone: false,
  allowance: { max: 2, asNeeded: false },
  by: "asked",
  ...fields,
})

describe("the Pushes aggregate", () => {
  test("a push ends at its end, or a week on when it runs until the work is done; one of the same scope gives way", () => {
    const scope = { host: "workbox" }
    const { events, state } = pushes([
      [T0, StartPush.make({ goal: "ergo", scope, allowance: { max: 2, asNeeded: false }, by: "asked" })],
      [T0 + MINUTE, StartPush.make({ goal: "ergo, again", scope, endsAt: T0 + 30 * DAY, allowance: { max: 1, asNeeded: true }, by: "asked" })],
    ])
    expect(events.map((event) => event._tag)).toEqual(["PushStarted", "PushEnded", "PushStarted"])
    const [only] = Object.values(state.pushes)
    expect(only).toMatchObject({ goal: "ergo, again", untilDone: false, endsAt: T0 + MINUTE + MAX_PUSH_MS })
    const first = events[0]!._tag === "PushStarted" ? events[0]!.push : undefined
    expect(first).toMatchObject({ untilDone: true, endsAt: T0 + MAX_PUSH_MS })
  })

  test("time and a closed run end a push, and nothing of it is kept", () => {
    const start = pushes([
      [T0, StartPush.make({ goal: "a", scope: { host: "mac", sessionID: "ses_0", run: "ergo" }, allowance: { max: 1, asNeeded: false }, by: "asked" })],
      [T0, StartPush.make({ goal: "b", scope: { host: "mac", sessionID: "ses_1" }, endsAt: T0 + HOUR, allowance: { max: 1, asNeeded: false }, by: "asked" })],
    ])
    const early = pushes([[T0 + 30 * MINUTE, Tick.make({ closedRuns: [] })]], start.state)
    expect(early.events).toEqual([])
    const later = pushes([[T0 + HOUR, Tick.make({ closedRuns: [] })]], start.state)
    expect(Object.values(later.state.pushes).map((item) => item.goal)).toEqual(["a"])
    const closed = pushes([[T0 + 2 * HOUR, Tick.make({ closedRuns: ["ergo"] })]], later.state)
    expect(closed.state.pushes).toEqual({})
    expect(closed.events).toMatchObject([{ _tag: "PushEnded", why: "its run ergo closed" }])
  })

  test("ending a push that is not on changes nothing", () => {
    expect(pushes([[T0 + 2 * HOUR, EndPush.make({ id: "nope", why: "x" })]], Pushes.initial).events).toEqual([])
  })
})

describe("a push's resets", () => {
  const grantFor = (fields: Partial<Push> = {}) => grantOf(push(fields))
  const waitThen = (view: PoolView, wait: Partial<NoteWait>, reviewed = [grantFor()]) =>
    resets([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_child", ...wait })],
      [T0 + MINUTE, Review.make({ pools: [view], pushes: reviewed })],
    ])

  test("a start held for lack of quota in the push's scope has its best reset claimed, as an asked claim; outside the scope, or held softly, nothing", () => {
    const view = pool([spent("a", [grant("g-a", T0 + 30 * DAY, WEEKLY)]), spent("b", [grant("g-b", T0 + 30 * DAY, FULL)], 6 * DAY)])
    const held = waitThen(view, { hard: true, root: "ses_root" })
    const due = held.events.filter((event) => event._tag === "ClaimDue")
    // The full reset clears both windows, and its account has the most days left: it frees the start.
    expect(due).toMatchObject([{ reset: { why: "push", yes: true, push: "push-1", credentialID: "b", creditID: "g-b", stage: "claiming" } }])
    // A weekly reset alone leaves a's spent 5-hour window holding the start: not a candidate.
    expect(waitThen(pool([spent("a", [grant("g-a", T0 + 30 * DAY, WEEKLY)])]), { hard: true }).events.some((event) => event._tag === "ClaimDue")).toBe(false)
    // Another session's tree: the push does not cover it; the standing allowance's rule decides (here every account is spent with a start held: the pool has run out), not as the push's, and asks nothing.
    const elsewhere = waitThen(view, { hard: true, root: "ses_other" }, [grantFor({ scope: { host: "workbox", sessionID: "ses_root" } })])
    expect(elsewhere.events.map((event) => event._tag)).toEqual(["WaitNoted", "ClaimDue"])
    expect(elsewhere.events[1]).toMatchObject({ reset: { why: "forecast" } })
    // The spend-evenly target alone is no lack of quota for a push of a session's tree.
    const scoped = [grantFor({ scope: { host: "workbox", sessionID: "ses_root" } })]
    expect(waitThen(view, { root: "ses_root" }, scoped).events.some((event) => event._tag === "ClaimDue")).toBe(false)
    expect(waitThen(view, { hard: true, root: "ses_root" }, scoped).events.some((event) => event._tag === "ClaimDue")).toBe(true)
  })

  test("one claim at a time, and never past the resets the owner approved", () => {
    const view = pool([spent("a", [grant("g-a", T0 + 30 * DAY, FULL)]), spent("b", [grant("g-b", T0 + 30 * DAY, FULL)])])
    const one = waitThen(view, { hard: true }, [grantFor({ allowance: { max: 1, asNeeded: true } })])
    const claimed = one.events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset] : []))
    expect(claimed).toHaveLength(1)
    // In flight: no second claim.
    const again = resets([[T0 + 2 * MINUTE, Review.make({ pools: [view], pushes: [grantFor({ allowance: { max: 1, asNeeded: true } })] })]], one.state)
    expect(again.events.some((event) => event._tag === "ClaimDue")).toBe(false)
    // Settled: the push has spent its one reset, so the standing allowance's rule decides for the next held start.
    const settled = resets([[T0 + 3 * MINUTE, SettleClaim.make({ key: claimed[0]!.key, outcome: "reset", before: [] })]], one.state)
    expect(pushUsed(settled.state, "push-1")).toHaveLength(1)
    const later = resets(
      [
        [T0 + 20 * MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_child", hard: true })],
        [T0 + 20 * MINUTE, Review.make({ pools: [pool([view.accounts[1]!])], pushes: [grantFor({ allowance: { max: 1, asNeeded: true } })] })],
      ],
      settled.state,
    )
    expect(later.events.some((event) => event._tag === "ClaimDue")).toBe(false)
  })

  test("one at a time across the host: two pools each holding a start, two resets approved, one claim", () => {
    const other: PoolView = { ...pool([spent("c", [grant("g-c", T0 + 30 * DAY, FULL)])]), id: "anthropic-2" }
    const { events } = resets([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_child", hard: true })],
      [T0, NoteWait.make({ pool: "anthropic-2", sessionID: "ses_child", hard: true })],
      [T0 + MINUTE, Review.make({ pools: [pool([spent("a", [grant("g-a", T0 + 30 * DAY, FULL)])]), other], pushes: [grantFor({ allowance: { max: 2, asNeeded: false } })] })],
    ])
    expect(events.filter((event) => event._tag === "ClaimDue")).toHaveLength(1)
  })

  test("a session's push spends nothing on a spent week: a held start in its tree that the reset cannot free claims nothing", () => {
    // A Fable start held by the spent Fable week: a weekly reset gives the week back, but not Fable's share, so the start stays held.
    const view = pool([
      account(
        "a",
        [window("5h", 0.2, T0 + 2 * HOUR), window("7d", 1, T0 + 4 * DAY), { ...window("7d:Fable", 1, T0 + 4 * DAY), ofWeekly: 0.3 }],
        [grant("g-a", T0 + 30 * DAY, WEEKLY)],
      ),
    ])
    const fable = { hard: true, root: "ses_root", model: "claude-fable-5-2" }
    const scoped = [grantFor({ scope: { host: "workbox", sessionID: "ses_root" } })]
    expect(waitThen(view, fable, scoped).events.some((event) => event._tag === "ClaimDue")).toBe(false)
    // A push of the whole host claims the week back on the same readings: its spent week is the host's to spend.
    expect(waitThen(view, fable).events.some((event) => event._tag === "ClaimDue")).toBe(true)
  })

  test("by value: a reset that would expire before its week resets first, then the most week given back, then the most days left; Fable only when Fable is out", () => {
    const soon = spent("soon", [grant("g-soon", T0 + 2 * DAY, FULL)], 4 * DAY)
    const late = spent("late", [grant("g-late", T0 + 60 * DAY, FULL)], 6 * DAY)
    const early = spent("early", [grant("g-early", T0 + 60 * DAY, FULL)], 2 * DAY)
    const pick = (view: PoolView, wait: Partial<NoteWait> = { hard: true }) =>
      waitThen(view, wait).events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.creditID] : []))[0]
    expect(pick(pool([late, soon, early]))).toBe("g-soon")
    expect(pick(pool([early, late]))).toBe("g-late")
    // A Fable reset gives back Fable's share only: not for a start the weekly window holds.
    const fableOut = account(
      "f",
      [window("5h", 0.2, T0 + 2 * HOUR), window("7d", 0.6, T0 + 4 * DAY), { ...window("7d:Fable", 1, T0 + 4 * DAY), ofWeekly: 0.3 }],
      [grant("g-fable", T0 + 100 * DAY, FABLE)],
    )
    expect(pick(pool([fableOut]), { hard: true, model: "claude-fable-5-2" })).toBe("g-fable")
    expect(pick(pool([spent("w", [grant("g-fable", T0 + 100 * DAY, FABLE)])]))).toBeUndefined()
    // The owner's kinds bound it: a push of weekly resets spends no full one.
    const weeklyOnly = waitThen(pool([late]), { hard: true }, [grantFor({ allowance: { max: 1, asNeeded: false, kinds: ["weekly"] } })])
    expect(weeklyOnly.events.some((event) => event._tag === "ClaimDue")).toBe(false)
  })

  test("during a push an account whose week is spent has its reset claimed at once, with no start held: use 100%, reset", () => {
    const weekSpent = account("a", [window("5h", 0.3, T0 + 2 * HOUR), window("7d", 1, T0 + 5 * DAY)], [grant("g-a", T0 + 30 * DAY, WEEKLY)])
    const roomy = account("b", [window("5h", 0.1, T0 + 2 * HOUR), window("7d", 0.2, T0 + 5 * DAY)], [grant("g-b", T0 + 30 * DAY, WEEKLY)])
    const { events } = resets([[T0, Review.make({ pools: [pool([weekSpent, roomy])], pushes: [grantFor()] })]])
    expect(events).toMatchObject([{ _tag: "ClaimDue", reset: { credentialID: "a", why: "push", key: pushKey("push-1", "a", T0 + 5 * DAY) } }])
    // Without a push, nothing: the pace goes on with the other account.
    expect(resets([[T0, Review.make({ pools: [pool([weekSpent, roomy])] })]]).events).toEqual([])
    // A spent 5-hour window alone refills in hours: no claim without a held start.
    const shortSpent = account("c", [window("5h", 1, T0 + 2 * HOUR), window("7d", 0.5, T0 + 5 * DAY)], [grant("g-c", T0 + 30 * DAY, SESSION)])
    expect(resets([[T0, Review.make({ pools: [pool([shortSpent, roomy])], pushes: [grantFor()] })]]).events).toEqual([])
  })
})

describe("the plan and the forecast", () => {
  test("the plan measures the room, the burn, what each reset adds and when it would likely be claimed, and the host's load", () => {
    // Two accounts 3.5 days into their week at 70%: 0.2%/h of a week each, 60% of room left.
    const view = pool([
      account("a", [window("5h", 0.5, T0 + 2 * HOUR), window("7d", 0.7, T0 + 3.5 * DAY)], [grant("g-a", T0 + 30 * DAY, WEEKLY)]),
      account("b", [window("5h", 0.5, T0 + 2 * HOUR), window("7d", 0.7, T0 + 3.5 * DAY)], [grant("g-b", T0 + 2 * DAY, FULL)]),
    ])
    const plan = planOf({ views: [view], grant: { max: 2 }, now: T0, load: { load: 42, cores: 16 } })
    expect(plan.pools[0]).toMatchObject({ accounts: 2, weeklyRoom: expect.closeTo(0.6, 6), weeklyBurn: expect.closeTo(2 * (0.7 / 84), 6) })
    // The full reset expires before b's week resets: spent first.
    expect(plan.resets.map((reset) => [reset.label, reset.kind, reset.expiresFirst])).toEqual([
      ["B", "full", true],
      ["A", "weekly", false],
    ])
    // The room (60%) lasts 36 h at the burn, past the weeks' own resets in 84 h? No: 36 h comes first.
    expect(plan.resets[0]!.at).toBeCloseTo(T0 + 36 * HOUR, -3)
    const text = planText(plan)
    expect(text).toContain("Host load 42.0 on 16 cores (over its cores)")
    expect(text).toContain("full reset on B")
  })

  test("with low demand the resets in hand expire unused, and the forecast says so; with high demand they are spent", () => {
    // 10% used two days into the week: 0.2%/h; three weekly resets expiring in 10 days.
    const credits = [grant("g1", T0 + 10 * DAY, WEEKLY), grant("g2", T0 + 10 * DAY, WEEKLY), grant("g3", T0 + 10 * DAY, WEEKLY)]
    const low = forecastOf(pool([account("a", [window("7d", 0.1, T0 + 5 * DAY)], credits)]), T0)
    expect(low.wasted).toHaveLength(3)
    expect(forecastText(low)).toContain("3 of its 3 resets (weekly reset; each gives back ≈99% of a week) expire unused by Nov 21, 2026, 7:00:00 AM EST")
    // 90% used one day into the week: 3.75%/h, ~9 weeks' use by the expiry against ~2.1 weeks of room.
    const high = forecastOf(pool([account("a", [window("7d", 0.9, T0 + 6 * DAY)], credits)]), T0)
    expect(high.wasted).toEqual([])
    expect(forecastText(high)).toBeUndefined()
  })
  test("absent windows in plan and forecast: no week claims no resets, no NaN/undefined/unread for absent windows, and empty pools stay unread", () => {
    const weekless: AccountStatus = {
      ...account("w", [window("5h", 0.4, T0 + 2 * HOUR)], [grant("g-w", T0 + 2 * DAY, FULL)]),
      reading: { at: T0, windows: [window("5h", 0.4, T0 + 2 * HOUR)], absent: [{ name: "7d", at: T0 }], resets: { available: 1, credits: [grant("g-w", T0 + 2 * DAY, FULL)] } },
    }
    const ultra: AccountStatus = {
      ...account("u", [window("7d", 0.5, T0 + 3.5 * DAY)], [grant("g-u", T0 + 10 * DAY, WEEKLY)]),
      reading: { at: T0, windows: [window("7d", 0.5, T0 + 3.5 * DAY)], absent: [{ name: "5h", at: T0 }], resets: { available: 1, credits: [grant("g-u", T0 + 10 * DAY, WEEKLY)] } },
    }
    const weeklessPlan = planOf({ views: [pool([weekless])], grant: { max: 2 }, now: T0, need: { units: 2, cost: 0.2 } })
    expect(weeklessPlan.resets).toEqual([])
    const weeklessText = planText(weeklessPlan)
    expect(weeklessText).toContain("absent (its usage reports none)")
    expect(weeklessText).toContain("report no weekly window")
    expect(weeklessText).not.toMatch(/NaN|undefined|unread/)
    expect(forecastOf(pool([weekless]), T0).wasted).toEqual([])

    const ultraPlan = planOf({ views: [pool([ultra])], grant: { max: 2 }, now: T0 })
    const ultraText = planText(ultraPlan)
    expect(ultraText).toContain("5-hour window absent (its usage reports none)")
    expect(ultraText).not.toMatch(/NaN|undefined|unread/)

    const emptyText = planText(planOf({ views: [pool([])], grant: { max: 1 }, now: T0, need: { units: 1, cost: 0.1 } }))
    expect(emptyText).not.toContain("absent")
    expect(emptyText).toContain("unread")
  })
})
