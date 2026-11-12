// A push (push.ts) as its aggregates decide it: the Pushes aggregate starts,
// ends and asks about pushes; the Resets aggregate spends a push's approved
// resets (resets.ts `pushDue`), by value, one at a time, in its scope only;
// the plan and the use-or-lose forecast are measured from the readings; and
// an account's line counts every reset in hand that would expire before it
// can be spent one per week (resets.ts `spareThisWeek`).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  AskPush,
  EndPush,
  forecastOf,
  forecastText,
  grantOf,
  MAX_PUSH_MS,
  NOT_NOW,
  planOf,
  planText,
  proposalOf,
  type Push,
  Pushes,
  type PushState,
  scopeKey,
  START,
  StartPush,
  TakePushAnswer,
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
  spareThisWeek,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
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

  test("the question is asked once per scope per week; a no holds for the week from the answer, a yes starts the push it proposed", () => {
    const scope = { host: "mac", sessionID: "ses_root", run: "ergo" }
    const ask = AskPush.make({ goal: "run ergo", scope, allowance: { max: 1, asNeeded: true, kinds: ["weekly"] }, sessionID: "ses_root", question: "?" })
    const asked = pushes([[T0, ask], [T0 + DAY, ask]])
    expect(asked.events.map((event) => event._tag)).toEqual(["PushAsked"])
    const no = pushes([[T0 + HOUR, TakePushAnswer.make({ key: scopeKey(scope), answer: NOT_NOW })], [T0 + 6 * DAY, ask]], asked.state)
    expect(no.events.map((event) => event._tag)).toEqual(["PushAnswered"])
    // The week counts from the no, not the question.
    expect(pushes([[T0 + HOUR + WEEK - 1, ask]], no.state).events).toEqual([])
    expect(pushes([[T0 + HOUR + WEEK, ask]], no.state).events.map((event) => event._tag)).toEqual(["PushAsked"])
    const yes = pushes([[T0 + HOUR, TakePushAnswer.make({ key: scopeKey(scope), answer: START })]], asked.state)
    expect(Object.values(yes.state.pushes)).toMatchObject([{ goal: "run ergo", by: "proactive", scope, allowance: { max: 1, kinds: ["weekly"] } }])
    // While a push covers the scope, nothing is asked.
    const covered = pushes([[T0, StartPush.make({ goal: "ergo", scope: { host: "mac" }, allowance: { max: 1, asNeeded: false }, by: "asked" })], [T0, ask]])
    expect(covered.events.map((event) => event._tag)).toEqual(["PushStarted"])
    expect(pushes([[T0 + 2 * HOUR, EndPush.make({ id: "nope", why: "x" })]], yes.state).events).toEqual([])
  })
})

describe("a run's question", () => {
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  test("property: over any askers and answers within a week, at most one question per host and run, and none after a no", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const next = random(seed)
      let state = Pushes.initial
      let at = T0
      let asked = 0
      let declined = false
      for (let step = 0; step < 20; step++) {
        at += Math.floor(next() * 8 * HOUR)
        if (at - T0 >= WEEK) break
        const session = `ses_orch_${Math.floor(next() * 4)}`
        const scope = { host: "workbox", sessionID: session, run: "ergo" }
        const ask = AskPush.make({ goal: "run ergo", scope, allowance: { max: 1, asNeeded: true }, sessionID: session, question: "?" })
        const decided = pushes([[at, ask]], state)
        state = decided.state
        const now = decided.events.filter((event) => event._tag === "PushAsked").length
        if (declined) expect(now).toBe(0)
        asked += now
        if (next() < 0.5) {
          const answered = pushes([[at + MINUTE, TakePushAnswer.make({ key: scopeKey(scope), answer: NOT_NOW })]], state)
          declined ||= answered.events.length > 0
          state = answered.state
        }
      }
      expect(asked).toBeLessThanOrEqual(1)
    }
  })

  test("a push for the run, from whichever session, covers the run's question", () => {
    const started = pushes([[T0, StartPush.make({ goal: "ergo", scope: { host: "workbox", sessionID: "ses_orch_1", run: "ergo" }, allowance: { max: 1, asNeeded: false }, by: "asked" })]])
    const ask = (run: string) =>
      AskPush.make({ goal: run, scope: { host: "workbox", sessionID: "ses_orch_2", run }, allowance: { max: 1, asNeeded: true }, sessionID: "ses_orch_2", question: "?" })
    expect(pushes([[T0 + HOUR, ask("ergo")]], started.state).events).toEqual([])
    expect(pushes([[T0 + HOUR, ask("other")]], started.state).events.map((event) => event._tag)).toEqual(["PushAsked"])
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
    expect(held.events.some((event) => event._tag === "OwnerAsked")).toBe(false)
    // A weekly reset alone leaves a's spent 5-hour window holding the start: not a candidate.
    expect(waitThen(pool([spent("a", [grant("g-a", T0 + 30 * DAY, WEEKLY)])]), { hard: true }).events.some((event) => event._tag === "ClaimDue")).toBe(false)
    // Another session's tree: the push does not cover it, and the owner is asked as before.
    const elsewhere = waitThen(view, { hard: true, root: "ses_other" }, [grantFor({ scope: { host: "workbox", sessionID: "ses_root" } })])
    expect(elsewhere.events.map((event) => event._tag)).toEqual(["WaitNoted", "OwnerAsked"])
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
    // Settled: the push has spent its one reset, so the next held start gets the owner's question instead.
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

  test("a proposal is the fewest resets that cover the work past the room; none when the room covers it or nothing would", () => {
    const view = pool([
      account("a", [window("7d", 0.9, T0 + 5 * DAY)], [grant("g-a", T0 + 30 * DAY, WEEKLY)]),
      account("b", [window("7d", 0.9, T0 + 5 * DAY)], [grant("g-b", T0 + 30 * DAY, WEEKLY)]),
    ])
    const plan = planOf({ views: [view], grant: { max: 99 }, now: T0 })
    expect(proposalOf(plan, 0.1)).toBeUndefined()
    expect(proposalOf(plan, 0.8)).toHaveLength(1)
    expect(proposalOf(plan, 1.5)).toHaveLength(2)
    expect(proposalOf(plan, 5)).toBeUndefined()
  })

  test("with low demand the resets in hand expire unused, and the forecast says so; with high demand they are spent", () => {
    // 10% used two days into the week: 0.2%/h; three weekly resets expiring in 10 days.
    const credits = [grant("g1", T0 + 10 * DAY, WEEKLY), grant("g2", T0 + 10 * DAY, WEEKLY), grant("g3", T0 + 10 * DAY, WEEKLY)]
    const low = forecastOf(pool([account("a", [window("7d", 0.1, T0 + 5 * DAY)], credits)]), T0)
    expect(low.wasted).toHaveLength(3)
    expect(forecastText(low)).toContain("3 of its 3 resets (weekly reset; ≈99% of a week each) expire unused by 2026-11-21 12:00Z")
    // 90% used one day into the week: 3.75%/h, ~9 weeks' use by the expiry against ~2.1 weeks of room.
    const high = forecastOf(pool([account("a", [window("7d", 0.9, T0 + 6 * DAY)], credits)]), T0)
    expect(high.wasted).toEqual([])
    expect(forecastText(high)).toBeUndefined()
  })
})

describe("an account's line with several resets", () => {
  const week = T0 + 3 * DAY
  const at = (credits: ReadonlyArray<ResetCredit>) => account("a", [window("7d", 0.5, week)], credits)
  test("spaced out, one per week: the best one raises the line, as before", () => {
    expect(spareThisWeek("claude", at([grant("g1", T0 + 30 * DAY, WEEKLY), grant("g2", T0 + 60 * DAY, WEEKLY)]), week, T0)).toBeCloseTo(0.99)
  })
  test("two expiring before the next week begins: both raise this week's line, or one is lost", () => {
    expect(spareThisWeek("claude", at([grant("g1", T0 + 2 * DAY, WEEKLY), grant("g2", T0 + 2 * DAY, FULL)]), week, T0)).toBeCloseTo(1.98)
    // One this week, one next week (it begins in 3 days), the third expiring before the week after begins (in 10): two this week.
    const three = [grant("g1", T0 + 9 * DAY, WEEKLY), grant("g2", T0 + 9 * DAY, WEEKLY), grant("g3", T0 + 9 * DAY, WEEKLY)]
    expect(spareThisWeek("claude", at(three), week, T0)).toBeCloseTo(1.98)
  })
})
