// The three states of a usage window (REPORTED, ABSENT, UNKNOWN), over every
// combination of them on the 5-hour and weekly windows, every use level that
// binds or not, with and without a fresh usage read: what the pace may and may
// not do with each. The provider decoders map each answer's shape to these
// states (mods/anthropic-auth/quota.test.ts, chatgpt/usage.test.ts); here
// the pace reads only the states.
import { expect, test } from "bun:test"
import { Array as Arr, Match, Option, Schema } from "effect"
import { dispatchPace, poolPace, type Pace, UNREAD_RETRY_MS } from "./pace.ts"
import { Absent, carryOver, type QuotaReading, type QuotaWindow, Reported, windowReading } from "./quota.ts"
import type { AccountStatus } from "./status.ts"

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
const describe = (state: State) => Match.value(state).pipe(Match.tag("Reported", ({ use }) => `reported at ${use}`), Match.orElse(({ _tag }) => _tag))
const cases = Arr.cartesian(Arr.cartesian(statesOf("5h"), statesOf("7d")), [true, false])

/** Every hold names a future, finite time to ask again. */
const futureRetry = (answer: Pace) =>
  Match.value(answer).pipe(Match.when({ ok: false }, (held) => Number.isFinite(held.retryAt) && held.retryAt > now), Match.orElse(() => true))

test("every combination of the three states, both windows, with and without a usage read: the pace's rules hold", () => {
  for (const [[short, week], usage] of cases) {
    const account = accountOf("a", readingOf(short, week, usage))
    const answer = dispatchPace([account], now, {}, 0.04, OPUS)
    const advisory = poolPace([account], now)
    const label = `5h ${describe(short)}, 7d ${describe(week)}, usage read: ${usage}`
    expect([label, futureRetry(answer), futureRetry(advisory)]).toEqual([label, true, true])
    const anyReported = short._tag === "Reported" || week._tag === "Reported"
    const spent = reported(short, (use) => use >= 0.9) || reported(week, (use) => use >= 0.99)
    // An UNKNOWN window waits for one usage read only; ABSENT never waits.
    const waits = !usage && (short._tag === "Unknown" || week._tag === "Unknown")
    const expected = Match.value({ waits, spent, past: reported(week, (use) => use === 0.7) }).pipe(
      Match.when({ waits: true }, () => ({ ok: false, reasonCode: "usage-unread" })),
      Match.when({ spent: true }, () => ({ ok: false, reasonCode: "quota-limit" })),
      Match.when({ past: true }, () => ({ ok: false, reasonCode: "even-line" })),
      Match.orElse(() => ({ ok: true, eligible: ["a"] })),
    )
    expect([label, answer]).toMatchObject([label, expected])
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
