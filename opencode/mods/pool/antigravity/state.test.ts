// The reading store against a small reference model: generated sequences of
// readings (each window reported, absent or unknown), pane limits, failed
// reads and clock advances. After every step: an unknown window is never
// shown or treated as unlimited, a limit whose reset has passed is never
// "limited", "open now / open at T" is always a finite answer or a typed
// unknown, the answer is the model's, and reads keep their spacing.
import { describe, expect, test } from "bun:test"
import type { Span, Window } from "./quota.ts"
import { answerAt, backoffMs, due, EMPTY, Event, evolve, keychainAllowed, READ_EVERY_MS, type State, Why } from "./state.ts"
import { statusLines } from "./text.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse("2026-11-25T00:00:00Z")
const GROUPS = ["gemini", "claude-gpt"] as const
const SPANS: ReadonlyArray<Span> = ["5h", "7d"]
const WHY_TAGS = new Set(Object.keys(Why.cases))

/** A seeded generator: the same seed, the same sequence. */
const generator = (seed: number) => {
  let state = Math.max((seed * 2654435761) >>> 0, 1)
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}
type Random = ReturnType<typeof generator>
const pick = <A>(random: Random, from: ReadonlyArray<A>): A => from[Math.floor(random() * from.length)] as A

/** The reference: the newest reading's windows, the newest limit, nothing else. */
interface Model {
  readonly readAt?: number
  readonly windows: ReadonlyArray<Window>
  readonly limit?: { readonly seenAt: number; readonly resetAt?: number; readonly group?: string }
}

type Expected = { readonly tag: "Open" } | { readonly tag: "Limited"; readonly until: number } | { readonly tag: "Unknown" }

const expected = (model: Model, now: number, group: string): Expected => {
  const limit = model.limit
  const applies = limit !== undefined && (limit.group === undefined || limit.group === group)
  if (applies && limit.resetAt !== undefined && limit.resetAt > now) return { tag: "Limited", until: limit.resetAt }
  if (applies && limit.resetAt === undefined && !(model.readAt !== undefined && model.readAt > limit.seenAt)) return { tag: "Unknown" }
  if (model.readAt === undefined) return { tag: "Unknown" }
  const live = model.windows.filter((window) => window.group === group && (window.resetAt === undefined || window.resetAt > now))
  const full = live.filter((window) => window.used >= 1)
  if (full.some((window) => window.resetAt === undefined)) return { tag: "Unknown" }
  if (full.length > 0) return { tag: "Limited", until: Math.max(...full.map((window) => window.resetAt ?? 0)) }
  return SPANS.every((span) => live.some((window) => window.span === span)) ? { tag: "Open" } : { tag: "Unknown" }
}

const generatedWindows = (random: Random, now: number): ReadonlyArray<Window> =>
  GROUPS.flatMap((group) =>
    SPANS.flatMap((span): ReadonlyArray<Window> => {
      const roll = random()
      if (roll < 0.25) return []
      const used = roll < 0.4 ? 1 : Math.round(random() * 100) / 100
      const base = { group, label: group, span, used }
      if (random() < 0.2) return [base]
      return [{ ...base, resetAt: now + Math.floor(random() * (span === "5h" ? 5 * HOUR : 7 * 24 * HOUR)) - 10 * MINUTE }]
    }),
  )

describe("Antigravity reading store", () => {
  test("generated sequences hold the invariants and the reference model's answers", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const random = generator(seed)
      let now = START
      let state: State = EMPTY
      let model: Model = { windows: [] }
      for (let step = 0; step < 60; step++) {
        const roll = random()
        if (roll < 0.3) {
          const windows = generatedWindows(random, now)
          state = evolve(state, Event.cases.Read.make({ at: now, windows }))
          model = { ...model, readAt: now, windows }
          expect(due(state, now + READ_EVERY_MS - 1)).toBe(false)
          expect(due(state, now + READ_EVERY_MS)).toBe(true)
        } else if (roll < 0.45) {
          const before = state.failures
          state = evolve(state, Event.cases.Failed.make({ at: now, why: pick(random, [Why.cases.SignInExpired.make({}), Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 }), Why.cases.NoQuota.make({})]) }))
          expect(state.failures).toBe(before + 1)
          expect(state.nextReadAt).toBe(now + Math.min(READ_EVERY_MS * 2 ** (before + 1), HOUR))
          expect(state.nextReadAt - now).toBeGreaterThanOrEqual(READ_EVERY_MS)
        } else if (roll < 0.6) {
          const withReset = random() < 0.8
          const group = random() < 0.3 ? pick(random, GROUPS) : undefined
          const resetAt = now + Math.floor(random() * 3 * HOUR) - 30 * MINUTE
          const limit = { seenAt: now, ...(withReset ? { resetAt } : {}), ...(group === undefined ? {} : { group }) }
          state = evolve(state, Event.cases.LimitSeen.make({ limit }))
          model = { ...model, limit }
        } else {
          now += Math.floor(random() * 2 * HOUR)
        }
        for (const group of GROUPS) {
          const answer = answerAt(state, now, group)
          const reference = expected(model, now, group)
          expect(answer._tag).toBe(reference.tag)
          if (answer._tag === "Limited") {
            expect(Number.isFinite(answer.until)).toBe(true)
            expect(answer.until).toBeGreaterThan(now)
            if (reference.tag === "Limited") expect(answer.until).toBe(reference.until)
          }
          if (answer._tag === "Unknown") expect(WHY_TAGS.has(answer.why._tag)).toBe(true)
          // A limit whose reset has passed never holds by itself.
          if (model.limit?.resetAt !== undefined && model.limit.resetAt <= now) expect(answer._tag === "Limited" && answer.by === "limit").toBe(false)
          // Open only with both windows read and live.
          if (answer._tag === "Open")
            for (const span of SPANS) expect(model.windows.some((window) => window.group === group && window.span === span && (window.resetAt === undefined || window.resetAt > now))).toBe(true)
        }
        const lines = statusLines(state, now)
        expect(lines.join("\n")).not.toMatch(/unlimited|100% left|no limit/i)
        for (const group of GROUPS)
          for (const span of SPANS) {
            const live = model.windows.some((window) => window.group === group && window.span === span && (window.resetAt === undefined || window.resetAt > now))
            const row = lines.filter((line) => line.startsWith(`  ${span} `))[GROUPS.indexOf(group)]
            if (!live) expect(row).toStartWith(`  ${span} unknown`)
          }
      }
    }
  })

  test("a keychain refusal stops every later attempt until the owner asks", () => {
    for (const outcome of ["denied", "failed", "timed-out"] as const) {
      const refused = evolve(EMPTY, Event.cases.KeychainTried.make({ at: START, outcome }))
      expect(keychainAllowed(refused)).toBe(false)
      expect(keychainAllowed(evolve(refused, Event.cases.Failed.make({ at: START + HOUR, why: Why.cases.NoSignIn.make({}) })))).toBe(false)
      const asked = evolve(refused, Event.cases.RetryAsked.make({ at: START + HOUR }))
      expect(keychainAllowed(asked)).toBe(true)
      expect(asked.askedAt).toBe(START + HOUR)
      expect(due(asked, START + HOUR)).toBe(true)
    }
    for (const outcome of ["read", "absent"] as const) expect(keychainAllowed(evolve(EMPTY, Event.cases.KeychainTried.make({ at: START, outcome })))).toBe(true)
  })

  test("the backoff doubles from five minutes to an hour", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([10, 20, 40, 60, 60, 60].map((minutes) => minutes * MINUTE))
  })
})
