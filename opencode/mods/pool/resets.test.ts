// The Resets aggregate's rules: a Codex credit is claimed on its own when
// every Codex account is held and a start waits (or a credit is about to
// expire on a half-spent week); a Claude grant is never claimed unasked: the
// owner is asked once per hold, with the days left before the weekly reset,
// and the claim follows only a yes. A hold is worked once; a claim that did
// not go through goes again as the same claim.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import * as Story from "@dotfiles/decider/story"
import type { ResetCredit } from "./quota.ts"
import {
  ASSUME,
  type Command,
  type Event,
  expiringKey,
  holdKey,
  isYes,
  MAX_ATTEMPTS,
  NoteWait,
  type PoolView,
  claimRequestID,
  Resets,
  type ResetsState,
  RETRY_MS,
  Review,
  SettleClaim,
  TakeAnswer,
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
        { name: "5h", utilization: options.fiveHour ?? 0.2, resetAt: T0 + 2 * HOUR },
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

const claudeGrant = (id: string, options: { readonly usable?: boolean } = {}): ResetCredit => ({
  id,
  count: 1,
  usable: options.usable ?? true,
  expiresAt: Date.parse("2027-03-09T00:00:00Z"),
  clears: ["five_hour", "seven_day_overage_included"],
})

const codex = (accounts: ReadonlyArray<AccountStatus>): PoolView => ({
  id: "openai",
  provider: "codex",
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, `codex ${item.credentialID}`])),
})

const claude = (accounts: ReadonlyArray<AccountStatus>): PoolView => ({
  id: "anthropic",
  provider: "claude",
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID.replace("cred-", "")])),
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

const tags = (events: ReadonlyArray<Event>) => events.map((event) => event._tag)

/** The pool as the sweep read it at `at`: a claim no one asked for needs fresh evidence. */
const readAt = (view: PoolView, at: number): PoolView => ({
  ...view,
  accounts: view.accounts.map((item) => (item.reading === undefined ? item : { ...item, reading: { ...item.reading, at } })),
})

const spentCodex = (credits: ReadonlyArray<ResetCredit>) => [
  account("codex-a", { fiveHour: 1, credits }),
  account("codex-b", { sevenDay: 1, weekResetsIn: 3 * DAY }),
]

describe("Codex", () => {
  test("every account held and a start waiting: the soonest-expiring credit is claimed, under a request id from the account, kind and hold", () => {
    const credits = [codexCredit("late", 22 * DAY), codexCredit("soon", 21 * DAY)]
    const { events } = run([
      [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
      [T0 + MINUTE, Review.make({ pools: [codex(spentCodex(credits))] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
    const due = events[1]
    if (due?._tag !== "ClaimDue") throw new Error("no claim")
    const key = holdKey("codex", "openai", "codex-a", T0 + 2 * HOUR)
    expect(due.reset).toMatchObject({
      key,
      credentialID: "codex-a",
      creditID: "soon",
      requestID: claimRequestID("codex", spentCodex(credits)[0]!, credits[1]!, T0 + MINUTE),
      why: "held",
      stage: "claiming",
      label: "codex codex-a",
    })
    expect(due.reset.requestID).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  test("an account with room, or no start waiting, claims nothing", () => {
    const credits = [codexCredit("soon", 21 * DAY)]
    const room = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [codex([account("codex-a", { fiveHour: 1, credits }), account("codex-b")])] })],
    ])
    expect(tags(room.events)).toEqual(["WaitNoted"])
    const idle = run([[T0, Review.make({ pools: [codex(spentCodex(credits))] })]])
    expect(idle.events).toEqual([])
    const stale = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0 + WAIT_MS, Review.make({ pools: [codex(spentCodex(credits))] })],
    ])
    expect(tags(stale.events)).toEqual(["WaitNoted"])
  })

  test("a start waiting on Claude while every Claude account is held counts as waiting on Codex", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1 })]), codex(spentCodex([codexCredit("soon", 21 * DAY)]))] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "ClaimDue"])
  })

  test("never twice for the same hold: a second review, and one after the claim settled, claim nothing", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY), codexCredit("late", 22 * DAY)]))
    const first = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
      [T0 + MINUTE, Review.make({ pools: [view] })],
    ])
    expect(tags(first.events)).toEqual(["WaitNoted", "ClaimDue"])
    const key = holdKey("codex", "openai", "codex-a", T0 + 2 * HOUR)
    const settled = run(
      [
        [T0 + MINUTE, SettleClaim.make({ key, outcome: "nothing-to-reset", before: [] })],
        [T0 + 2 * MINUTE, NoteWait.make({ pool: "openai" })],
        [T0 + 2 * MINUTE, Review.make({ pools: [view] })],
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

  test("a credit expiring within a day is claimed on a half-spent week, with no start waiting; not on a fresh week", () => {
    const half = run([[T0, Review.make({ pools: [codex([account("codex-a", { sevenDay: 0.5, credits: [codexCredit("ending", 20 * HOUR)] })])] })]])
    expect(half.events).toHaveLength(1)
    expect(half.events[0]).toMatchObject({ _tag: "ClaimDue", reset: { key: expiringKey("codex", "codex-a", "7d", T0 + 4.5 * DAY), why: "expiring", creditID: "ending" } })
    const again = run([[T0 + MINUTE, Review.make({ pools: [codex([account("codex-a", { sevenDay: 0.5, credits: [codexCredit("ending", 20 * HOUR)] })])] })]], half.state)
    expect(again.events).toEqual([])
    const fresh = run([[T0, Review.make({ pools: [codex([account("codex-a", { sevenDay: 0.4, credits: [codexCredit("ending", 20 * HOUR)] })])] })]])
    expect(fresh.events).toEqual([])
    const later = run([[T0, Review.make({ pools: [codex([account("codex-a", { sevenDay: 0.9, credits: [codexCredit("ending", 2 * DAY)] })])] })]])
    expect(later.events).toEqual([])
  })

  test("a claim that did not go through goes again as the same claim after RETRY_MS, at most MAX_ATTEMPTS times", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY)]))
    const key = holdKey("codex", "openai", "codex-a", T0 + 2 * HOUR)
    const first = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
      [T0, SettleClaim.make({ key, outcome: "failed", message: "timeout", before: [] })],
    ])
    const requestID = first.events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset.requestID] : []))[0]
    let state = first.state
    expect(state.resets[key]).toMatchObject({ stage: "failed", attempts: 1 })
    expect(run([[T0 + RETRY_MS - 1, Review.make({ pools: [view] })]], state).events).toEqual([])
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
    expect(run([[T0 + 10 * RETRY_MS, Review.make({ pools: [view] })]], state).events).toEqual([])
  })

  test("a claim sent that never came back (a stop mid-claim) goes again once RETRY_MS has passed", () => {
    const view = codex(spentCodex([codexCredit("soon", 21 * DAY)]))
    const { state } = run([
      [T0, NoteWait.make({ pool: "openai" })],
      [T0, Review.make({ pools: [view] })],
    ])
    expect(run([[T0 + MINUTE, Review.make({ pools: [view] })]], state).events).toEqual([])
    // Sent again on a reading taken after it; the one it was sent on says nothing of it.
    expect(run([[T0 + RETRY_MS, Review.make({ pools: [view] })]], state).events).toEqual([])
    expect(tags(run([[T0 + RETRY_MS, Review.make({ pools: [readAt(view, T0 + RETRY_MS)] })]], state).events)).toEqual(["ClaimDue"])
  })
})

describe("Claude", () => {
  const held = [account("cred-4", { fiveHour: 1, weekResetsIn: 4.5 * DAY, credits: [claudeGrant("grant-4")] }), account("cred-6", { sevenDay: 1, credits: [claudeGrant("grant-6")] })]

  test("every account held and a start waiting: no claim; the owner is asked once, about the account a claim frees, with the days left", () => {
    const { events, state } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude(held)] })],
      [T0 + MINUTE, Review.make({ pools: [claude(held)] })],
    ])
    expect(tags(events)).toEqual(["WaitNoted", "OwnerAsked"])
    const asked = events[1]
    if (asked?._tag !== "OwnerAsked") throw new Error("not asked")
    expect(asked.reset).toMatchObject({ credentialID: "cred-4", creditID: "grant-4", sessionID: "ses_root", stage: "asked", label: "4" })
    expect(asked.reset.question).toBe(
      "Claude reset on account 4 now: buys the 5h window back and 4.5 days remain before the weekly reset (2026-11-14). The grant ends 2027-03-09. Claim it?",
    )
    expect(Object.values(state.resets).filter((reset) => reset.stage === "asked")).toHaveLength(1)
  })

  test("a weekly reset under a day away says it is probably not worth it", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1, weekResetsIn: 18 * HOUR, credits: [claudeGrant("grant-4")] })])] })],
    ])
    expect(events[1]).toMatchObject({ _tag: "OwnerAsked" })
    const asked = events[1]
    if (asked?._tag !== "OwnerAsked") throw new Error("not asked")
    expect(asked.reset.question).toContain("18 h remain before the weekly reset")
    expect(asked.reset.question).toContain("The weekly reset is 18 h away: probably not worth it.")
  })

  test("a spent week the grant does not clear says the claim may not lift the hold", () => {
    const { events } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-6", { sevenDay: 1, credits: [claudeGrant("grant-6")] })])] })],
    ])
    const asked = events[1]
    if (asked?._tag !== "OwnerAsked") throw new Error("not asked")
    expect(asked.reset.question).toContain("its weekly window is spent too and the grant clears five_hour, seven_day_overage_included, not seven_day: it may not lift the hold")
  })

  test("a yes claims under the request id the question was asked with; a no, or a dismissal, declines and never asks again for that hold", () => {
    const start = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude(held)] })],
    ])
    const key = holdKey("claude", "anthropic", "cred-4", T0 + 2 * HOUR)
    const yes = run([[T0 + MINUTE, TakeAnswer.make({ key, answer: "Claim it" })]], start.state)
    expect(yes.events).toHaveLength(1)
    expect(yes.events[0]).toMatchObject({ _tag: "ClaimDue", reset: { key, requestID: start.state.resets[key]!.requestID, stage: "claiming", attempts: 0 } })
    expect(yes.state.resets[key]?.attempts).toBe(1)
    expect(run([[T0 + 2 * MINUTE, TakeAnswer.make({ key, answer: "Claim it" })]], yes.state).events).toEqual([])
    for (const answer of [KEEP_ANSWER, `${ASSUME} (note: later)`, undefined]) {
      const no = run(
        [
          [T0 + MINUTE, TakeAnswer.make({ key, ...(answer === undefined ? {} : { answer }) })],
          [T0 + 2 * MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
          [T0 + 2 * MINUTE, Review.make({ pools: [claude([held[0]!])] })],
        ],
        start.state,
      )
      expect(tags(no.events)).toEqual(["AnswerDeclined", "WaitNoted"])
    }
  })

  test("the question is withdrawn when the hold lifts by itself, or the grant can no longer be claimed", () => {
    const start = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!])] })],
    ])
    const key = holdKey("claude", "anthropic", "cred-4", T0 + 2 * HOUR)
    const lifted = run([[T0 + 2 * HOUR + MINUTE, Review.make({ pools: [claude([account("cred-4", { credits: [claudeGrant("grant-4")] })])] })]], start.state)
    expect(lifted.events).toEqual([{ _tag: "AskWithdrawn", key, at: T0 + 2 * HOUR + MINUTE, why: "the hold lifted" }])
    const paused = run([[T0 + MINUTE, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1, credits: [claudeGrant("grant-4", { usable: false })] })])] })]], start.state)
    expect(paused.events).toEqual([{ _tag: "AskWithdrawn", key, at: T0 + MINUTE, why: "the grant can no longer be claimed" }])
    expect(run([[T0 + 2 * MINUTE, TakeAnswer.make({ key, answer: "Claim it" })]], paused.state).events).toEqual([])
  })

  test("an ineligible account (no grants), a start with no session to ask in, or an account with room: nothing is asked", () => {
    const ineligible = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1 })])] })],
    ])
    expect(tags(ineligible.events)).toEqual(["WaitNoted"])
    const nowhere = run([
      [T0, NoteWait.make({ pool: "anthropic" })],
      [T0, Review.make({ pools: [claude(held)] })],
    ])
    expect(tags(nowhere.events)).toEqual(["WaitNoted"])
    const room = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!, account("cred-7")])] })],
    ])
    expect(tags(room.events)).toEqual(["WaitNoted"])
  })

  test("a claim that came back ineligible is settled, not retried", () => {
    const key = holdKey("claude", "anthropic", "cred-4", T0 + 2 * HOUR)
    const { state } = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [claude([held[0]!])] })],
      [T0, TakeAnswer.make({ key, answer: "Claim it" })],
      [T0, SettleClaim.make({ key, outcome: "no-credit", message: "ineligible", before: [] })],
    ])
    expect(state.resets[key]).toMatchObject({ stage: "settled", outcome: "no-credit" })
    expect(run([[T0 + RETRY_MS, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })], [T0 + RETRY_MS, Review.make({ pools: [claude([held[0]!])] })]], state).events).toHaveLength(1)
  })
})

const KEEP_ANSWER = "Don't claim"

test("a claim's record says whether the weekly reset moved", () => {
  const before = [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY }]
  expect(weeklyMove(before, [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY + 1000 }])).toBe("kept")
  expect(weeklyMove(before, [{ name: "7d", utilization: 0, resetAt: T0 + 7 * DAY }])).toBe("moved")
  expect(weeklyMove(before, undefined)).toBe("unread")
  const key = holdKey("claude", "anthropic", "cred-4", T0 + 2 * HOUR)
  const { state } = run([
    [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
    [T0, Review.make({ pools: [claude([account("cred-4", { fiveHour: 1, credits: [claudeGrant("grant-4")] })])] })],
    [T0, TakeAnswer.make({ key, answer: "claim it" })],
    [T0, SettleClaim.make({ key, outcome: "reset", before, after: [{ name: "7d", utilization: 0.8, resetAt: T0 + 3 * DAY }] })],
  ])
  expect(state.claims).toHaveLength(1)
  expect(state.claims[0]).toMatchObject({ outcome: "reset", weekly: "kept", label: "4", creditID: "grant-4" })
})

test("an answer is a yes only when it says so", () => {
  expect(isYes("Claim it")).toBe(true)
  expect(isYes(" claim  it ")).toBe(true)
  expect(isYes("yes")).toBe(true)
  expect(isYes("Don't claim")).toBe(false)
  expect(isYes(`${ASSUME} (note: maybe tomorrow)`)).toBe(false)
  expect(isYes("no")).toBe(false)
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
