// One credit in one window period has one identity, its key and its request
// id, for as long as the period lasts, whatever jitter the readings of its end
// carry and whichever host reads; and the attempt limit bounds what is sent.
//
// - The case measured on the Mac (2026-11-24..26): Anthropic ends a week on
//   the hour and its `resets_at` wobbles by about a second across it
//   (13:59:59.760, 14:00:00.485, 01:59:59.358). A 30-minute floor gave one
//   credit two keys and two request ids: the attempt limit reset itself (one
//   login tried 5 times), and a claim re-sent near the hour went out under an
//   id the provider could not dedupe.
// - Properties: ends on the hour read by two hosts with any jitter below half
//   an hour name one claim (pure); ends anywhere read with jitter within
//   PERIOD_JITTER_MS on one host, across restarts, take one record, one
//   request id and at most MAX_ATTEMPTS sends, however many tries go unsent.
// - The migration: a claim recorded under the old 30-minute key goes again as
//   itself, under the request id it was decided with, never under a new one.
// - A try not sent (an unread account, held back, unreachable, stale) is no
//   claim: no record among the claims, no attempt spent, and it goes again by
//   its cause, never on a fixed beat.
// The Resets decider alone, its state through the store's codec for a
// restart; here, beside the memory layers, for the Effect test runner the
// pool's domain folder does not import.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Match, Option, Schema } from "effect"
import { fold } from "@dotfiles/decider/decider"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"
import type { QuotaReading, ResetCredit } from "../quota.ts"
import {
  claimRequestID,
  type Command,
  type Event,
  expiringKey,
  MAX_ATTEMPTS,
  NoteSend,
  PERIOD_JITTER_MS,
  type PoolView,
  pushKey,
  requestIdOf,
  type Reset,
  Resets,
  ResetsState,
  RETRY_MS,
  REUSE_MS,
  reusableReading,
  Review,
  SettleClaim,
  SettleUnsent,
  UNSENT_RETRY_MAX_MS,
  UNSENT_RETRY_MS,
  unsentRetryAt,
} from "../resets.ts"
import type { AccountStatus } from "../status.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A seeded generator (mulberry32): `next(n)` an integer below `n`, `between(low, high)` a real in [low, high). */
const generator = (seed: number) => {
  let state = seed >>> 0
  const real = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next: (n: number) => Math.floor(real() * n), between: (low: number, high: number) => low + real() * (high - low) }
}

/** The commands decided in turn, each at its time, on `state`: the events and the state after. */
const run = (commands: ReadonlyArray<readonly [number, Command]>, state: ResetsState = Resets.initial) =>
  Effect.gen(function* () {
    let current = state
    const events: Array<Event> = []
    for (const [now, command] of commands) {
      const decided = yield* Resets.decide(current, command, now)
      events.push(...decided)
      current = fold(Resets, decided, current)
    }
    return { events, state: current }
  })

type ClaimDue = Extract<Event, { readonly _tag: "ClaimDue" }>
const dues = (events: ReadonlyArray<Event>) => events.flatMap((event) => Arr.filter([event], (one): one is ClaimDue => one._tag === "ClaimDue")).map((event) => event.reset)

/** The state as the store writes it and reads it back: a restart. */
const restart = (state: ResetsState): ResetsState => Schema.decodeUnknownSync(ResetsState)(Schema.encodeSync(ResetsState)(state))

describe("the case measured on the Mac", () => {
  const now = Date.parse("2026-11-25T22:19:00Z")
  const before = Date.parse("2026-11-26T01:59:59.358Z")
  const after = Date.parse("2026-11-26T02:00:00.312Z")
  const credit = { id: "f", kind: "fable" as const, count: 1, usable: true, givesBack: true, expiresAt: now + 30 * DAY, clears: ["seven_day_overage_included"] }
  const account = (resetAt: number) =>
    ({
      credentialID: "a",
      live: 0,
      load: 0,
      noRoom: false,
      reading: {
        at: now,
        windows: [
          { name: "7d", utilization: 0.89, resetAt },
          { name: "7d:Fable", utilization: 1, weeklyUsed: 0.3, ofWeekly: 0.5, resetAt },
        ],
        resets: { available: 1, credits: [credit] },
      },
    }) satisfies AccountStatus

  test("a claim's key is the same claim across a one-second jitter of its period's end", () => {
    expect(expiringKey("claude", "a", "7d:Fable", before)).toBe(expiringKey("claude", "a", "7d:Fable", after))
  })

  test("a claim's request id is the same claim across a one-second jitter of its period's end", () => {
    expect(claimRequestID("claude", account(before), credit, now)).toBe(claimRequestID("claude", account(after), credit, now))
  })
})

type Provider = "claude" | "codex"
const POOLS: Readonly<Record<Provider, string>> = { claude: "anthropic", codex: "openai" }
/** Each provider's credit, expiring within a day: a Codex reset, a full Claude grant. */
const CREDITS: Readonly<Record<Provider, (at: number) => ResetCredit>> = {
  codex: (at) => ({ id: "c1", count: 1, usable: true, expiresAt: at + 20 * HOUR }),
  claude: (at) => ({ id: "g1", count: 1, usable: true, expiresAt: at + 20 * HOUR, clears: ["five_hour", "seven_day"], kind: "full", requiresLimit: false }),
}

/** One account, its 5-hour and weekly windows spent and ending about `end` and `end + 3 days`, a credit expiring within a day: due at once, on the 5-hour window. */
const spent = (provider: Provider, end: number, at: number): PoolView => {
  const reading: QuotaReading = {
    at,
    windows: [
      { name: "5h", utilization: 1, resetAt: end },
      { name: "7d", utilization: 1, resetAt: end + 3 * DAY },
    ],
    resets: { available: 1, credits: [CREDITS[provider](at)] },
  }
  return { id: POOLS[provider], provider, accounts: [{ credentialID: "a", live: 0, load: 0, noRoom: false, reading }], labels: { a: "1" }, running: 0 }
}

describe("one identity across jitter (properties)", () => {
  test("ends on the hour, two hosts each reading with any jitter below half an hour: one key, one request id, one push key", () => {
    const random = generator(20261126)
    const base = Date.parse("2026-01-01T00:00:00Z")
    // The jitters measured on the Mac first, then any below half an hour.
    const seenOnTheMac = [-240, 485, 249, 326, 587, -642]
    for (let sample = 0; sample < 5_000; sample++) {
      const end = base + random.next(24 * 365) * HOUR
      const jitter = () => Option.getOrElse(Arr.get(seenOnTheMac, sample), () => random.between(-30 * MINUTE + 1, 30 * MINUTE - 1))
      const [mac, workbox] = [end + jitter(), end - jitter()]
      const label = `end ${end}, readings ${mac - end} ms and ${workbox - end} ms off`
      for (const provider of ["claude", "codex"] as const) {
        const [one, two] = [spent(provider, mac, end - HOUR), spent(provider, workbox, end - HOUR)]
        const credit = CREDITS[provider](end - HOUR)
        expect([label, expiringKey(provider, "a", "5h", mac)]).toEqual([label, expiringKey(provider, "a", "5h", workbox)])
        expect([label, claimRequestID(provider, one.accounts[0]!, credit, end - HOUR)]).toEqual([label, claimRequestID(provider, two.accounts[0]!, credit, end - HOUR)])
      }
      expect([label, pushKey("p", "a", mac)]).toEqual([label, pushKey("p", "a", workbox)])
    }
  })

  effectTest(
    "ends anywhere, readings within PERIOD_JITTER_MS of each other, tries sent or not and restarts between them: one record, one request id, at most MAX_ATTEMPTS sends",
    Effect.gen(function* () {
      const random = generator(42)
      const base = Date.parse("2026-03-01T00:00:00Z")
      for (let sample = 0; sample < 400; sample++) {
        const provider = (["claude", "codex"] as const)[random.next(2)]!
        // Half the ends sit right on the hour or the half hour, the old floor's boundaries; the rest anywhere.
        const start = base + random.next(24 * 300) * HOUR
        const end = start + 4 * HOUR + [random.next(2) * 30 * MINUTE, random.next(HOUR)][random.next(2)]!
        const reading = () => end + random.between(-PERIOD_JITTER_MS / 2, PERIOD_JITTER_MS / 2)
        let state = Resets.initial
        let now = start
        let sends = 0
        const ids = new Set<string>()
        const keys = new Set<string>()
        for (let step = 0; step < 16 && now < end - 30 * MINUTE; step++) {
          const decided = yield* run([[now, Review.make({ pools: [spent(provider, reading(), now)] })]], state)
          expect(dues(decided.events).length).toBeLessThanOrEqual(1)
          state = decided.state
          for (const reset of dues(decided.events)) {
            ids.add(reset.requestID)
            keys.add(reset.key)
            if (random.next(3) === 0) {
              state = (yield* run([[now, SettleUnsent.make({ key: reset.key, why: "unread", cause: "rate-limited", message: "not sent: rate limited" })]], state)).state
            } else {
              sends++
              state = (yield* run([[now, NoteSend.make({ key: reset.key })], [now, SettleClaim.make({ key: reset.key, outcome: "failed", before: [] })]], state)).state
            }
          }
          if (random.next(2) === 0) state = restart(state)
          now += RETRY_MS + random.next(20 * MINUTE)
        }
        const label = `${provider} end ${end}`
        expect([label, ids.size <= 1, keys.size <= 1, sends <= MAX_ATTEMPTS]).toEqual([label, true, true, true])
      }
    }),
    hangGuard("in-memory"),
  )
})

describe("claims in flight at the install (migration)", () => {
  const now = Date.parse("2026-11-25T22:20:00Z")
  const end = Date.parse("2026-11-26T02:00:00.312Z")
  const view = spent("claude", end, now)
  // The key and request id as the code before 2026-11-26 named them: the period's 30-minute floor, read 688 ms before the hour
  // (the key's period the 5-hour window's, the request id's the week's, a full grant's).
  const floor = (at: number) => String(Math.floor(at / (30 * MINUTE)))
  const legacy: Reset = {
    key: `claude-expiring:a:5h:${floor(end - 1_000)}`,
    pool: "anthropic",
    provider: "claude",
    credentialID: "a",
    label: "1",
    creditID: "g1",
    requestID: requestIdOf(`claude:g1:full:${floor(end + 3 * DAY - 1_000)}:1`),
    why: "expiring",
    stage: "failed",
    at: now - RETRY_MS,
    attempts: 1,
    outcome: "failed",
  }

  effectTest(
    "a claim recorded under the old key goes again as itself, under its old request id, and never under a new one",
    Effect.gen(function* () {
      let state: ResetsState = { ...Resets.initial, resets: { [legacy.key]: legacy } }
      const sent: Array<Pick<Reset, "key" | "requestID">> = []
      for (let step = 0; step < 8; step++) {
        const at = now + step * RETRY_MS
        const decided = yield* run([[at, Review.make({ pools: [spent("claude", end + [-900, 300][step % 2]!, at)] })]], state)
        state = decided.state
        for (const reset of dues(decided.events)) {
          sent.push({ key: reset.key, requestID: reset.requestID })
          state = (yield* run([[at, SettleClaim.make({ key: reset.key, outcome: "failed", before: [] })]], state)).state
        }
      }
      expect(sent).toEqual(Array.from({ length: MAX_ATTEMPTS - 1 }, () => ({ key: legacy.key, requestID: legacy.requestID })))
      expect(Object.keys(state.resets)).toEqual([legacy.key])
      expect(claimRequestID("claude", view.accounts[0]!, CREDITS.claude(now), now)).not.toBe(legacy.requestID)
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "a claim settled under the old key keeps its period: no second claim of that inventory",
    Effect.gen(function* () {
      const state: ResetsState = { ...Resets.initial, resets: { [legacy.key]: { ...legacy, stage: "settled", outcome: "nothing-to-reset", attempts: 1 } } }
      expect(dues((yield* run([[now, Review.make({ pools: [view] })]], state)).events)).toEqual([])
    }),
    hangGuard("unit-law"),
  )
})

describe("a try not sent is no claim", () => {
  const now = Date.parse("2026-11-25T22:20:00Z")
  const view = (at: number) => spent("claude", Date.parse("2026-11-26T02:00:00Z"), at)
  /** The claim a review decides at `now`, and the state it leaves. */
  const decided = Effect.gen(function* () {
    const first = yield* run([[now, Review.make({ pools: [view(now)] })]])
    const reset = yield* Effect.fromOption(Arr.head(dues(first.events)))
    return { state: first.state, key: reset.key, requestID: reset.requestID }
  })
  const review = (at: number, state: ResetsState) => Effect.map(run([[at, Review.make({ pools: [view(at)] })]], state), (after) => ({ ...after, dues: dues(after.events) }))

  effectTest(
    "an unread account: recorded unsent with its cause, no claim recorded, no attempt spent, the next try on growing back-off",
    Effect.gen(function* () {
      let { state, key, requestID } = yield* decided
      let at = now
      const waits: Array<number> = []
      for (let tries = 1; tries <= 4; tries++) {
        state = (yield* run([[at, SettleUnsent.make({ key, why: "unread", cause: "server-error", message: "not sent: the account could not be read just before the claim (a server error)" })]], state)).state
        const reset = state.resets[key]!
        expect(reset).toMatchObject({ stage: "failed", attempts: 0, unsent: { why: "unread", cause: "server-error", tries } })
        // Matched apart: bun 1.4.4's toMatchObject wrote an asymmetric matcher into the state it matched (seen here, `message: {}`).
        expect(reset.message).toMatch(/^not sent: /)
        expect(reset.outcome).toBeUndefined()
        expect(state.claims).toEqual([])
        const retryAt = reset.retryAt!
        waits.push(retryAt - at)
        // Not before its back-off, whatever RETRY_MS says; then the same claim.
        expect((yield* review(retryAt - 1, state)).dues).toEqual([])
        const again = yield* review(retryAt, state)
        expect(again.dues.map((due) => [due.key, due.requestID])).toEqual([[key, requestID]])
        state = again.state
        at = retryAt
      }
      expect(waits).toEqual([UNSENT_RETRY_MS, 2 * UNSENT_RETRY_MS, 4 * UNSENT_RETRY_MS, 8 * UNSENT_RETRY_MS])
      // Bounded: the back-off grows to UNSENT_RETRY_MAX_MS and stays there.
      expect([5, 6, 40].map((tries) => unsentRetryAt(now, tries) - now)).toEqual([UNSENT_RETRY_MAX_MS, UNSENT_RETRY_MAX_MS, UNSENT_RETRY_MAX_MS])
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "the wait before the next try is the longer of what the endpoint asked and the back-off of its tries (the back-off capped, the endpoint's wait never cut)",
    Effect.gen(function* () {
      const { state, key } = yield* decided
      const settle = (retryAfterMs: Option.Option<number>) =>
        Effect.map(
          run([[now, SettleUnsent.make({ key, why: "unread", cause: "rate-limited", message: "not sent", ...Option.match(retryAfterMs, { onNone: () => ({}), onSome: (wait) => ({ retryAfterMs: wait }) }) })]], state),
          (after) => after.state.resets[key]!.retryAt! - now,
        )
      expect(yield* settle(Option.some(25 * MINUTE))).toBe(25 * MINUTE)
      expect(yield* settle(Option.some(1_000))).toBe(UNSENT_RETRY_MS)
      expect(yield* settle(Option.none())).toBe(UNSENT_RETRY_MS)
      expect(yield* settle(Option.some(3 * HOUR))).toBe(3 * HOUR)
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "a login that keeps answering rate limited with a short retry-after is tried less and less often, up to the cap (the review's P2: twelve tries a minute apart)",
    Effect.gen(function* () {
      // A window period long enough for every try: twelve back-offs run past a day's 5-hour period.
      const long = (at: number) => spent("claude", now + 20 * HOUR, at)
      const first = yield* run([[now, Review.make({ pools: [long(now)] })]])
      const key = (yield* Effect.fromOption(Arr.head(dues(first.events)))).key
      let state = first.state
      let at = now
      const waits: Array<number> = []
      for (let tries = 1; tries <= 12; tries++) {
        state = (yield* run([[at, SettleUnsent.make({ key, why: "unread", cause: "rate-limited", retryAfterMs: 1_000, message: "not sent" })]], state)).state
        const retryAt = state.resets[key]!.retryAt!
        waits.push((retryAt - at) / MINUTE)
        // Not a minute later, as the endpoint's retry-after alone would have it; at its back-off, the same claim.
        expect(dues((yield* run([[at + MINUTE, Review.make({ pools: [long(at + MINUTE)] })]], state)).events)).toEqual([])
        at = retryAt
        const again = yield* run([[at, Review.make({ pools: [long(at)] })]], state)
        expect(dues(again.events).map((due) => due.key)).toEqual([key])
        state = again.state
      }
      expect(waits).toEqual([10, 20, 40, 80, 120, 120, 120, 120, 120, 120, 120, 120])
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "held back, or a peer unreachable: unsent, to go again; the send-time check finding it no longer pays: unsent, never a provider's nothing-to-reset, and decided again as itself once it pays, no sooner than its back-off",
    Effect.gen(function* () {
      for (const why of ["backed-off", "unreachable"] as const) {
        const { state, key } = yield* decided
        const after = (yield* run([[now, SettleUnsent.make({ key, why, message: "backed off: a peer refused" })]], state)).state
        expect(after.resets[key]).toMatchObject({ stage: "failed", attempts: 0, unsent: { why, tries: 1 }, retryAt: now + UNSENT_RETRY_MS })
        expect(after.claims).toEqual([])
      }
      const { state, key, requestID } = yield* decided
      const stale = yield* run([[now, SettleUnsent.make({ key, why: "stale", message: "not sent: the reset is no longer listed as claimable" })]], state)
      expect(stale.state.resets[key]).toMatchObject({ stage: "settled", attempts: 0, unsent: { why: "stale", tries: 1 }, retryAt: now + UNSENT_RETRY_MS, message: "not sent: the reset is no longer listed as claimable" })
      expect(stale.state.resets[key]!.outcome).toBeUndefined()
      expect(stale.state.claims).toEqual([])
      expect(stale.events.some((event) => event._tag === "OwnerTold")).toBe(false)
      // The same period, before its back-off: not decided again, nor while the credit is unlisted.
      expect((yield* review(now + UNSENT_RETRY_MS - 1, stale.state)).dues).toEqual([])
      const unlisted = { ...view(now + UNSENT_RETRY_MS), accounts: view(now + UNSENT_RETRY_MS).accounts.map((account) => ({ ...account, reading: { ...account.reading!, resets: { available: 0, credits: [] } } })) }
      expect(dues((yield* run([[now + UNSENT_RETRY_MS, Review.make({ pools: [unlisted] })]], stale.state)).events)).toEqual([])
      // Listed and worth it again after its back-off: decided again, as itself, its attempts and tries kept.
      const again = yield* review(now + UNSENT_RETRY_MS, stale.state)
      expect(again.dues.map((due) => [due.key, due.requestID, due.attempts, due.unsent?.tries])).toEqual([[key, requestID, 0, 1]])
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "a try sent after unsent ones is a claim: recorded, its attempt spent, the unsent tries forgotten",
    Effect.gen(function* () {
      const { state, key } = yield* decided
      const unsent = (yield* run([[now, SettleUnsent.make({ key, why: "unread", cause: "network", message: "not sent" })]], state)).state
      const retryAt = unsent.resets[key]!.retryAt!
      const sent = (yield* run([[retryAt, Review.make({ pools: [view(retryAt)] })], [retryAt, NoteSend.make({ key })], [retryAt, SettleClaim.make({ key, outcome: "failed", message: "timeout", before: [] })]], unsent)).state
      expect(sent.resets[key]).toMatchObject({ stage: "failed", attempts: 1, outcome: "failed" })
      expect(sent.resets[key]!.unsent).toBeUndefined()
      expect(sent.resets[key]!.retryAt).toBeUndefined()
      expect(sent.claims.map((claim) => claim.outcome)).toEqual(["failed"])
      // A sent try that failed goes again RETRY_MS after it, as before.
      expect((yield* review(retryAt + RETRY_MS - 1, sent)).dues).toEqual([])
      expect((yield* review(retryAt + RETRY_MS, sent)).dues).toHaveLength(1)
    }),
    hangGuard("unit-law"),
  )
})

describe("the check before a claim stands on the sweep's reading when it is fresh enough", () => {
  const now = Date.parse("2026-11-25T22:20:00Z")
  const reset = { key: "k", credentialID: "a" }
  const reading = (at: number, extra: Partial<QuotaReading> = {}): AccountStatus => ({
    credentialID: "a",
    live: 0,
    load: 0,
    noRoom: false,
    reading: { at, usage: { at, samples: 1 }, windows: [{ name: "7d", utilization: 1, resetAt: now + DAY }], resets: { available: 1, credits: [] }, ...extra },
  })

  test("a usage reading within REUSE_MS, after the account's last claim, with its resets read with it, stands; any other is read again", () => {
    expect(Option.isSome(reusableReading(Resets.initial, reset, reading(now - REUSE_MS), now))).toBe(true)
    expect(Option.isNone(reusableReading(Resets.initial, reset, reading(now - REUSE_MS - 1), now))).toBe(true)
    // A header reading (no usage sample), one without its resets, one carrying older windows or resets.
    const { usage: _usage, ...header } = reading(now).reading!
    expect(Option.isNone(reusableReading(Resets.initial, reset, { ...reading(now), reading: header }, now))).toBe(true)
    const { resets: _resets, ...bare } = reading(now).reading!
    expect(Option.isNone(reusableReading(Resets.initial, reset, { ...reading(now), reading: bare }, now))).toBe(true)
    expect(Option.isNone(reusableReading(Resets.initial, reset, reading(now, { resets: { at: now - 2 * MINUTE, available: 1, credits: [] } }), now))).toBe(true)
    expect(Option.isNone(reusableReading(Resets.initial, reset, reading(now, { windows: [{ name: "7d", utilization: 1, resetAt: now + DAY, at: now - 2 * MINUTE }] }), now))).toBe(true)
    // This claim's own last send, or another claim on the account, after the reading: read again.
    expect(Option.isNone(reusableReading(Resets.initial, { ...reset, sentAt: now - 10_000 }, reading(now - 20_000), now))).toBe(true)
    const other: Reset = { key: "other", pool: "anthropic", provider: "claude", credentialID: "a", label: "1", creditID: "g", requestID: "pool-x", why: "forecast", stage: "settled", at: now - 10_000, attempts: 1 }
    expect(Option.isNone(reusableReading({ ...Resets.initial, resets: { other } }, reset, reading(now - 20_000), now))).toBe(true)
    // The claim being judged is not its own last claim.
    expect(Option.isSome(reusableReading({ ...Resets.initial, resets: { k: { ...other, key: "k", stage: "claiming", at: now } } }, reset, reading(now - 20_000), now))).toBe(true)
  })
})

describe("a reset in hand is never lost unused by the pool's own bookkeeping", () => {
  const start = Date.parse("2026-11-26T10:00:00Z")
  const weekEnd = Date.parse("2026-11-28T14:00:00.326Z")
  const expiresAt = start + 5 * HOUR
  const grant: ResetCredit = { id: "g1", count: 1, usable: true, expiresAt, clears: ["five_hour", "seven_day"], kind: "full", requiresLimit: false }
  /** The week spent, no 5-hour window read (any window may be absent), the grant listed or not, work running. */
  const expiring = (at: number, listed: boolean, windows: ReadonlyArray<QuotaReading["windows"][number]> = [{ name: "7d", utilization: 1, resetAt: weekEnd }]): PoolView => {
    const reading: QuotaReading = { at, windows, resets: { available: Number(listed), credits: [grant].filter(() => listed) } }
    return { id: "anthropic", provider: "claude", accounts: [{ credentialID: "a", live: 0, load: 0, noRoom: false, reading }], labels: { a: "1" }, running: 1 }
  }
  const first = Effect.gen(function* () {
    const decided = yield* run([[start, Review.make({ pools: [expiring(start, true)] })]])
    const due = yield* Effect.fromOption(Arr.head(dues(decided.events)))
    return { state: decided.state, due }
  })

  effectTest(
    "the review's P1: the grant found unlisted at the send, then listed again and expiring: claimed before it expires, as the same claim",
    Effect.gen(function* () {
      const { state: decided, due } = yield* first
      let state = (yield* run([[start, SettleUnsent.make({ key: due.key, why: "stale", message: "not sent: the reset is no longer listed as claimable" })]], decided)).state
      const later: Array<readonly [string, string]> = []
      for (let at = start + 10 * MINUTE; at < expiresAt; at += 10 * MINUTE) {
        const next = yield* run([[at, Review.make({ pools: [expiring(at, true)] })]], state)
        state = next.state
        for (const reset of dues(next.events)) {
          later.push([reset.key, reset.requestID])
          state = (yield* run([[at, NoteSend.make({ key: reset.key })], [at, SettleClaim.make({ key: reset.key, outcome: "reset", before: [] })]], state)).state
        }
      }
      expect(later).toEqual([[due.key, due.requestID]])
    }),
    hangGuard("unit-law"),
  )

  /** A record as the build before this one left it: its tries recorded as failed claims, `not sent: …`, whether or not one went out. */
  const oldRecord = (due: Reset, sent: boolean, stage: "failed" | "settled"): Reset => {
    const { unsent: _unsent, retryAt: _retryAt, ...rest } = due
    const outcome = Match.value(stage).pipe(Match.when("failed", () => "failed" as const), Match.orElse(() => "nothing-to-reset" as const))
    const old: Reset = { ...rest, stage, at: start, attempts: MAX_ATTEMPTS, outcome, message: "not sent: the account could not be read just before the claim" }
    return Match.value(sent).pipe(Match.when(true, (): Reset => ({ ...old, sentAt: start - HOUR })), Match.orElse(() => old))
  }

  effectTest(
    "an old store: a record whose tries never went out (no send noted) goes again as itself; one with a send noted, its count unknown, stays closed",
    Effect.gen(function* () {
      const { due } = yield* first
      const at = start + RETRY_MS
      const after = (record: Reset) =>
        Effect.map(run([[at, Review.make({ pools: [expiring(at, true)] })]], Schema.decodeUnknownSync(ResetsState)(Schema.encodeSync(ResetsState)({ ...Resets.initial, resets: { [record.key]: record } }))), (decided) =>
          dues(decided.events).map((reset) => [reset.key, reset.requestID]),
        )
      for (const stage of ["failed", "settled"] as const) {
        expect([stage, yield* after(oldRecord(due, false, stage))]).toEqual([stage, [[due.key, due.requestID]]])
        expect([stage, yield* after(oldRecord(due, true, stage))]).toEqual([stage, []])
      }
      // A provider's answer closes it, old or new.
      expect(yield* after({ ...oldRecord(due, true, "settled"), message: "nothing to reset" })).toEqual([])
      expect(yield* after({ ...oldRecord(due, false, "settled"), outcome: "reset", message: "reset" })).toEqual([])
    }),
    hangGuard("unit-law"),
  )

  type Random = ReturnType<typeof generator>
  /** A history's start: the store the old build left (the first try recorded `not sent`, as a failure or as nothing to reset), else this build's stale try. */
  const opening = (decided: ResetsState, due: Reset, old: boolean, random: Random) =>
    Match.value(old).pipe(
      Match.when(true, () =>
        Effect.succeed({
          state: { ...Resets.initial, resets: { [due.key]: { ...oldRecord(due, false, (["failed", "settled"] as const)[random.next(2)]!), attempts: 1 + random.next(MAX_ATTEMPTS) } } },
          next: start + RETRY_MS,
        }),
      ),
      Match.orElse(() =>
        Effect.map(run([[start, SettleUnsent.make({ key: due.key, why: "stale", message: "not sent" })]], decided), (after) => ({ state: after.state, next: after.state.resets[due.key]!.retryAt! })),
      ),
    )
  /** One review's reading: the grant listed or not; any window may be absent, the 5-hour one often, once in a while the week too (nothing to judge on). */
  const readAt = (at: number, random: Random) => {
    const listed = random.next(4) !== 0
    const week = random.next(8) !== 0
    const windows = [{ name: "7d", utilization: 1, resetAt: weekEnd }, { name: "5h", utilization: 0.4, resetAt: at + 2 * HOUR }].filter((window) =>
      Match.value(window.name).pipe(Match.when("7d", () => week), Match.orElse(() => random.next(2) === 0)),
    )
    return { listed, week, windows }
  }
  /** What became of a try: not sent (no longer worth it, or rate limited with any wait asked), else sent and answered failed or reset. */
  const settleTry = (state: ResetsState, reset: Reset, at: number, random: Random) =>
    Match.value(random.next(5)).pipe(
      Match.when(0, () => Effect.map(run([[at, SettleUnsent.make({ key: reset.key, why: "stale", message: "not sent" })]], state), (after) => ({ state: after.state, sent: false, closed: false }))),
      Match.when(1, () =>
        Effect.map(run([[at, SettleUnsent.make({ key: reset.key, why: "unread", cause: "rate-limited", retryAfterMs: random.next(30) * MINUTE, message: "not sent" })]], state), (after) => ({ state: after.state, sent: false, closed: false })),
      ),
      Match.orElse(() => {
        const outcome = (["failed", "failed", "reset"] as const)[random.next(3)]!
        return Effect.map(run([[at, NoteSend.make({ key: reset.key })], [at, SettleClaim.make({ key: reset.key, outcome, before: [] })]], state), (after) => ({ state: after.state, sent: true, closed: outcome === "reset" }))
      }),
    )

  effectTest(
    "generated histories (the grant listed, unlisted a while, listed again; windows unread; tries sent, unsent or answered; restarts; an old store): a claimable grant is tried once its wait has passed, under one identity, sent at most MAX_ATTEMPTS times",
    Effect.gen(function* () {
      const random = generator(1126)
      for (let sample = 0; sample < 300; sample++) {
        const { state: decided, due } = yield* first
        // Half the histories start on a store the old build left: the first try recorded `not sent`, as a failure or as nothing to reset.
        const old = random.next(2) === 0
        let { state, next } = yield* opening(decided, due, old, random)
        let sends = 0
        let closed = false
        let missed: Array<number> = []
        const ids = new Set([due.requestID])
        const keys = new Set([due.key])
        for (let at = start + random.next(5) * MINUTE + MINUTE; at < expiresAt - 10 * MINUTE; at += 5 * MINUTE + random.next(10) * MINUTE) {
          const { listed, week, windows } = readAt(at, random)
          const decidedNow = yield* run([[at, Review.make({ pools: [expiring(at, listed, windows)] })]], state)
          state = decidedNow.state
          const tried = dues(decidedNow.events)
          if (listed && week && !closed && sends < MAX_ATTEMPTS && at >= next && tried.length === 0) missed = [...missed, at]
          for (const reset of tried) {
            ids.add(reset.requestID)
            keys.add(reset.key)
            const fate = yield* settleTry(state, reset, at, random)
            state = fate.state
            sends += Number(fate.sent)
            closed = closed || fate.closed
            next = Option.getOrElse(Option.fromUndefinedOr(state.resets[reset.key]!.retryAt), () => at + RETRY_MS)
          }
          if (random.next(3) === 0) state = restart(state)
        }
        const label = `sample ${sample}, old store ${old}`
        expect([label, missed, [...keys], [...ids], sends <= MAX_ATTEMPTS]).toEqual([label, [], [due.key], [due.requestID], true])
      }
    }),
    hangGuard("in-memory"),
  )
})
