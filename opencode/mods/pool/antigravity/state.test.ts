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
import { hangGuard } from "../../../tests/hang-guard.ts"
import { openText, statusLines } from "./text.ts"

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

interface ModelLimit {
  readonly group: string
  readonly seenAt: number
  readonly resetAt: Option.Option<number>
}

/** The reference: the newest reading's time and windows, each group's newest limit, nothing else. */
interface Model {
  readonly readAt: Option.Option<number>
  readonly windows: ReadonlyArray<Window>
  readonly limits: ReadonlyArray<ModelLimit>
}

const Expected = Schema.TaggedUnion({ Open: {}, Limited: { until: Schema.Finite }, LimitedResetUnknown: {}, Unmeasured: {}, Unknown: {} })
type Expected = typeof Expected.Type

const resetOf = (window: Window) => Option.fromUndefinedOr(window.resetAt)
const liveAt = (window: Window, now: number) => !Option.exists(resetOf(window), (at) => at <= now)

/** The model's answer, read off its rules in order: the pane's limit, then nothing read, full windows, both windows read. */
const expected = (model: Model, now: number, group: string): Expected => {
  const limit = Arr.findFirst(model.limits, (seen) => seen.group === group)
  const until = Option.flatMap(limit, (seen) => Option.filter(seen.resetAt, (at) => at > now))
  if (Option.isSome(until)) return Expected.cases.Limited.make({ until: until.value })
  const silent = Option.exists(limit, (seen) => Option.isNone(seen.resetAt) && !Option.exists(model.readAt, (at) => at > seen.seenAt))
  if (silent) return Expected.cases.LimitedResetUnknown.make({})
  if (Option.isNone(model.readAt)) return Expected.cases.Unmeasured.make({})
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
  const id = `read-${world.now}`
  const floor = world.now + backoffMs(world.state.failures)
  const state = evolve(evolve(world.state, Event.cases.Attempted.make({ id, at: world.now, keychain: false })), Event.cases.Read.make({ attempt: id, at: world.now, windows }))
  // The floor runs from the attempt, whoever made it: never under five minutes.
  expect(due(state, floor - 1)).toBe(false)
  expect(due(state, floor)).toBe(true)
  expect(floor - world.now).toBeGreaterThanOrEqual(READ_EVERY_MS)
  return { ...world, state, model: { ...world.model, readAt: Option.some(world.now), windows } }
}

const fail = (random: Random, world: World): World => {
  const before = world.state.failures
  const why = pick<Why>(random, [Why.cases.SignInExpired.make({}), Why.cases.RequestFailed.make({ why: "rate-limited", status: 429 }), Why.cases.NoQuota.make({})])
  const id = `fail-${world.now}`
  const state = evolve(evolve(world.state, Event.cases.Attempted.make({ id, at: world.now, keychain: false })), Event.cases.Failed.make({ attempt: id, at: world.now, why }))
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
  const named: ReadonlyArray<string> = Option.match(group, { onNone: () => GROUPS, onSome: (one) => [one] })
  const limits = [...world.model.limits.filter((seen) => !named.includes(seen.group)), ...named.map((one) => ({ group: one, seenAt: world.now, resetAt }))]
  return { ...world, state, model: { ...world.model, limits } }
}

const clearLimit = (random: Random, world: World): World => {
  const group = either(random, 0.5, () => Option.some<string>(pick(random, GROUPS)), () => Option.none<string>())
  const named: ReadonlyArray<string> = Option.match(group, { onNone: () => GROUPS, onSome: (one) => [one] })
  const state = evolve(world.state, Option.match(group, { onNone: () => Event.cases.LimitCleared.make({}), onSome: (one) => Event.cases.LimitCleared.make({ group: one }) }))
  return { ...world, state, model: { ...world.model, limits: world.model.limits.filter((seen) => !named.includes(seen.group)) } }
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
        expect(Expected.match(reference, { Limited: (limited) => limited.until, Open: () => -1, LimitedResetUnknown: () => -1, Unmeasured: () => -1, Unknown: () => -1 })).toBe(until)
        // A limit whose reset has passed never holds by itself.
        if (by === "limit") expect(Option.exists(Option.flatMap(Arr.findFirst(model.limits, (seen) => seen.group === group), (seen) => seen.resetAt), (at) => at > now)).toBe(true)
      },
      LimitedResetUnknown: ({ seenAt }) => expect(seenAt).toBeLessThanOrEqual(now),
      // Not measured only with nothing read: usable, never "open", never a hold.
      Unmeasured: ({ why }) => {
        expect(Option.isNone(model.readAt)).toBe(true)
        expect(WHY_TAGS.has(why._tag)).toBe(true)
        expect(openText(answer)).toStartWith("usable: yes, unmeasured")
      },
      Unknown: ({ why }) => expect(WHY_TAGS.has(why._tag)).toBe(true),
    })
  }
  const lines = statusLines(state, now)
  expect(lines.join("\n")).not.toMatch(/unlimited|100% left|no limit(?! seen)/i)
  GROUPS.forEach((group, index) => {
    for (const span of SPANS) {
      const live = model.windows.some((window) => window.group === group && window.span === span && liveAt(window, now))
      const row = Option.getOrElse(Arr.get(lines.filter((line) => line.startsWith(`  ${span} `)), index), () => "")
      if (!live) expect(row).toStartWith(`  ${span} unknown`)
    }
  })
}

const STEPS = [read, fail, seeLimit, clearLimit, advance] as const
const WEIGHTS = [0.3, 0.15, 0.15, 0.05, 0.35]

describe("Antigravity reading store", () => {
  test("generated sequences hold the invariants and the reference model's answers", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const random = generator(seed)
      let world: World = { now: START, state: EMPTY, model: { readAt: Option.none(), windows: [], limits: [] } }
      for (let step = 0; step < 60; step++) {
        const roll = random()
        const index = WEIGHTS.findIndex((_weight, at) => roll < WEIGHTS.slice(0, at + 1).reduce((sum, weight) => sum + weight, 0))
        const next = Option.getOrElse(Arr.get(STEPS, index), () => advance)
        world = next(random, world)
        check(world)
      }
    }
  }, hangGuard("in-memory"))

  test("three states: limited until T, measured open, not measured; a limit with no reset holds until a reading with room or a clear", () => {
    const gemini = (state: State, now: number) => answerAt(state, now, "gemini")._tag
    expect(gemini(EMPTY, START)).toBe("Unmeasured")
    const limited = evolve(EMPTY, Event.cases.LimitSeen.make({ limit: { seenAt: START, resetAt: START + HOUR } }))
    expect(answerAt(limited, START, "gemini")).toEqual(Answer.cases.Limited.make({ until: START + HOUR, by: "limit" }))
    expect(answerAt(limited, START, "claude-gpt")._tag).toBe("Limited")
    expect(answerAt(limited, START + 2 * HOUR, "gemini")).toEqual(Answer.cases.Unmeasured.make({ why: Why.cases.NotRead.make({}), since: START + HOUR }))
    const roomy = Event.cases.Read.make({
      attempt: "room",
      at: START + 3 * HOUR,
      windows: SPANS.map((span) => ({ group: "gemini", label: "Gemini", span, used: 0.3, resetAt: START + 5 * HOUR })),
    })
    const room = (state: State) => evolve(evolve(state, Event.cases.Attempted.make({ id: "room", at: START + 3 * HOUR, keychain: false })), roomy)
    expect(gemini(room(limited), START + 3 * HOUR)).toBe("Open")
    const silent = evolve(EMPTY, Event.cases.LimitSeen.make({ limit: { seenAt: START, group: "Gemini" } }))
    expect(gemini(silent, START + 30 * HOUR)).toBe("LimitedResetUnknown")
    expect(answerAt(silent, START, "claude-gpt")._tag).toBe("Unmeasured")
    expect(gemini(evolve(silent, Event.cases.LimitCleared.make({ group: "gemini" })), START)).toBe("Unmeasured")
    expect(gemini(room(silent), START + 3 * HOUR)).toBe("Open")
  })

  test("one consent buys exactly one keychain attempt, whatever it comes to", () => {
    for (const outcome of ["read", "absent", "denied", "failed", "timed-out"] as const) {
      expect(keychainAllowed(EMPTY)).toBe(false)
      const consented = evolve(EMPTY, Event.cases.ConsentGiven.make({ at: START }))
      expect(keychainAllowed(consented)).toBe(true)
      const attempted = evolve(consented, Event.cases.Attempted.make({ id: "a", at: START, keychain: true }))
      expect(keychainAllowed(attempted)).toBe(false)
      expect(attempted.keychain).toEqual({ at: START, outcome: "started" })
      const answered = evolve(attempted, Event.cases.KeychainTried.make({ at: START + MINUTE, outcome }))
      expect(keychainAllowed(answered)).toBe(false)
      expect(keychainAllowed(evolve(answered, Event.cases.Read.make({ attempt: "a", at: START + MINUTE, windows: [] })))).toBe(false)
      expect(keychainAllowed(evolve(answered, Event.cases.ConsentGiven.make({ at: START + HOUR })))).toBe(true)
    }
    // A consent is for one read: an attempt from a token file drops it unused.
    const consented = evolve(EMPTY, Event.cases.ConsentGiven.make({ at: START }))
    expect(keychainAllowed(evolve(consented, Event.cases.Attempted.make({ id: "f", at: START, keychain: false })))).toBe(false)
  })

  test("a result is kept only while its attempt is the state's: an older one, another process's, changes nothing", () => {
    const first = evolve(EMPTY, Event.cases.Attempted.make({ id: "first", at: START, keychain: false }))
    const second = evolve(first, Event.cases.Attempted.make({ id: "second", at: START + 10 * MINUTE, keychain: false }))
    const late = evolve(second, Event.cases.Read.make({ attempt: "first", at: START + 11 * MINUTE, windows: [] }))
    expect(late).toEqual(second)
    expect(evolve(second, Event.cases.Failed.make({ attempt: "first", at: START + 11 * MINUTE, why: Why.cases.NoQuota.make({}) }))).toEqual(second)
    expect(evolve(second, Event.cases.Read.make({ attempt: "second", at: START + 11 * MINUTE, windows: [] })).reading).toEqual({ at: START + 11 * MINUTE, windows: [] })
  })

  test("the backoff doubles from five minutes to an hour", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([10, 20, 40, 60, 60, 60].map((minutes) => minutes * MINUTE))
  })
})
