// The reading store against a small reference model: generated sequences of
// readings (each window reported, absent or unknown), pane limits, failed
// reads and clock advances. After every step: an unknown window is never
// shown or treated as unlimited, a limit whose reset has passed is never
// "limited", "open now / open at T" is always a finite answer or a typed
// unknown, the answer is the model's, and reads keep their spacing.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Match, Option, Schema } from "effect"
import type { Span, Window } from "./quota.ts"
import { Answer, answerAt, backoffMs, due, EMPTY, Event, evolve, keychainAllowed, READ_EVERY_MS, type State, Why } from "./state.ts"
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
const pick = <A,>(random: Random, from: readonly [A, ...ReadonlyArray<A>]): A => Option.getOrElse(Arr.get(from, Math.floor(random() * from.length)), () => from[0])

/** `often()` with chance `p`, else `rarely()`. */
const either = <A,>(random: Random, p: number, often: () => A, rarely: () => A): A =>
  Option.getOrElse(Arr.get([rarely, often], Number(random() < p)), () => rarely)()

/** The reference: the newest reading's time and windows, the newest limit, nothing else. */
interface Model {
  readonly readAt: Option.Option<number>
  readonly windows: ReadonlyArray<Window>
  readonly limit: Option.Option<{ readonly seenAt: number; readonly resetAt: Option.Option<number>; readonly group: Option.Option<string> }>
}

const Expected = Schema.TaggedUnion({ Open: {}, Limited: { until: Schema.Finite }, Unknown: {} })
type Expected = typeof Expected.Type

const resetOf = (window: Window) => Option.fromUndefinedOr(window.resetAt)
const liveAt = (window: Window, now: number) => !Option.exists(resetOf(window), (at) => at <= now)

/** The model's answer, read off its rules in order: the pane's limit, then nothing read, full windows, both windows read. */
const expected = (model: Model, now: number, group: string): Expected => {
  const limit = Option.filter(model.limit, (seen) => !Option.exists(seen.group, (named) => named !== group))
  const until = Option.flatMap(limit, (seen) => Option.filter(seen.resetAt, (at) => at > now))
  if (Option.isSome(until)) return Expected.cases.Limited.make({ until: until.value })
  const silent = Option.exists(limit, (seen) => Option.isNone(seen.resetAt) && !Option.exists(model.readAt, (at) => at > seen.seenAt))
  if (silent || Option.isNone(model.readAt)) return Expected.cases.Unknown.make({})
  const live = model.windows.filter((window) => window.group === group && liveAt(window, now))
  const full = live.filter((window) => window.used >= 1)
  if (full.some((window) => Option.isNone(resetOf(window)))) return Expected.cases.Unknown.make({})
  const resets = full.flatMap((window) => Option.toArray(resetOf(window)))
  if (resets.length > 0) return Expected.cases.Limited.make({ until: Math.max(...resets) })
  if (SPANS.every((span) => live.some((window) => window.span === span))) return Expected.cases.Open.make({})
  return Expected.cases.Unknown.make({})
}

const generatedWindows = (random: Random, now: number): ReadonlyArray<Window> =>
  GROUPS.flatMap((group) =>
    SPANS.flatMap((span): ReadonlyArray<Window> => {
      const roll = random()
      if (roll < 0.25) return []
      const used = either(random, 0.2, () => 1, () => Math.round(random() * 100) / 100)
      const base = { group, label: group, span, used }
      const length = Match.value(span).pipe(Match.when("5h", () => 5 * HOUR), Match.orElse(() => 7 * 24 * HOUR))
      return [either(random, 0.8, () => ({ ...base, resetAt: now + Math.floor(random() * length) - 10 * MINUTE }), () => base)]
    }),
  )

interface World {
  readonly now: number
  readonly state: State
  readonly model: Model
}

const read = (random: Random, world: World): World => {
  const windows = generatedWindows(random, world.now)
  const state = evolve(world.state, Event.cases.Read.make({ at: world.now, windows }))
  expect(due(state, world.now + READ_EVERY_MS - 1)).toBe(false)
  expect(due(state, world.now + READ_EVERY_MS)).toBe(true)
  return { ...world, state, model: { ...world.model, readAt: Option.some(world.now), windows } }
}

const fail = (random: Random, world: World): World => {
  const before = world.state.failures
  const why = pick<Why>(random, [Why.cases.SignInExpired.make({}), Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 }), Why.cases.NoQuota.make({})])
  const state = evolve(world.state, Event.cases.Failed.make({ at: world.now, why }))
  expect(state.failures).toBe(before + 1)
  expect(state.nextReadAt).toBe(world.now + Math.min(READ_EVERY_MS * 2 ** (before + 1), HOUR))
  expect(state.nextReadAt - world.now).toBeGreaterThanOrEqual(READ_EVERY_MS)
  return { ...world, state }
}

const seeLimit = (random: Random, world: World): World => {
  const resetAt = either(random, 0.8, () => Option.some(world.now + Math.floor(random() * 3 * HOUR) - 30 * MINUTE), () => Option.none<number>())
  const group = either(random, 0.3, () => Option.some<string>(pick(random, GROUPS)), () => Option.none<string>())
  const base = { seenAt: world.now }
  const withReset = Option.match(resetAt, { onNone: () => base, onSome: (at) => ({ ...base, resetAt: at }) })
  const limit = Option.match(group, { onNone: () => withReset, onSome: (named) => ({ ...withReset, group: named }) })
  const state = evolve(world.state, Event.cases.LimitSeen.make({ limit }))
  return { ...world, state, model: { ...world.model, limit: Option.some({ seenAt: world.now, resetAt, group }) } }
}

const advance = (random: Random, world: World): World => ({ ...world, now: world.now + Math.floor(random() * 2 * HOUR) })

/** After each step: the answer is the model's, finite or a typed unknown, and no unknown is shown or taken as open. */
const check = (world: World) => {
  const { now, state, model } = world
  for (const group of GROUPS) {
    const answer = answerAt(state, now, group)
    const reference = expected(model, now, group)
    expect(answer._tag).toBe(reference._tag)
    Answer.match(answer, {
      Open: () => {
        for (const span of SPANS) expect(model.windows.some((window) => window.group === group && window.span === span && liveAt(window, now))).toBe(true)
      },
      Limited: ({ until, by }) => {
        expect(Number.isFinite(until)).toBe(true)
        expect(until).toBeGreaterThan(now)
        expect(Expected.match(reference, { Limited: (limited) => limited.until, Open: () => -1, Unknown: () => -1 })).toBe(until)
        // A limit whose reset has passed never holds by itself.
        if (by === "limit") expect(Option.exists(Option.flatMap(model.limit, (seen) => seen.resetAt), (at) => at > now)).toBe(true)
      },
      Unknown: ({ why }) => expect(WHY_TAGS.has(why._tag)).toBe(true),
    })
  }
  const lines = statusLines(state, now)
  expect(lines.join("\n")).not.toMatch(/unlimited|100% left|no limit/i)
  GROUPS.forEach((group, index) => {
    for (const span of SPANS) {
      const live = model.windows.some((window) => window.group === group && window.span === span && liveAt(window, now))
      const row = Option.getOrElse(Arr.get(lines.filter((line) => line.startsWith(`  ${span} `)), index), () => "")
      if (!live) expect(row).toStartWith(`  ${span} unknown`)
    }
  })
}

const STEPS = [read, fail, seeLimit, advance] as const
const WEIGHTS = [0.3, 0.15, 0.15, 0.4]

describe("Antigravity reading store", () => {
  test("generated sequences hold the invariants and the reference model's answers", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const random = generator(seed)
      let world: World = { now: START, state: EMPTY, model: { readAt: Option.none(), windows: [], limit: Option.none() } }
      for (let step = 0; step < 60; step++) {
        const roll = random()
        const index = WEIGHTS.findIndex((_weight, at) => roll < WEIGHTS.slice(0, at + 1).reduce((sum, weight) => sum + weight, 0))
        const next = Option.getOrElse(Arr.get(STEPS, index), () => advance)
        world = next(random, world)
        check(world)
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
