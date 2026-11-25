// The three states of a usage window (REPORTED, ABSENT, UNKNOWN), over every
// combination of them on the 5-hour and weekly windows, every use level that
// binds or not, with and without a fresh usage read: what the pace may and may
// not do with each. The provider decoders map each answer's shape to these
// states (mods/anthropic-auth/quota.test.ts, chatgpt/usage.test.ts); here
// the pace reads only the states.
import { expect, test } from "bun:test"
import { Array as Arr, Match, Option, Schema } from "effect"
import { dispatchPace, lineOf, poolPace, STALE_AFTER_MS, type Pace, UNREAD_RETRY_MS } from "./pace.ts"
import { Absent, carryOver, type QuotaReading, type QuotaWindow, Reported, type UsageReadFailure, windowReading } from "./quota.ts"
import type { AccountStatus, Hold } from "./status.ts"

const now = Date.parse("2026-11-24T18:00:00Z")
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const OPUS = "claude-opus-5-5"

/** A window's state in a case: REPORTED at a use, ABSENT, UNKNOWN. */
const Used = Schema.TaggedStruct("Reported", { use: Schema.Number })
const None = Schema.TaggedStruct("Absent", {})
const Unread = Schema.TaggedStruct("Unknown", {})
const State = Schema.Union([Used, None, Unread])
type State = typeof State.Type
type Tracked = "5h" | "7d"

const RESETS = { "5h": now + hour, "7d": now + 3.5 * day }
/** 5h: room, at its hold line, spent. 7d: within the even line (54.5% now), past it, spent. */
const USES = { "5h": [0.2, 0.95, 1], "7d": [0.2, 0.7, 1] }
const statesOf = (name: Tracked): ReadonlyArray<State> => [
  ...USES[name].map((use): State => Used.make({ use })),
  None.make({}),
  Unread.make({}),
]

/** An account's reading with the 5-hour window in `short`, the week in `week`, and a usage sample when `usage`. */
const readingOf = (short: State, week: State, usage: boolean): QuotaReading => {
  const states = [["5h", short], ["7d", week]] as const
  const windows = states.flatMap(([name, state]): ReadonlyArray<QuotaWindow> =>
    Match.value(state).pipe(Match.tag("Reported", ({ use }) => [{ name, utilization: use, resetAt: RESETS[name] }]), Match.orElse(() => [])))
  const absent = states.flatMap(([name, state]) => Arr.filter([{ name, at: now }], () => state._tag === "Absent"))
  return {
    at: now,
    windows,
    ...Arr.match(absent, { onEmpty: () => ({}), onNonEmpty: (absent) => ({ absent }) }),
    ...Arr.match(Arr.filter([{ at: now, samples: 1 as const }], () => usage), { onEmpty: () => ({}), onNonEmpty: ([usage]) => ({ usage }) }),
  }
}

const accountOf = (credentialID: string, reading: QuotaReading): AccountStatus => ({ credentialID, live: 0, load: 0, noRoom: false, reading })
const reported = (state: State, at: (use: number) => boolean) => Match.value(state).pipe(Match.tag("Reported", ({ use }) => at(use)), Match.orElse(() => false))
const describeState = (state: State) => Match.value(state).pipe(Match.tag("Reported", ({ use }) => `reported at ${use}`), Match.orElse(({ _tag }) => _tag))
const cases = Arr.cartesian(Arr.cartesian(statesOf("5h"), statesOf("7d")), [true, false])

/** Every hold names a future, finite time to ask again. */
const futureRetry = (answer: Pace) =>
  Match.value(answer).pipe(Match.when({ ok: false }, (held) => Number.isFinite(held.retryAt) && held.retryAt > now), Match.orElse(() => true))

test("every combination of the three states, both windows, with and without a usage read: the pace's rules hold", () => {
  for (const [[short, week], usage] of cases) {
    const account = accountOf("a", readingOf(short, week, usage))
    const answer = dispatchPace([account], now, {}, 0.04, OPUS)
    const advisory = poolPace([account], now)
    const label = `5h ${describeState(short)}, 7d ${describeState(week)}, usage read: ${usage}`
    expect([label, futureRetry(answer), futureRetry(advisory)]).toEqual([label, true, true])
    const anyReported = short._tag === "Reported" || week._tag === "Reported"
    const anyUnknown = short._tag === "Unknown" || week._tag === "Unknown"
    const spent = reported(short, (use) => use >= 0.9) || reported(week, (use) => use >= 0.99)
    // An UNKNOWN window waits for one usage read only; ABSENT never waits.
    const waits = !usage && anyUnknown
    const unmeasured = usage && !spent && (week._tag === "Unknown" || (!anyReported && anyUnknown))
    const expected = Match.value({ waits, spent, past: reported(week, (use) => use === 0.7), unmeasured }).pipe(
      Match.when({ waits: true }, () => ({ ok: false, reasonCode: "usage-unread" })),
      Match.when({ spent: true }, () => ({ ok: false, reasonCode: "quota-limit" })),
      Match.when({ past: true }, () => ({ ok: false, reasonCode: "even-line" })),
      Match.when({ unmeasured: true }, () => ({ ok: true, measured: false, eligible: ["a"] })),
      Match.orElse(() => ({ ok: true, measured: true, admission: "ordinary", eligible: ["a"] })),
    )
    expect([label, answer]).toMatchObject([label, expected])
    if (unmeasured) expect([label, Option.isNone(Option.fromUndefinedOr(answer.admission))]).toEqual([label, true])
    // No hold without a reported window: a hold of a limit names a REPORTED window, and an unread wait is one read long.
    Match.value(answer).pipe(
      Match.when({ ok: false, reasonCode: "usage-unread" }, (held) => expect([label, held.retryAt <= now + UNREAD_RETRY_MS]).toEqual([label, true])),
      Match.when({ ok: false }, () => expect([label, anyReported]).toEqual([label, true])),
      Match.orElse(() => {}),
    )
    // A reported window at or past its limit always holds, with a future retry time no later than its own reset.
    Match.value(spent && !waits).pipe(
      Match.when(true, () => expect([label, answer.ok, answer.ok || answer.retryAt <= RESETS["7d"]]).toEqual([label, false, true])),
      Match.orElse(() => {}),
    )
  }
})

test("an account with no usage window at all is admitted and says so; with only a week, the week's even line still binds", () => {
  const none = dispatchPace([accountOf("a", readingOf(None.make({}), None.make({}), true))], now, {}, 0.04, OPUS)
  expect(none).toMatchObject({ ok: true, measured: true, admission: "ordinary", eligible: ["a"] })
  expect(none.reason).toContain("no usage windows at all")
  const ultra = (use: number) => dispatchPace([accountOf("a", readingOf(None.make({}), Used.make({ use }), true))], now, {}, 0.04, OPUS)
  expect(ultra(0.2)).toMatchObject({ ok: true, admission: "ordinary" })
  expect(ultra(0.7)).toMatchObject({ ok: false, reasonCode: "even-line" })
  expect(ultra(1)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: RESETS["7d"] })
  expect(ultra(1).reason).not.toContain("5-hour")
})

test("a mixed pool: past the even line, a start goes out only on an account with no week; a spent week is told before an unread login", () => {
  const paced = accountOf("paced", readingOf(Used.make({ use: 0.2 }), Used.make({ use: 0.7 }), true))
  const weekless = accountOf("weekless", readingOf(Used.make({ use: 0.2 }), None.make({}), true))
  const unknownWeek = accountOf("unknown-week", readingOf(Used.make({ use: 0.2 }), Unread.make({}), true))
  expect(dispatchPace([paced, weekless], now, {}, 0.04, OPUS)).toMatchObject({ ok: true, eligible: ["weekless"] })
  expect(dispatchPace([paced, unknownWeek], now, {}, 0.04, OPUS)).toMatchObject({ ok: false, reasonCode: "even-line" })
  const spent = accountOf("spent", readingOf(None.make({}), Used.make({ use: 1 }), true))
  const unread = accountOf("unread", readingOf(Unread.make({}), Used.make({ use: 0.2 }), false))
  const answer = dispatchPace([spent, unread], now, {}, 0.04, OPUS)
  expect(answer).toMatchObject({ ok: false, reasonCode: "quota-limit" })
  // The unread login is named, and its next read is when the pool asks again.
  expect(answer.reason).toContain("no 5h window in its reading")
  expect(Match.value(answer).pipe(Match.when({ ok: false }, (held) => held.retryAt <= now + UNREAD_RETRY_MS), Match.orElse(() => false))).toBe(true)
})

test("transitions between reads: REPORTED to ABSENT drops at once, ABSENT to REPORTED binds at once, REPORTED to UNKNOWN keeps the last until its reset", () => {
  const spent = readingOf(Used.make({ use: 1 }), Used.make({ use: 0.2 }), true)
  const later = (at: number, short: State): QuotaReading => ({ ...readingOf(short, Used.make({ use: 0.2 }), true), at, usage: { at, samples: 1 } })
  const dispatch = (reading: QuotaReading, at: number) => dispatchPace([accountOf("a", reading)], at, {}, 0.04, OPUS)
  const removed = carryOver(spent, { ...later(now + minute, None.make({})), absent: [{ name: "5h", at: now + minute }] })
  expect(windowReading(removed, "5h")._tag).toBe("Absent")
  expect(dispatch(removed, now + minute)).toMatchObject({ ok: true })
  const back = carryOver(removed, later(now + 2 * minute, Used.make({ use: 1 })))
  expect(windowReading(back, "5h")._tag).toBe("Reported")
  expect(dispatch(back, now + 2 * minute)).toMatchObject({ ok: false, reasonCode: "quota-limit" })
  // Headers with no 5-hour window cannot speak to it: the spent window binds until its own reset, then counts as unknown.
  const headers: QuotaReading = { at: now + 3 * minute, status: "allowed", windows: [{ name: "7d", utilization: 0.2, resetAt: RESETS["7d"] }] }
  const kept = carryOver(back, headers)
  expect(windowReading(kept, "5h")).toEqual(Reported.make({ window: { name: "5h", utilization: 1, resetAt: RESETS["5h"], at: now + 2 * minute } }))
  expect(dispatch(kept, now + 3 * minute)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: RESETS["5h"] })
  const after = carryOver(kept, { ...headers, at: RESETS["5h"] + minute })
  expect(windowReading(after, "5h")._tag).toBe("Unknown")
})

test("an older host's reading, without the absences, reads UNKNOWN, never ABSENT, and keeps the absence this host read", () => {
  const ultra = readingOf(None.make({}), Used.make({ use: 0.2 }), true)
  const older: QuotaReading = { at: now + minute, windows: [{ name: "7d", utilization: 0.2, resetAt: RESETS["7d"] }] }
  expect(windowReading(older, "5h")._tag).toBe("Unknown")
  expect(windowReading(carryOver(ultra, older), "5h")).toEqual(Absent.make({ at: now }))
  expect(Option.isSome(Option.fromUndefinedOr(carryOver(ultra, older).absent))).toBe(true)
})

test("B2: no REPORTED tracked window with an UNKNOWN one answers unmeasured, never measured or unlimited, and names the unread field", () => {
  const fresh = { at: now, samples: 1 as const }
  const q4 = accountOf("a", { at: now, usage: fresh, windows: [], absent: [{ name: "5h", at: now }], unrecognised: [] })
  const q4b = accountOf("a", { at: now, usage: fresh, windows: [], absent: [{ name: "5h", at: now }], unrecognised: ["seven_day"] })
  const q5 = accountOf("a", { at: now, usage: fresh, windows: [{ name: "seven_day_opus", utilization: 0.3, resetAt: now + day }], unrecognised: [] })
  for (const [account, field] of [[q4, "7d"], [q4b, "seven_day"], [q5, "5h, 7d"]] as const) {
    for (const answer of [dispatchPace([account], now, {}, 0.04, OPUS), poolPace([account], now)]) {
      expect(answer).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
      expect(answer.admission).toBeUndefined()
      expect(answer.reason).toContain("weekly pace unmeasured")
      expect(answer.reason).toContain(field)
      expect(answer.reason).not.toContain("limited by nothing")
      expect(answer.reason).not.toContain("5-hour window binds alone")
    }
  }
  const q6 = accountOf("a", { at: now, usage: fresh, windows: [{ name: "5h", utilization: 0.1, resetAt: RESETS["5h"] }], unrecognised: ["seven_day"] })
  const shortOnly = dispatchPace([q6], now, {}, 0.04, OPUS)
  expect(shortOnly).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
  expect(shortOnly.admission).toBeUndefined()
  expect(shortOnly.reason).toContain("5-hour window binds alone")
  expect(shortOnly.reason).toContain("7d")
  expect(shortOnly.reason).toContain("seven_day")
  expect(shortOnly.reason).not.toContain("limited by nothing")
  // N3-r2: missing and malformed fields both name the pool window consistently, plus the unreadable provider field.
  const mixedUnknown = accountOf("a", { at: now, usage: fresh, windows: [], unrecognised: ["seven_day"] })
  const mixedAnswer = dispatchPace([mixedUnknown], now, {}, 0.04, OPUS)
  expect(mixedAnswer).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
  expect(mixedAnswer.reason).toContain("5h, 7d")
  expect(mixedAnswer.reason).toContain("seven_day")
})

test("B1: a carried tracked window older than 30 min under a fresh usage read leaving it UNKNOWN does not block on staleness, yet still binds if spent", () => {
  const then = now - 40 * minute
  const held = (shortUse: number, weekUse: number): QuotaReading => ({
    at: then,
    usage: { at: then, samples: 1 },
    windows: [
      { name: "5h", utilization: shortUse, resetAt: now + 2 * hour },
      { name: "7d", utilization: weekUse, resetAt: now + 3 * day },
    ],
  })
  const cases: ReadonlyArray<QuotaReading> = [
    { at: now, usage: { at: now, samples: 1 }, windows: [{ name: "5h", utilization: 0.1, resetAt: now + 2 * hour }], unrecognised: ["seven_day"] },
    { at: now, usage: { at: now, samples: 1 }, windows: [{ name: "5h", utilization: 0.1, resetAt: now + 2 * hour }], unrecognised: [] },
    { at: now, usage: { at: now, samples: 1 }, windows: [{ name: "7d", utilization: 0.2, resetAt: now + 3 * day }], unrecognised: [] },
  ]
  for (const next of cases) {
    const carried = carryOver(held(0.1, 0.2), next)
    expect(dispatchPace([accountOf("a", carried)], now, {}, 0.04, OPUS)).toMatchObject({ ok: true, eligible: ["a"] })
    const refreshed: QuotaReading = {
      ...next,
      at: now + day,
      usage: { at: now + day, samples: 1 },
      windows: next.windows.map((window) => ({
        ...window,
        resetAt: Match.value(window.name).pipe(Match.when("5h", () => now + day + 2 * hour), Match.orElse(() => now + 3 * day)),
      })),
    }
    const later = carryOver(carried, refreshed)
    expect(dispatchPace([accountOf("a", later)], now + day, {}, 0.04, OPUS).ok).toBe(true)
  }
  const spentWeek = carryOver(held(0.1, 1), cases[0])
  expect(dispatchPace([accountOf("a", spentWeek)], now, {}, 0.04, OPUS)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: now + 3 * day })
  const spentShort = carryOver(held(1, 0.2), cases[2])
  expect(dispatchPace([accountOf("a", spentShort)], now, {}, 0.04, OPUS)).toMatchObject({ ok: false, reasonCode: "quota-limit", retryAt: now + 2 * hour })
})

test("N2-r2: an explicit window.at matching reading.at is not mistaken for a window carried past a fresh usage read", () => {
  const then = now - 40 * minute
  const stamped: QuotaReading = {
    at: then,
    usage: { at: then, samples: 1 },
    windows: [
      { name: "5h", utilization: 0.1, resetAt: now + 2 * hour, at: then },
      { name: "7d", utilization: 0.2, resetAt: now + 3 * day, at: then },
    ],
  }
  // Without a fresh usage read or a fresh failed read, explicit window.at does not bypass staleness.
  expect(dispatchPace([accountOf("a", stamped)], now, {}, 0.04, OPUS)).toMatchObject({ ok: false, reasonCode: "usage-unread" })
  // After one bounded failed read, the same measured login sends as unmeasured while its reported windows bind.
  const failed: AccountStatus = { ...accountOf("a", stamped), usageReadFailure: { failedAt: now, nextTryAt: now + UNREAD_RETRY_MS } }
  const afterFailure = dispatchPace([failed], now, {}, 0.04, OPUS)
  expect(afterFailure).toMatchObject({ ok: true, measured: false, eligible: ["a"] })
  expect(afterFailure.admission).toBeUndefined()
})

const lcg = (initial: number) => {
  let state = initial >>> 0
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % max
  }
}

const hasMeasured = (reading: Option.Option<QuotaReading>): boolean =>
  Option.exists(reading, (r) =>
    Option.isSome(Option.fromUndefinedOr(r.usage)) ||
    r.windows.length > 0 ||
    Option.exists(Option.fromUndefinedOr(r.absent), (entries) => entries.length > 0),
  )

const validWeekWindow = (window: QuotaWindow, at: number): boolean =>
  Option.exists(Option.fromUndefinedOr(window.resetAt), (resetAt) => resetAt > at && resetAt <= at + 7 * day + minute)

const pickState = (next: (n: number) => number, name: Tracked): State => {
  const choice = next(5)
  if (choice === 0) return Used.make({ use: USES[name][0]! })
  if (choice === 1) return Used.make({ use: USES[name][1]! })
  if (choice === 2) return Used.make({ use: USES[name][2]! })
  if (choice === 3) return None.make({})
  return Unread.make({})
}

const pickHeaderState = (next: (n: number) => number, name: Tracked): State => {
  if (next(3) === 0) return Unread.make({})
  return Used.make({ use: USES[name][next(3)]! })
}

const buildModelReading = (at: number, short: State, week: State, withUsage: boolean, unrecognised: ReadonlyArray<string>): QuotaReading => {
  const states = [["5h", short], ["7d", week]] as const
  const resetFor = (name: Tracked) => {
    if (name === "5h") return at + 3 * hour
    return at + 3.5 * day
  }
  const windows = states.flatMap(([name, state]): ReadonlyArray<QuotaWindow> =>
    Match.value(state).pipe(
      Match.tag("Reported", ({ use }) => [{ name, utilization: use, resetAt: resetFor(name) }]),
      Match.orElse(() => []),
    ),
  )
  const absent = states.flatMap(([name, state]) => Arr.filter([{ name, at }], () => state._tag === "Absent"))
  return {
    at,
    windows,
    ...Arr.match(absent, { onEmpty: () => ({}), onNonEmpty: (entries) => ({ absent: entries }) }),
    ...Arr.match(Arr.filter([{ at, samples: 1 as const }], () => withUsage), { onEmpty: () => ({}), onNonEmpty: ([usage]) => ({ usage }) }),
    ...Arr.match(Arr.filter([unrecognised], () => withUsage), { onEmpty: () => ({}), onNonEmpty: ([fields]) => ({ unrecognised: fields }) }),
  }
}

interface ModelState {
  readonly at: number
  readonly current: Option.Option<QuotaReading>
  readonly hold: Option.Option<Hold>
  readonly failure: Option.Option<UsageReadFailure>
}

const IDLE_DELTAS = [10 * minute, 35 * minute, 2 * hour, 4 * hour, 4 * day] as const

const pickBadField = (next: (n: number) => number): string => {
  if (next(2) === 0) return "seven_day"
  return "rate_limit.secondary_window"
}

const sampleUsageReading = (at: number, next: (n: number) => number): QuotaReading => {
  const short = pickState(next, "5h")
  let week = pickState(next, "7d")
  if (short._tag === "Unknown" && week._tag === "Unknown") week = Used.make({ use: USES["7d"][next(3)]! })
  const unrecognised = Arr.filter([pickBadField(next)], () => week._tag === "Unknown" && next(2) === 0)
  return buildModelReading(at, short, week, true, unrecognised)
}

interface ModelStep {
  readonly op: number
  readonly next: ModelState
}

const stepModel = (state: ModelState, next: (n: number) => number): ModelStep => {
  const op = next(6)
  const { at, current, hold, failure } = state
  if (op === 0 || op === 1) {
    const incoming = sampleUsageReading(at, next)
    return { op, next: { at, current: Option.some(carryOver(Option.getOrUndefined(current), incoming)), hold, failure: Option.none() } }
  }
  if (op === 2) {
    const short = pickHeaderState(next, "5h")
    const week = pickHeaderState(next, "7d")
    if (short._tag === "Reported" || week._tag === "Reported") {
      const incoming = buildModelReading(at, short, week, false, [])
      return { op, next: { at, current: Option.some(carryOver(Option.getOrUndefined(current), incoming)), hold, failure } }
    }
    return { op, next: state }
  }
  if (op === 3) return { op, next: { at, current, hold, failure: Option.some({ failedAt: at, nextTryAt: at + UNREAD_RETRY_MS }) } }
  if (op === 4) return { op, next: { at, current, hold: Option.some({ kind: "rate-limit", at, until: at + (1 + next(5)) * 15 * minute }), failure } }
  const moved = at + IDLE_DELTAS[next(IDLE_DELTAS.length)]!
  return { op, next: { at: moved, current, hold: Option.filter(hold, (h) => h.until > moved), failure } }
}

const checkModelInvariants = (state: ModelState, ctx: string) => {
  const { at, current, hold, failure } = state
  const account: AccountStatus = {
    credentialID: "a",
    live: 0,
    load: 0,
    noRoom: false,
    ...Option.match(current, { onNone: () => ({}), onSome: (reading) => ({ reading }) }),
    ...Option.match(hold, { onNone: () => ({}), onSome: (entry) => ({ hold: entry }) }),
    ...Option.match(failure, { onNone: () => ({}), onSome: (entry) => ({ usageReadFailure: entry }) }),
  }
  const answer = dispatchPace([account], at, {}, 0.04, OPUS)
  const advisory = poolPace([account], at)

  // Invariant 1: no hold without a finite future retry time.
  if (!answer.ok) expect([ctx, Number.isFinite(answer.retryAt), answer.retryAt > at]).toEqual([ctx, true, true])
  if (!advisory.ok) expect([ctx, Number.isFinite(advisory.retryAt), advisory.retryAt > at]).toEqual([ctx, true, true])

  const w5 = Option.flatMap(current, (r) => Arr.findFirst(r.windows, (w) => w.name === "5h"))
  const w7 = Option.flatMap(current, (r) => Arr.findFirst(r.windows, (w) => w.name === "7d"))
  const heldLive = Option.exists(hold, (h) => h.until > at)
  const live5hLimit = Option.exists(w5, (w) => Option.exists(Option.fromUndefinedOr(w.resetAt), (r) => r > at) && w.utilization >= 0.9)
  const live7dLimit = Option.exists(w7, (w) => Option.exists(Option.fromUndefinedOr(w.resetAt), (r) => r > at) && w.utilization >= 0.99)
  const live7dOverLine = Option.exists(w7, (w) => validWeekWindow(w, at) && Option.exists(Option.fromUndefinedOr(w.resetAt), (r) => w.utilization > lineOf(r, at, {}) + 1e-9))
  const usageSample = Option.flatMap(current, (r) => Option.fromUndefinedOr(r.usage))
  const freshFail =
    hasMeasured(current) &&
    Option.exists(failure, (f) => f.failedAt <= at && at - f.failedAt <= STALE_AFTER_MS && !Option.exists(usageSample, (u) => u.at > f.failedAt))

  // Invariant 2: no hold caused only by failed reads on a measured login.
  if (freshFail && !heldLive && !live5hLimit && !live7dLimit && !live7dOverLine)
    expect([ctx, answer.ok, answer.eligible]).toEqual([ctx, true, ["a"]])

  // Invariant 3: reported limits and 429 holds always bind until their own reset/end.
  if (heldLive || live5hLimit || live7dLimit || live7dOverLine)
    expect([ctx, answer.ok]).toEqual([ctx, false])

  // Invariant 4: unknown or stale-absent 7d is never unlimited (never measured, never bypasses another account's even-line hold).
  const freshAbsent7d = Option.exists(
    Option.flatMap(current, (r) => Option.flatMap(Option.fromUndefinedOr(r.absent), (entries) => Arr.findFirst(entries, (entry) => entry.name === "7d"))),
    (entry) => entry.at <= at && at - entry.at <= STALE_AFTER_MS,
  )
  const hasValidWeek = Option.exists(w7, (w) => validWeekWindow(w, at))
  if (!freshAbsent7d && !hasValidWeek && answer.ok)
    expect([ctx, answer.measured, Option.isNone(Option.fromUndefinedOr(answer.admission))]).toEqual([ctx, false, true])
  if (!freshAbsent7d && !hasValidWeek && !heldLive) {
    const overAccount: AccountStatus = {
      credentialID: "over",
      live: 0,
      load: 0,
      noRoom: false,
      reading: {
        at,
        usage: { at, samples: 1 },
        windows: [
          { name: "5h", utilization: 0.2, resetAt: at + 3 * hour },
          { name: "7d", utilization: 0.7, resetAt: at + 3.5 * day },
        ],
      },
    }
    expect([ctx, dispatchPace([overAccount, account], at, {}, 0.04, OPUS).ok]).toEqual([ctx, false])
  }
}

test("model-based property: generated sequences of readings, failures, idle gaps and resets obey all pace invariants", () => {
  const next = lcg(20261124)
  for (let seq = 0; seq < 160; seq++) {
    let state: ModelState = { at: now, current: Option.none(), hold: Option.none(), failure: Option.none() }
    for (let step = 0; step < 25; step++) {
      const moved = stepModel(state, next)
      state = moved.next
      checkModelInvariants(state, `seq ${seq} step ${step} op ${moved.op}`)
    }
  }
})
