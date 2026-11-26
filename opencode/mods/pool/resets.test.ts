// The Resets aggregate under the standing allowance: the pool claims resets
// on its own, Claude's and Codex's alike, and never asks. Ordinary resets
// refill measured exhaustion with running or held work; a Codex reset waits
// for its shared week, while Claude preserves that deadline. A reset about
// to expire goes so it is not lost; a window period takes
// one claim; and a claim that did not go through goes again as the same
// claim. After a claim the owner is told once.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option } from "effect"
import { fold } from "@dotfiles/decider/decider"
import * as Story from "@dotfiles/decider/story"
import type { ResetCredit } from "./quota.ts"
import {
  awaitingObservation,
  type ClaimDue,
  type Command,
  type Event,
  expiringKey,
  MAX_ATTEMPTS,
  NoteWait,
  type PoolView,
  claimRequestID,
  Resets,
  type ResetsState,
  RETRY_MS,
  Review,
  SettleClaim,
  WAIT_MS,
  WaitNoted,
  weeklyMove,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-09T12:00:00Z")

/** An account whose 5-hour and weekly windows read `fiveHour` and `sevenDay` used, with `credits`. */
const account = (
  credentialID: string,
  options: {
    readonly fiveHour?: number
    readonly fiveHourResetsIn?: number
    readonly sevenDay?: number
    readonly weekResetsIn?: number
    readonly credits?: ReadonlyArray<ResetCredit>
  } = {},
): AccountStatus => {
  const credits = options.credits ?? []
  return {
    credentialID,
    load: 0,
    live: 0,
    noRoom: false,
    reading: {
      at: T0,
      windows: [
        { name: "5h", utilization: options.fiveHour ?? 0.2, resetAt: T0 + (options.fiveHourResetsIn ?? 2 * HOUR) },
        { name: "7d", utilization: options.sevenDay ?? 0.3, resetAt: T0 + (options.weekResetsIn ?? 4.5 * DAY) },
      ],
      resets: { available: credits.filter((credit) => credit.usable).length, credits },
    },
  }
}

const codexCredit = (id: string, expiresIn: number, status = "available"): ResetCredit => ({
  id,
  count: 1,
  usable: status === "available",
  status,
  expiresAt: T0 + expiresIn,
})

const claudeGrant = (id: string, options: { readonly usable?: boolean; readonly count?: number } = {}): ResetCredit => ({
  id,
  count: options.count ?? 2,
  usable: options.usable ?? true,
  expiresAt: Date.parse("2027-03-09T00:00:00Z"),
  clears: ["five_hour", "seven_day_overage_included"],
})

/** Three agents in flight: enough work that a spent 5-hour window would be spent again before it resets. */
const BUSY = 3

const codex = (accounts: ReadonlyArray<AccountStatus>, inflight = BUSY): PoolView => ({
  id: "openai",
  provider: "codex",
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, `codex ${item.credentialID}`])),
  running: inflight,
})

const claude = (accounts: ReadonlyArray<AccountStatus>, inflight = BUSY): PoolView => ({
  id: "anthropic",
  provider: "claude",
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID.replace("cred-", "")])),
  running: inflight,
})

/** Decide `commands` in order at `now`, from `state`: every event recorded, and the state they fold into. */
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
const weighed = (events: ReadonlyArray<Event>) => events.flatMap((event) => (event._tag === "ClaimWeighed" ? [event] : []))

/** The pool as the sweep read it at `at`: a claim the pool decides on its own needs fresh evidence. */
const readAt = (view: PoolView, at: number): PoolView => ({
  ...view,
  accounts: view.accounts.map((item) => (item.reading === undefined ? item : { ...item, reading: { ...item.reading, at } })),
})

const spentCodex = (credits: ReadonlyArray<ResetCredit>) => [
  account("codex-a", { fiveHour: 1, sevenDay: 1, credits }),
  account("codex-b", { sevenDay: 1, weekResetsIn: 3 * DAY }),
]

describe("Codex", () => {
  test("every account held, a start waiting and work running: the soonest-expiring credit is claimed, keyed by the account's window period", () => {
    const credits = [codexCredit("late", 22 * DAY), codexCredit("soon", 21 * DAY)]
    const { events } = run([
      [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
      [T0 + MINUTE, Review.make({ pools: [codex(spentCodex(credits))] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
    const due = events[1]
    if (due?._tag !== "ClaimDue") throw new Error("no claim")
    expect(due.reset).toMatchObject({
      key: expiringKey("codex", "codex-a", "5h", T0 + 2 * HOUR),
      credentialID: "codex-a",
      creditID: "soon",
      requestID: claimRequestID("codex", spentCodex(credits)[0]!, credits[1]!, T0 + MINUTE),
      why: "forecast",
      stage: "claiming",
      label: "codex codex-a",
      left: 1,
      nextExpires: T0 + 22 * DAY,
    })
    expect(due.reset.reason).toStartWith("the account reached its limit: 5h 100% used, 3 agents running, 1 start held; refill the measured limit")
    expect(due.reset.requestID).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  test("a spent Codex short window preserves unspent weekly quota regardless of other accounts; no work or a stale held start claims nothing", () => {
    const credits = [codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]
    const room = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [codex([account("codex-a", { fiveHour: 1, credits }), account("codex-b", { fiveHour: 0 })])] })],
    ])
    expect(tags(room.events)).toEqual(["WaitNoted"])
    expect(weighed(room.events)).toMatchObject([{ _tag: "ClaimWeighed", pool: "openai", step: "fresh" }])
    expect(weighed(room.events)[0]?.reasons.join("; ")).toContain("5h at 100% used; wait for measured exhaustion")
    // Less room on another account still cannot authorize discarding codex-a's unspent week.
    const tight = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [codex([account("codex-a", { fiveHour: 1, credits }), account("codex-b", { fiveHour: 0.9 })])] })],
    ])
    expect(tags(tight.events)).toEqual(["WaitNoted"])
    const idle = run([[T0, Review.make({ pools: [codex(spentCodex(credits), 0)] })]])
    expect(idle.events).toEqual([])
    const stale = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0 + WAIT_MS, Review.make({ pools: [codex(spentCodex(credits), 0)] })],
    ])
    expect(tags(stale.events)).toEqual(["WaitNoted"])
  })

  test("a start waiting on Claude while every Claude account is held counts as waiting on Codex", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1 })]), codex(spentCodex([codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]))] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
  })

  test("never twice in a window period: a second review, and one after the claim settled, claim nothing", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]))
    const first = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
      [T0 + MINUTE, Review.make({ pools: [view] })],
    ])
    expect(tags(first.events)).toEqual(["WaitNoted", "ClaimDue"])
    const key = expiringKey("codex", "codex-a", "5h", T0 + 2 * HOUR)
    const settled = run(
      [
        [T0 + MINUTE, SettleClaim.make({ key, outcome: "nothing-to-reset", before: [] })],
        [T0 + 2 * MINUTE, NoteWait.make({ pool: "openai" })],
        [T0 + 2 * MINUTE, Review.make({ pools: [readAt(view, T0 + 2 * MINUTE)] })],
      ],
      first.state,
    )
    expect(tags(settled.events)).toEqual(["ClaimSettled", "WaitNoted"])
    expect(settled.state.resets[key]).toMatchObject({ stage: "settled", outcome: "nothing-to-reset", attempts: 1 })
  })

  test("a credit already redeemed or expired is not claimed", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [codex(spentCodex([codexCredit("used", 21 * DAY, "redeemed"), codexCredit("gone", -MINUTE)]))] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted"])
  })

  test("a claim that did not go through goes again as the same claim after RETRY_MS, at most MAX_ATTEMPTS times", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]))
    const key = expiringKey("codex", "codex-a", "5h", T0 + 2 * HOUR)
    const first = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
      [T0, SettleClaim.make({ key, outcome: "failed", message: "timeout", before: [] })],
    ])
    const requestID = first.events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.requestID] : []))[0]
    let state = first.state
    expect(state.resets[key]).toMatchObject({ stage: "failed", attempts: 1 })
    expect(tags(run([[T0 + RETRY_MS - 1, Review.make({ pools: [view] })]], state).events)).toEqual([])
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      const at = T0 + (attempt - 1) * RETRY_MS
      const retried = run(
        [
          [at, Review.make({ pools: [readAt(view, at)] })],
          [at, SettleClaim.make({ key, outcome: "failed", before: [] })],
        ],
        state,
      )
      expect(tags(retried.events)).toEqual(["ClaimDue", "ClaimSettled"])
      expect(retried.events[0]).toMatchObject({ reset: { requestID } })
      state = retried.state
    }
    expect(tags(run([[T0 + 10 * RETRY_MS, Review.make({ pools: [view] })]], state).events)).toEqual([])
  })

  test("a claim sent that never came back (a stop mid-claim) goes again once RETRY_MS has passed", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]))
    const { state } = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(tags(run([[T0 + MINUTE, Review.make({ pools: [view] })]], state).events)).toEqual([])
    // Sent again on a reading taken after it; the one it was sent on says nothing of it.
    expect(tags(run([[T0 + RETRY_MS, Review.make({ pools: [view] })]], state).events)).toEqual([])
    expect(tags(run([[T0 + RETRY_MS, Review.make({ pools: [readAt(view, T0 + RETRY_MS)] })]], state).events)).toEqual(["ClaimDue"])
  })
})

describe("expiring resets", () => {
  test("one expiring within a day is claimed at once on a spent window, with no work at all", () => {
    const view = codex([account("codex-a", { fiveHour: 1, sevenDay: 1, credits: [codexCredit("ending", 20 * HOUR)] })], 0)
    const { events, state } = run([[T0, Review.make({ pools: [view] })]])
    expect(tags(events)).toEqual(["ClaimDue"])
    expect(events[0]).toMatchObject({ reset: { why: "expiring", creditID: "ending", key: expiringKey("codex", "codex-a", "5h", T0 + 2 * HOUR) } })
    expect(tags(run([[T0 + MINUTE, Review.make({ pools: [view] })]], state).events)).toEqual([])
  })

  test("one expiring within a day on a half-spent window waits for its last call, then goes on the window it gives back most of", () => {
    const half = (expiresIn: number) => codex([account("codex-a", { sevenDay: 0.5, credits: [codexCredit("ending", expiresIn)] })], 0)
    expect(run([[T0, Review.make({ pools: [half(20 * HOUR)] })]]).events).toEqual([])
    const last = run([[T0, Review.make({ pools: [half(5 * HOUR)] })]])
    expect(last.events).toHaveLength(1)
    expect(last.events[0]).toMatchObject({ _tag: "ClaimDue", reset: { why: "expiring", key: expiringKey("codex", "codex-a", "7d", T0 + 4.5 * DAY) } })
  })

  test("a Codex credit waits while its shared week resets by itself within 30 minutes", () => {
    const view = codex([account("codex-a", { fiveHour: 1, sevenDay: 1, weekResetsIn: 20 * MINUTE, credits: [codexCredit("ending", 3 * HOUR)] })], 0)
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toEqual([])
  })

  test("with no work, one expiring later than a day is left to expire", () => {
    const view = codex([account("codex-a", { fiveHour: 1, credits: [codexCredit("later", 2 * DAY)] })], 0)
    expect(run([[T0, Review.make({ pools: [view] })]]).events).toEqual([])
  })
})

describe("Claude", () => {
  const held = [
    account("cred-4", { fiveHour: 1, weekResetsIn: 4.5 * DAY, credits: [claudeGrant("grant-4")] }),
    account("cred-6", { sevenDay: 1, credits: [claudeGrant("grant-6")] }),
  ]

  test("every account held, a start waiting and work running: a reset is claimed on its own, never asked", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude(held)] })],
      [T0 + MINUTE, Review.make({ pools: [claude(held)] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
    expect(events.find((event) => event._tag === "ClaimDue")).toMatchObject({
      reset: { credentialID: "cred-4", creditID: "grant-4", why: "forecast", stage: "claiming", label: "4", buys: "5h 100% used of 100% → 0% used" },
    })
  })

  test("no agent running and no start held: nothing is claimed however spent the pool, and nothing is logged", () => {
    expect(run([[T0, Review.make({ pools: [claude(held, 0)] })]]).events).toEqual([])
  })

  test("a single held start with nothing running still counts: every account spent, a reset goes", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude(held, 0)] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
    expect(events[1]).toMatchObject({ reset: { credentialID: "cred-4", why: "forecast" } })
  })

  test("the last reset in hand goes too, when the pool runs out", () => {
    const one = [account("cred-4", { fiveHour: 1, credits: [claudeGrant("grant-4", { count: 1 })] })]
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude(one)] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
  })

  test("a spent week the grant does not clear: it would not free the account, nothing claimed", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-6", { sevenDay: 1, credits: [claudeGrant("grant-6")] })])] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted"])
    expect(weighed(events)[0]?.reasons).toEqual(["6: it would not free the account, another spent window still holds it"])
  })

  test("no grants means no claim; another account's room does not veto a measured Claude refill", () => {
    const ineligible = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1 })])] })],
    ])
    expect(tags(ineligible.events)).toEqual(["WaitNoted"])
    const room = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!, account("cred-7", { fiveHour: 0 })])] })],
    ])
    expect(tags(room.events)).toEqual(["WaitNoted", "ClaimDue"])
    expect(room.events.find((event) => event._tag === "ClaimDue")).toMatchObject({ reset: { credentialID: "cred-4", creditID: "grant-4" } })
  })

  test("a claim that came back ineligible is settled, not retried", () => {
    const key = expiringKey("claude", "cred-4", "5h", T0 + 2 * HOUR)
    const { state } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!])] })],
      [T0, SettleClaim.make({ key, outcome: "no-credit", message: "ineligible", before: [] })],
    ])
    expect(state.resets[key]).toMatchObject({ stage: "settled", outcome: "no-credit" })
    const later = run([[T0 + RETRY_MS, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + RETRY_MS, Review.make({ pools: [readAt(claude([held[0]!]), T0 + RETRY_MS)] })]], state)
    expect(tags(later.events)).toEqual(["WaitNoted"])
  })

  test("a claim made is told once, in the session that waited last, in the usage wording", () => {
    const key = expiringKey("claude", "cred-4", "5h", T0 + 2 * HOUR)
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!])] })],
      [T0, SettleClaim.make({ key, outcome: "reset", before: [] })],
    ])
    const told = events.find((event) => event._tag === "OwnerTold")
    expect(told).toMatchObject({ key, sessionID: "ses_root" })
    if (told?._tag !== "OwnerTold") throw new Error("not told")
    expect(told.text).toStartWith("Claimed the full reset on 4: 5h 100% used of 100% → 0% used (the account reached its limit: 5h 100% used, 3 agents running, 1 start held; refill the measured limit).")
    expect(told.text).toEndWith("1 reset left this week; next expires Mar 8, 2027, 7:00:00 PM EST.")
  })
  test("a stored reset is not claimed for an account whose weekly window is absent", () => {
    const weekless: AccountStatus = {
      credentialID: "cred-weekless",
      load: 0,
      live: 0,
      noRoom: false,
      reading: {
        at: T0,
        windows: [{ name: "5h", utilization: 1, resetAt: T0 + 2 * HOUR }],
        absent: [{ name: "7d", at: T0 }],
        resets: { available: 1, credits: [codexCredit("ending", 5 * HOUR)] },
      },
    }
    const { events } = run([
      [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [codex([weekless])] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted"])
  })

  test("a 5-hour refill is observed once a reading after it shows its 5-hour window back; then another spent account is refilled only for work the refilled one cannot take", () => {
    const spent = (id: string) => account(id, { fiveHour: 1, sevenDay: 0.4, credits: [claudeGrant(`grant-${id}`)] })
    const both = claude([spent("cred-a"), spent("cred-b")])
    // Both accounts spent, three agents running, a start held: one is refilled.
    const first = run([[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0, Review.make({ pools: [both] })]])
    const due = Option.getOrThrow(Arr.findFirst(first.events, (event): event is ClaimDue => event._tag === "ClaimDue"))
    const refilled = due.reset.credentialID
    const other = ["cred-a", "cred-b"].filter((id) => id !== refilled).join("")
    const before = spent(refilled).reading?.windows ?? []
    // The reading right after the answer: the 5-hour window back, the week as it was.
    const after = account(refilled, { fiveHour: 0, fiveHourResetsIn: MINUTE + 5 * HOUR, sevenDay: 0.4 }).reading?.windows ?? []
    const settled = run([[T0 + MINUTE, SettleClaim.make({ key: due.reset.key, outcome: "reset", before, after })]], first.state)
    // The window the claim was for shows its recovery: observed, not pending for OBSERVE_MS.
    expect(Option.isNone(awaitingObservation(settled.state.claims, "claude", refilled, T0 + 2 * MINUTE))).toBe(true)
    // The next sweep: the refilled account has room, the other is still spent.
    const next = readAt(
      claude([account(refilled, { fiveHour: 0, fiveHourResetsIn: 5 * HOUR, sevenDay: 0.4, credits: [claudeGrant(`grant-${refilled}`, { count: 1 })] }), spent(other)]),
      T0 + 2 * MINUTE,
    )
    // Running work alone goes to the refilled account, and the start held before the claim was the claim's to answer:
    // no work waits for the other, nothing claimed.
    const running = run([[T0 + 2 * MINUTE, Review.make({ pools: [next] })]], settled.state)
    expect(tags(running.events)).toEqual([])
    // A start held on that reading, which the refilled account could not take: the other spent account is refilled, at once.
    const held = run([[T0 + 3 * MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + 3 * MINUTE, Review.make({ pools: [next] })]], settled.state)
    expect(tags(held.events)).toEqual(["WaitNoted", "ClaimDue"])
    expect(held.events.find((event) => event._tag === "ClaimDue")).toMatchObject({ reset: { credentialID: other, creditID: `grant-${other}`, why: "forecast" } })
  })
})

describe("room is real room: another login is room for the running work only where placement would send it now", () => {
  const spentA = () => account("cred-a", { fiveHour: 1, sevenDay: 0.4, credits: [claudeGrant("grant-a")] })
  const roomB = account("cred-b", { fiveHour: 0.1, sevenDay: 0.3 })
  /** The accounts claimed on one review of A (5h spent, a grant in hand) beside `b`, three agents running and no start held. */
  const claimedBeside = (b: AccountStatus) =>
    run([[T0, Review.make({ pools: [claude([spentA(), b])] })]]).events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.credentialID] : []))
  const holdOf = (kind: NonNullable<AccountStatus["hold"]>["kind"], until = T0 + 6 * HOUR) => ({ kind, until, at: T0 - MINUTE })

  test("a login with room on a fresh reading and nothing refusing it: the running work goes there, nothing is claimed", () => {
    expect(claimedBeside(roomB)).toEqual([])
    // A refusal that has ended holds nothing: the login is room again.
    expect(claimedBeside({ ...roomB, hold: holdOf("rate-limit", T0 - 1) })).toEqual([])
  })

  for (const kind of ["signin", "unauthorized", "rate-limit", "usage-limit", "record-unreadable"] as const)
    test(`a login held by a live ${kind} refusal is no room: the spent account is refilled for the running work`, () => {
      expect(claimedBeside({ ...roomB, hold: holdOf(kind) })).toEqual(["cred-a"])
    })

  test("a sign-in refusal its reading carries is no room either", () => {
    const reading = Option.getOrThrow(Option.fromUndefinedOr(roomB.reading))
    expect(claimedBeside({ ...roomB, reading: { ...reading, refusal: { kind: "signin" } } })).toEqual(["cred-a"])
  })

  test("a reading too old to trust, or a usage read failed since, is no room: past STALE_AFTER_MS (30 min) placement sends nothing there", () => {
    const reading = Option.getOrThrow(Option.fromUndefinedOr(roomB.reading))
    expect(claimedBeside({ ...roomB, reading: { ...reading, at: T0 - 31 * MINUTE } })).toEqual(["cred-a"])
    expect(claimedBeside({ ...roomB, reading: { ...reading, at: T0 - 2 * MINUTE }, usageReadFailure: { failedAt: T0 - MINUTE, nextTryAt: T0 + MINUTE } })).toEqual(["cred-a"])
  })

  test("an unread login, or one whose every window is absent, is no room", () => {
    const { reading: _reading, ...unread } = roomB
    expect(claimedBeside(unread)).toEqual(["cred-a"])
    const absent = { ...roomB, reading: { at: T0, windows: [], absent: [{ name: "5h", at: T0 }, { name: "7d", at: T0 }] } }
    expect(claimedBeside(absent)).toEqual(["cred-a"])
    // Either window alone may be absent: a weekly-only login with room is room.
    const weekly = { ...roomB, reading: { at: T0, windows: [{ name: "7d", utilization: 0.3, resetAt: T0 + 4.5 * DAY }], absent: [{ name: "5h", at: T0 }] } }
    expect(claimedBeside(weekly)).toEqual([])
  })

  test("a login at its 5-hour hold line is no room", () => {
    expect(claimedBeside(account("cred-b", { fiveHour: 0.95, sevenDay: 0.3 }))).toEqual(["cred-a"])
  })

  /**
   * Every pool of A (spent, a grant in hand) and one other login in each state a login can be in, with
   * agents running or not and work held or not (a held start, or a running agent's request the pace held:
   * both note a wait). Work cannot go when some is held, or when agents run and no login takes work; a
   * reset is then due on A. When all work can go, nothing is claimed.
   */
  test("over generated pools: a reset is claimed exactly when some work has nowhere to go", () => {
    const reading = Option.getOrThrow(Option.fromUndefinedOr(roomB.reading))
    const { reading: _reading, ...unread } = roomB
    const states: ReadonlyArray<readonly [string, AccountStatus, boolean]> = [
      ["room", roomB, true],
      ["ended rate-limit", { ...roomB, hold: holdOf("rate-limit", T0 - 1) }, true],
      ["weekly only", { ...roomB, reading: { at: T0, windows: [{ name: "7d", utilization: 0.3, resetAt: T0 + 4.5 * DAY }], absent: [{ name: "5h", at: T0 }] } }, true],
      ...(["signin", "unauthorized", "rate-limit", "usage-limit", "record-unreadable"] as const).map(
        (kind): readonly [string, AccountStatus, boolean] => [kind, { ...roomB, hold: holdOf(kind) }, false],
      ),
      ["reading refusal", { ...roomB, reading: { ...reading, refusal: { kind: "signin" } } }, false],
      ["stale", { ...roomB, reading: { ...reading, at: T0 - 31 * MINUTE } }, false],
      ["failed read", { ...roomB, reading: { ...reading, at: T0 - 2 * MINUTE }, usageReadFailure: { failedAt: T0 - MINUTE, nextTryAt: T0 + MINUTE } }, false],
      ["unread", unread, false],
      ["all absent", { ...roomB, reading: { at: T0, windows: [], absent: [{ name: "5h", at: T0 }, { name: "7d", at: T0 }] } }, false],
      ["hold line", account("cred-b", { fiveHour: 0.95, sevenDay: 0.3 }), false],
      ["spent, no grant", account("cred-b", { fiveHour: 1, sevenDay: 0.4 }), false],
    ]
    const cases = states.flatMap(([name, b, takes]) => [0, BUSY].flatMap((running) => [false, true].map((held) => ({ name, b, takes, running, held }))))
    const wrong = cases.flatMap(({ name, b, takes, running, held }) => {
      const commands: ReadonlyArray<readonly [number, Command]> = [
        ...(held ? [[T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })] as const] : []),
        [T0, Review.make({ pools: [claude([spentA(), b], running)] })],
      ]
      const claimed = run(commands).events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.credentialID] : []))
      const due = held || (running > 0 && !takes)
      const expected = due ? ["cred-a"] : []
      return JSON.stringify(claimed) === JSON.stringify(expected) ? [] : [`${name}, ${running} running, ${held ? "work held" : "nothing held"}: claimed ${JSON.stringify(claimed)}`]
    })
    expect(cases).toHaveLength(states.length * 4)
    expect(wrong).toEqual([])
  })
})

test("a claim's record says whether the weekly reset moved", () => {
  const before = [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY }]
  expect(weeklyMove(before, [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY + 1000 }])).toBe("kept")
  expect(weeklyMove(before, [{ name: "7d", utilization: 0, resetAt: T0 + 7 * DAY }])).toBe("moved")
  expect(weeklyMove(before, undefined)).toBe("unread")
  const key = expiringKey("claude", "cred-4", "5h", T0 + 2 * HOUR)
  const { state } = run([
    [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
    [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1, credits: [claudeGrant("grant-4")] })])] })],
    [T0, SettleClaim.make({ key, outcome: "reset", before, after: [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY }] })],
  ])
  expect(state.claims).toHaveLength(1)
  expect(state.claims[0]).toMatchObject({ outcome: "reset", weekly: "kept", label: "4", creditID: "grant-4" })
})

test("a wait is noted with its session (a story)", () =>
  Effect.runPromise(
    Story.make(Resets)(
      Story.clock(T0),
      Story.when(NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })),
      Story.then(WaitNoted.make({ pool: "anthropic", wait: { at: T0, sessionID: "ses_root" } })),
      Story.state({ waits: { anthropic: { at: T0, sessionID: "ses_root" } }, resets: {}, claims: [] }),
    ),
  ))
