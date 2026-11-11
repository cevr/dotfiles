// When a reset may be spent without the owner (resets.ts), as properties: the
// round-1 verifier's probes (batch 2026-11-11e, round-1-findings.md B1, M1,
// M2, M3), each over the inputs it varied.
//
// - B1: one account takes one claim at a time. After a claim, nothing more is
//   claimed, offered or asked on it until a reading newer than the claim shows
//   what it did; one spent reading never spends two grants. The request id
//   comes from the account, the window and its period, not the grant.
// - M1: an automatic claim needs fresh evidence: a reading and a list of the
//   grants read within FRESH_MS, and a known natural reset after the grant's
//   expiry. Cached or unread data never authorizes spending.
// - M2: a reset is worth what it restores: zero restored is never claimed.
// - M3: a declined offer suppresses its account, kind and week, whichever
//   window ranks first later.
// - `auto: false` claims nothing on its own; offers and questions go on.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fold } from "@dotfiles/decider/decider"
import type { QuotaWindow, ResetCredit } from "./quota.ts"
import {
  type Command,
  effectOf,
  type Event,
  EXPIRING_MS,
  expiringKey,
  FRESH_MS,
  MIN_RESTORE,
  NoteWait,
  offerKey,
  type PoolView,
  type Ratio,
  RETRY_MS,
  Resets,
  type ResetsState,
  Review,
  SettleClaim,
  TakeAnswer,
} from "./resets.ts"
import type { AccountStatus } from "./status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.parse("2026-11-11T12:00:00Z")

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

const claimsOf = (events: ReadonlyArray<Event>) => events.flatMap((event) => (event._tag === "ClaimDue" ? [event.reset] : []))
const asksOf = (events: ReadonlyArray<Event>) => events.flatMap((event) => (event._tag === "OwnerAsked" ? [event.reset] : []))

const window = (name: string, utilization: number, resetAt?: number, more: Partial<QuotaWindow> = {}): QuotaWindow => ({
  name,
  utilization,
  ...(resetAt === undefined ? {} : { resetAt }),
  ...more,
})

/** An account `a` whose windows were read at `at`, with its grants read with them, or carried over from a reading at `listed`. */
const account = (windows: ReadonlyArray<QuotaWindow>, credits: ReadonlyArray<ResetCredit>, at = T0, listed?: number): AccountStatus => ({
  credentialID: "a",
  load: 0,
  live: 0,
  noRoom: false,
  reading: { at, windows, resets: { ...(listed === undefined ? {} : { at: listed }), available: credits.length, credits } },
})

const grant = (id: string, expiresAt: number, fields: Partial<ResetCredit>): ResetCredit => ({ id, count: 1, usable: true, expiresAt, requiresLimit: false, ...fields })
const WEEKLY: Partial<ResetCredit> = { clears: ["seven_day"], kind: "weekly" }
const SESSION: Partial<ResetCredit> = { clears: ["five_hour"], kind: "session" }
const FULL: Partial<ResetCredit> = { clears: ["five_hour", "seven_day"], kind: "full" }
const FABLE: Partial<ResetCredit> = { clears: ["five_hour", "seven_day_overage_included"], kind: "fable", givesBack: true }

const view = (accounts: ReadonlyArray<AccountStatus>, ratios: Readonly<Record<string, Ratio>> = {}, provider: "claude" | "codex" = "claude"): PoolView => ({
  id: provider === "claude" ? "anthropic" : "openai",
  provider,
  accounts,
  labels: Object.fromEntries(accounts.map((item) => [item.credentialID, item.credentialID])),
  ratios,
})

/** A second account with room, so the pool is never wholly held (that is the held start's question, not these rules). */
const roomy: AccountStatus = { ...account([window("5h", 0.1, T0 + 3 * HOUR), window("7d", 0.1, T0 + 5 * DAY)], []), credentialID: "room" }

const review = (accounts: ReadonlyArray<AccountStatus>, now = T0, state: ResetsState = Resets.initial, auto?: boolean, ratios: Readonly<Record<string, Ratio>> = {}) =>
  run([[now, Review.make({ pools: [view([...accounts, roomy], ratios)], ...(auto === undefined ? {} : { auto }) })]], state)

describe("M1: an automatic claim needs fresh evidence", () => {
  test("over the reading's age × the grants' listing × the natural reset × the use: claimed iff all are fresh and known, and the window outlives the grant", () => {
    const expiresAt = T0 + 2 * HOUR
    const ages = [0, 5 * MINUTE, FRESH_MS - 1, FRESH_MS, 2 * HOUR, 2 * DAY, 8 * DAY]
    // Grants listed with the reading (no `at` of their own), or carried over from an older reading (`carryOver` names its time).
    const listings = ["with the reading", "carried from FRESH_MS before", "carried from two days before"] as const
    const resets = [undefined, expiresAt - 1, expiresAt, expiresAt + 1, T0 + 3 * DAY]
    for (const age of ages)
      for (const listing of listings)
        for (const resetAt of resets)
          for (const used of [0.5, 1]) {
            const at = T0 - age
            const listed = listing === "with the reading" ? undefined : listing === "carried from FRESH_MS before" ? T0 - FRESH_MS : T0 - 2 * DAY
            const { events } = review([account([window("7d", used, resetAt)], [grant("g", expiresAt, WEEKLY)], at, listed)])
            // Carried from FRESH_MS before is at the edge: no longer fresh.
            const due = age < FRESH_MS && listing === "with the reading" && resetAt !== undefined && resetAt > expiresAt
            const label = `age ${age / MINUTE} min, grants ${listing}, natural reset ${resetAt === undefined ? "unread" : (resetAt - T0) / HOUR + " h"}, used ${used}`
            expect(claimsOf(events).length, label).toBe(due ? 1 : 0)
          }
  })

  test("a claim that never came back is sent again only on fresh evidence", () => {
    const expiresAt = T0 + 3 * HOUR
    const first = review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)])])
    expect(claimsOf(first.events)).toHaveLength(1)
    const later = T0 + RETRY_MS
    // The reading the claim was decided on, now stale: no retry.
    expect(claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)])], later, first.state).events)).toEqual([])
    // A fresh one: the same claim again, under the same request id.
    const again = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g", expiresAt, WEEKLY)], later)], later, first.state).events)
    expect(again.map((reset) => reset.requestID)).toEqual([claimsOf(first.events)[0]!.requestID])
  })
})

describe("M2: a reset is worth what it restores", () => {
  test("over kinds × windows × Fable's share source × reset ordering: every automatic claim restores at least MIN_RESTORE of a window that outlives the grant", () => {
    const expiresAt = T0 + 2 * HOUR
    const credits = [WEEKLY, SESSION, FULL, FABLE]
    const shares = [{ weeklyUsed: 0 }, { weeklyUsed: 0.3 }, { ofWeekly: 0.5 }, {}] as const
    let claimed = 0
    for (const fields of credits)
      for (const five of [0.2, 1])
        for (const fiveResets of [T0 + HOUR, T0 + 3 * HOUR])
          for (const week of [0.5, 1])
            for (const own of [0, 0.12, 1])
              for (const ownResets of [T0 + HOUR, T0 + 3 * DAY])
                for (const share of shares) {
                  const credit = grant("g", expiresAt, fields)
                  const item = account(
                    [window("5h", five, fiveResets), window("7d", week, T0 + 3 * DAY), window("7d:Fable", own, ownResets, share)],
                    [credit],
                  )
                  const due = claimsOf(review([item]).events)
                  const useful = effectOf("claude", item, credit).some(
                    (give) => give.resetAt !== undefined && give.resetAt > expiresAt && give.from - give.to >= MIN_RESTORE,
                  )
                  if (due.length > 0) claimed++
                  expect(due.length === 0 || useful, `${fields.kind} 5h ${five} week ${week} Fable ${own} share ${JSON.stringify(share)}`).toBe(true)
                }
    // The property is not vacuous: some cases claim.
    expect(claimed).toBeGreaterThan(0)
  })

  test("the verifier's case: the shared week spent, Fable's reported part 0%, Fable's week and the 5-hour window resetting before the grant ends: nothing claimed", () => {
    const credit = grant("g", T0 + 2 * HOUR, FABLE)
    const item = account([window("5h", 0.2, T0 + HOUR), window("7d:Fable", 0.12, T0 + HOUR, { weeklyUsed: 0 }), window("7d", 1, T0 + 3 * DAY)], [credit])
    expect(claimsOf(review([item]).events)).toEqual([])
  })
})

describe("B1: one claim at a time per account", () => {
  const spent = (at = T0, used = 1) => account([window("7d", used, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, WEEKLY), grant("g2", T0 + 2 * HOUR, WEEKLY)], at)

  test("one spent reading with two expiring grants claims one; nothing more until a reading newer than the claim, and then only if still worth it", () => {
    const first = review([spent()])
    expect(claimsOf(first.events).map((reset) => reset.creditID)).toEqual(["g1"])
    const settled = run([[T0 + MINUTE, SettleClaim.make({ key: claimsOf(first.events)[0]!.key, outcome: "reset", before: [] })]], first.state)
    // The same reading, reviewed after the claim: it predates the claim, so it says nothing of its effect.
    expect(claimsOf(review([spent()], T0 + 2 * MINUTE, settled.state).events)).toEqual([])
    // A reading after the claim shows the week emptied: g2 restores nothing and stays.
    expect(claimsOf(review([spent(T0 + 2 * MINUTE, 0)], T0 + 3 * MINUTE, settled.state).events)).toEqual([])
    // Spent again later the same week, with fresh evidence: the window period was claimed for already, so not again on its own.
    expect(claimsOf(review([spent(T0 + HOUR)], T0 + HOUR, settled.state).events)).toEqual([])
  })

  test("the key and the request id name the account, the window and its period, not the grant", () => {
    const one = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g1", T0 + 2 * HOUR, WEEKLY)])]).events)[0]!
    const other = claimsOf(review([account([window("7d", 1, T0 + 3 * DAY)], [grant("g2", T0 + 2 * HOUR, WEEKLY)])]).events)[0]!
    expect(one.key).toBe(expiringKey("claude", "anthropic", "a", "7d", T0 + 3 * DAY))
    expect(other.key).toBe(one.key)
    expect(other.requestID).toBe(one.requestID)
    // A restart keeps it: the state round-trips through JSON and the retry is the same claim.
    const state = JSON.parse(JSON.stringify(review([spent()]).state)) as ResetsState
    const retried = claimsOf(review([spent(T0 + RETRY_MS)], T0 + RETRY_MS, state).events)
    expect(retried.map((reset) => reset.requestID)).toEqual([one.requestID])
  })

  test("an open offer on an account a claim is now due on is withdrawn, and its later yes spends nothing", () => {
    const early = T0 - 2 * DAY
    const item = (at: number) => account([window("5h", 0.2, at + 3 * HOUR), window("7d", 0.9, T0 + 4 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)], at)
    const offered = run([
      [early, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [early, Review.make({ pools: [view([item(early), roomy])] })],
    ])
    const ask = asksOf(offered.events)[0]
    expect(ask?.why).toBe("offer")
    const expiry = review([item(T0)], T0, offered.state)
    expect(expiry.events.map((event) => event._tag)).toEqual(["AskWithdrawn", "ClaimDue"])
    expect(expiry.events[0]).toMatchObject({ key: ask!.key })
    expect(claimsOf(run([[T0 + 1, TakeAnswer.make({ key: ask!.key, answer: "Claim it" })]], expiry.state).events)).toEqual([])
  })

  test("a yes on an offer whose account was claimed on meanwhile withdraws instead of claiming", () => {
    const early = T0 - 2 * DAY
    const item = account([window("5h", 0.2, early + 3 * HOUR), window("7d", 0.95, T0 + 4 * DAY)], [grant("g", T0 + 60 * DAY, WEEKLY)], early)
    const offered = run([
      [early, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [early, Review.make({ pools: [view([item, roomy])] })],
    ])
    const ask = asksOf(offered.events)[0]!
    // Another claim on the account is in flight (a Codex-like held claim, an expiring one): the yes waits for nothing and spends nothing.
    const busy: ResetsState = {
      ...offered.state,
      resets: { ...offered.state.resets, other: { ...ask, key: "other", creditID: "g2", why: "expiring", stage: "claiming", at: T0, attempts: 1 } },
    }
    const answered = run([[T0 + 1, TakeAnswer.make({ key: ask.key, answer: "Claim it" })]], busy)
    expect(claimsOf(answered.events)).toEqual([])
    expect(answered.events.map((event) => event._tag)).toEqual(["AskWithdrawn"])
  })
})

describe("M3: a declined offer suppresses its account, kind and week", () => {
  const credit = grant("g", T0 + 60 * DAY, { ...FABLE, clears: ["seven_day_overage_included"] })
  const item = (own: number, week: number, weekResets = T0 + 6 * DAY) =>
    account([window("7d:Fable", own, weekResets, { ofWeekly: 1 }), window("7d", week, weekResets)], [credit])

  test("after a no, no reading of the same week asks again, whichever window ranks first; a new week or another kind may", () => {
    const first = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([item(1, 0.95), roomy])] })],
    ])
    const ask = asksOf(first.events)[0]!
    expect(ask.key).toBe(offerKey("claude", "anthropic", "a", "fable", T0 + 6 * DAY))
    const declined = run([[T0 + 1, TakeAnswer.make({ key: ask.key, answer: "Don't claim" })]], first.state).state
    for (const own of [0.3, 0.5, 0.9, 1])
      for (const week of [0.9, 0.95, 1]) {
        const next = run([
          [T0 + MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
          [T0 + MINUTE, Review.make({ pools: [view([item(own, week), roomy])] })],
        ], declined)
        expect(asksOf(next.events), `Fable ${own}, week ${week}`).toEqual([])
      }
    // The next week: offerable again.
    const nextWeek = T0 + 7 * DAY
    const later = run([
      [nextWeek, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [nextWeek, Review.make({ pools: [view([account([window("7d:Fable", 1, nextWeek + 6 * DAY, { ofWeekly: 1 }), window("7d", 0.95, nextWeek + 6 * DAY)], [credit], nextWeek), roomy])] })],
    ], declined)
    expect(asksOf(later.events)).toHaveLength(1)
    // Another kind the same week: offerable.
    const weekly = run([
      [T0 + MINUTE, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0 + MINUTE, Review.make({ pools: [view([account([window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])] })],
    ], declined)
    expect(asksOf(weekly.events).map((reset) => reset.kind)).toEqual(["weekly"])
  })
})

describe("auto: false, the owner's kill switch", () => {
  test("claims nothing on its own, Claude's or Codex's, fresh evidence or not; offers and a held start's question go on", () => {
    const expiring = account([window("7d", 1, T0 + 3 * DAY)], [grant("g", T0 + 2 * HOUR, WEEKLY)])
    expect(claimsOf(review([expiring], T0, Resets.initial, false).events)).toEqual([])
    expect(claimsOf(review([expiring], T0, Resets.initial, true).events)).toHaveLength(1)
    // Codex: every account held and a start waiting claims a credit unless auto is off.
    const codex = view([{ ...account([window("7d", 1, T0 + 3 * DAY)], [{ id: "c", count: 1, usable: true, status: "available", expiresAt: T0 + 20 * DAY }]), credentialID: "x" }], {}, "codex")
    for (const auto of [true, false]) {
      const { events } = run([
        [T0, NoteWait.make({ pool: "openai", sessionID: "ses_root" })],
        [T0, Review.make({ pools: [codex], auto })],
      ])
      expect(claimsOf(events).length, `auto ${auto}`).toBe(auto ? 1 : 0)
    }
    // An offer is still asked.
    const offer = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])], auto: false })],
    ])
    expect(asksOf(offer.events).map((reset) => reset.why)).toEqual(["offer"])
  })

  test("a yes still claims: the owner's answer is not automatic", () => {
    const offer = run([
      [T0, NoteWait.make({ pool: "anthropic", sessionID: "ses_root" })],
      [T0, Review.make({ pools: [view([account([window("5h", 0.2, T0 + 3 * HOUR), window("7d", 0.95, T0 + 6 * DAY)], [grant("w", T0 + 60 * DAY, WEEKLY)]), roomy])], auto: false })],
    ])
    const key = asksOf(offer.events)[0]!.key
    expect(claimsOf(run([[T0 + 1, TakeAnswer.make({ key, answer: "Claim it" })]], offer.state).events)).toHaveLength(1)
  })
})

test("EXPIRING_MS is the last day", () => expect(EXPIRING_MS).toBe(DAY))
