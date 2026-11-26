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
import { Array as Arr, Effect, Option, Schema } from "effect"
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
  UNSENT_RETRY_MIN_MS,
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
    const measured = [-240, 485, 249, 326, 587, -642]
    for (let sample = 0; sample < 5_000; sample++) {
      const end = base + random.next(24 * 365) * HOUR
      const jitter = () => Option.getOrElse(Arr.get(measured, sample), () => random.between(-30 * MINUTE + 1, 30 * MINUTE - 1))
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
    "a rate-limited read goes again once the wait it asked for has passed (at least UNSENT_RETRY_MIN_MS); without one, on the back-off",
    Effect.gen(function* () {
      const { state, key } = yield* decided
      const asked = (yield* run([[now, SettleUnsent.make({ key, why: "unread", cause: "rate-limited", retryAfterMs: 7 * MINUTE, message: "not sent" })]], state)).state
      expect(asked.resets[key]!.retryAt).toBe(now + 7 * MINUTE)
      const brief = (yield* run([[now, SettleUnsent.make({ key, why: "unread", cause: "rate-limited", retryAfterMs: 1_000, message: "not sent" })]], state)).state
      expect(brief.resets[key]!.retryAt).toBe(now + UNSENT_RETRY_MIN_MS)
      const silent = (yield* run([[now, SettleUnsent.make({ key, why: "unread", cause: "rate-limited", message: "not sent" })]], state)).state
      expect(silent.resets[key]!.retryAt).toBe(now + UNSENT_RETRY_MS)
    }),
    hangGuard("unit-law"),
  )

  effectTest(
    "held back, or a peer unreachable: unsent, to go again; the send-time check finding it no longer pays: settled unsent, never a provider's nothing-to-reset",
    Effect.gen(function* () {
      for (const why of ["backed-off", "unreachable"] as const) {
        const { state, key } = yield* decided
        const after = (yield* run([[now, SettleUnsent.make({ key, why, message: "backed off: a peer refused" })]], state)).state
        expect(after.resets[key]).toMatchObject({ stage: "failed", attempts: 0, unsent: { why, tries: 1 }, retryAt: now + UNSENT_RETRY_MS })
        expect(after.claims).toEqual([])
      }
      const { state, key } = yield* decided
      const stale = yield* run([[now, SettleUnsent.make({ key, why: "stale", message: "not sent: the reset is no longer listed as claimable" })]], state)
      expect(stale.state.resets[key]).toMatchObject({ stage: "settled", unsent: { why: "stale" }, message: "not sent: the reset is no longer listed as claimable" })
      expect(stale.state.resets[key]!.outcome).toBeUndefined()
      expect(stale.state.claims).toEqual([])
      expect(stale.events.some((event) => event._tag === "OwnerTold")).toBe(false)
      // The same period, later: that claim is not decided again.
      expect((yield* review(now + 3 * RETRY_MS, stale.state)).dues).toEqual([])
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
