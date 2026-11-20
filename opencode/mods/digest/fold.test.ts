import { describe, expect, test } from "bun:test"
import { Match, Option, Predicate } from "effect"
import { DigestEvent, encodeLine, VERSION } from "./event.ts"
import { EMPTY, fold, type State } from "./fold.ts"
import { encodePage, pageOf } from "./messages.ts"

/** A seeded generator (mulberry32): the same cases on every run. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}
const CASES = 300

const pick =
  (next: () => number) =>
  <A>(values: ReadonlyArray<A>): A =>
    values[Math.floor(next() * values.length)] ?? values[0]!

/** A generated event: few roots, units and ids, few distinct times, so keys and times collide often. */
const eventOf = (next: () => number): DigestEvent => {
  const one = pick(next)
  const base = { v: VERSION, t: Math.floor(next() * 6), root: one(["r1", "r2"]) }
  const unit = one(["alpha", "beta", "gamma"])
  const round = one([1, 2])
  return one([
    () => DigestEvent.cases.Run.make({ ...base, host: one(["mac", "box"]), repo: "demo", dir: Option.none(), name: Option.some(one(["demo", "other"])) }),
    () => DigestEvent.cases.Lane.make({ ...base, unit, purpose: Option.some(one(["Bill once", "Bill twice"])), branch: Option.none(), path: Option.none() }),
    () => DigestEvent.cases.Start.make({ ...base, session: one(["s1", "s2"]), role: "implementor", unit, round }),
    () => DigestEvent.cases.HandBack.make({ ...base, session: "s1", role: "implementor", unit, round, verdict: one(["ready", "blocked"]), file: Option.none(), digest: Option.some(one(["Done.", "Half done."])) }),
    () => DigestEvent.cases.Verdict.make({ ...base, session: "s3", batch: "batch-a", round: 1, verdict: one(["accepted", "changes"]), file: Option.none(), digest: Option.none(), units: [{ unit, round, verdict: one(["accepted", "changes"]) }] }),
    () => DigestEvent.cases.Land.make({ ...base, units: [unit], pushed: Option.none() }),
    () => DigestEvent.cases.Check.make({ ...base, ok: next() < 0.5, text: one(["the accept check passed.", "the accept check FAILED."]) }),
    () => DigestEvent.cases.Item.make({ ...base, id: one(["i1", "i2"]), text: one(["Ship it.", "Wait."]), state: one(["running", "done", "needs-you"]), owner: "mine", who: Option.none(), level: Option.some(one(["red", "green"] as const)), unit: Option.some(unit) }),
    () => DigestEvent.cases.ItemGone.make({ ...base, id: one(["i1", "i2"]) }),
    () => DigestEvent.cases.Asked.make({ ...base, session: "s1", id: one(["q1", "q2"]), question: "Which?", header: Option.none(), options: ["a", "b"], assume: "a" }),
    () => DigestEvent.cases.Answered.make({ ...base, session: "s1", id: one(["q1", "q2"]), answer: one(["a", "b"]), matches: next() < 0.5, question: Option.none(), assume: Option.none() }),
    () => DigestEvent.cases.Closed.make({ ...base, session: "s1", id: "q2", reason: "withdrawn" }),
    () => DigestEvent.cases.Install.make({ v: VERSION, t: base.t, host: "mac", outcome: one(["proven", "rolled-back"]), build: Option.none(), said: Option.none(), repo: Option.some("demo") }),
  ])()
}

const logOf = (next: () => number): ReadonlyArray<DigestEvent> => Array.from({ length: Math.floor(next() * 40) }, () => eventOf(next))

const textOf = (value: DigestEvent | number): string => Match.value(value).pipe(Match.when(Predicate.isNumber, String), Match.orElse(encodeLine))

/** A state as plain sorted text, so two states compare by what they hold. */
const canonical = (state: State) =>
  Object.fromEntries(
    Object.entries(state).map(([name, map]: [string, ReadonlyMap<string, DigestEvent | number>]) => [
      name,
      [...map.entries()].map(([key, value]) => `${key}=${textOf(value)}`).toSorted(),
    ]),
  )

const shuffled = <A>(values: ReadonlyArray<A>, next: () => number): ReadonlyArray<A> =>
  values
    .map((value) => ({ value, at: next() }))
    .toSorted((a, b) => a.at - b.at)
    .map((each) => each.value)

describe("fold", () => {
  test("fold(a ++ b) is fold(a) then b", () => {
    const next = random(1)
    for (let at = 0; at < CASES; at++) {
      const [a, b] = [logOf(next), logOf(next)]
      expect(canonical(fold(fold(EMPTY, a), b))).toEqual(canonical(fold(EMPTY, [...a, ...b])))
    }
  })

  test("the order of the lines does not matter, nor a line read twice", () => {
    const next = random(2)
    for (let at = 0; at < CASES; at++) {
      const log = logOf(next)
      const once = canonical(fold(EMPTY, log))
      expect(canonical(fold(EMPTY, shuffled(log, next)))).toEqual(once)
      expect(canonical(fold(EMPTY, [...log, ...shuffled(log, next)]))).toEqual(once)
    }
  })

  test("the newest fact under a key wins; an item remembers when it was first written", () => {
    const item = (t: number, text: string) =>
      DigestEvent.cases.Item.make({ v: VERSION, t, root: "r", id: "i", text, state: "running", owner: "mine", who: Option.none(), level: Option.none(), unit: Option.none() })
    const state = fold(EMPTY, [item(5, "later"), item(2, "first"), item(3, "middle")])
    const kept = [...state.items.values()][0]
    expect(kept?._tag === "Item" && kept.text).toBe("later")
    expect([...state.itemsSince.values()]).toEqual([2])
  })

  test("the page does not depend on the lines' order either, ties in the same millisecond included", () => {
    const next = random(4)
    const reader = { names: new Map<string, string>() }
    for (let at = 0; at < CASES; at++) {
      const log = logOf(next)
      expect(encodePage(pageOf(fold(EMPTY, shuffled(log, next)), reader))).toBe(encodePage(pageOf(fold(EMPTY, log), reader)))
    }
  })

  test("leaves the state it folds from as it was", () => {
    const next = random(3)
    const before = fold(EMPTY, logOf(next))
    const snapshot = canonical(before)
    fold(before, logOf(next))
    expect(canonical(before)).toEqual(snapshot)
  })
})
