// A model-based test of the accept lock's protocol (scripts/accept-yield.ts, the model in
// notes/accept-lock.qnt): a seeded generator draws, among the actions the step function enables,
// one deep run's and two land runs' moves, deaths at any moment included, and files that end red;
// after every command the model's five invariants hold, a file stopped by a yield or a death gains no
// pass and is reported owed, and once every run has ended or died each file is passed, failed or
// owed, exactly one. A failure names the seed and the command.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as Yield from "./accept-yield.ts"

const SEEDS = 200
const COMMANDS = 60
const FILES = ["a", "b", "c"]

/** A small seeded generator (mulberry32). */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const describeAction = (action: Yield.Action) => Object.values(action).join(" ")

/** The problems after one command: the invariants, and what a stop or a death owes. */
const problems = (before: Yield.State, action: Yield.Action, after: Yield.State): ReadonlyArray<string> => {
  const found: Array<string> = [...Yield.broken(after)]
  const cut = action.kind === "deepStops" || (action.kind === "dies" && action.who === "deep")
  Option.map(
    Option.filter(before.running, () => cut),
    (file) => {
      if (after.passed.has(file) !== before.passed.has(file)) found.push(`stopped ${file} gained a pass`)
      if (after.report.get(file) !== "owed") found.push(`stopped ${file} is reported ${String(after.report.get(file))}, not owed`)
    },
  )
  return found
}

/** At the end: each file has exactly one of passed, failed and owed (a file never run is owed). */
const accounted = (state: Yield.State): ReadonlyArray<string> =>
  FILES.flatMap((file) => {
    const status = Option.getOrElse(Option.fromUndefinedOr(state.report.get(file)), () => "owed")
    const is = { passed: state.passed.has(file), failed: state.failed.has(file) }
    const ok = (status === "passed" && is.passed && !is.failed) || (status === "failed" && is.failed && !is.passed) || (status === "owed" && !is.passed && !is.failed)
    if (ok) return []
    return [`${file} ended ${status} with passed=${is.passed} failed=${is.failed}`]
  })

const play = (seed: number) => {
  const draw = random(seed)
  let state = Yield.initial()
  for (let command = 1; command <= COMMANDS; command++) {
    const enabled = Yield.actions(FILES).flatMap((action) => Option.toArray(Option.map(Yield.step(state, action, FILES), (next) => ({ action, next }))))
    if (enabled.length === 0) break
    const chosen = enabled[Math.floor(draw() * enabled.length)]!
    const found = problems(state, chosen.action, chosen.next)
    if (found.length > 0) return [`seed ${seed}, command ${command} (${describeAction(chosen.action)}): ${found.join("; ")}`]
    state = chosen.next
  }
  // Every run that is still going ends or dies, so the report is whole.
  const ended = Yield.RUNS.reduce((each, who) => Option.getOrElse(Yield.step(each, { kind: "dies", who }, FILES), () => each), state)
  if (!Yield.over(ended)) return [`seed ${seed}: runs still going after every death`]
  return accounted(ended).map((line) => `seed ${seed}, at the end: ${line}`)
}

describe("the accept lock's protocol", () => {
  test(`${SEEDS} seeded runs of up to ${COMMANDS} commands keep the five invariants and account for every file`, () => {
    const found = Array.from({ length: SEEDS }, (_, index) => play(index + 1)).flat()
    expect(found).toEqual([])
  })

  test("the generator reaches yields, stops, deaths and red files", () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= SEEDS; seed++) {
      const draw = random(seed)
      let state = Yield.initial()
      for (let command = 1; command <= COMMANDS; command++) {
        const enabled = Yield.actions(FILES).flatMap((action) => Option.toArray(Option.map(Yield.step(state, action, FILES), (next) => ({ action, next }))))
        if (enabled.length === 0) break
        const chosen = enabled[Math.floor(draw() * enabled.length)]!
        seen.add(describeAction(chosen.action).replace(/ (deep|l1|l2|a|b|c)$/, "").replace("deepFileEnds", "ends"))
        state = chosen.next
      }
    }
    expect([...seen].sort()).toEqual(["deepEnds", "deepStartsFile", "deepStops", "deepTakes", "deepYields", "dies", "ends false", "ends true", "landEnds", "landTakes", "mark", "start"])
  })

  test("the rules the runner follows: who marks, whose wait is on the clock, when the deep run may take or start", () => {
    expect([Yield.marks("land", Option.some("owed")), Yield.marks("land", Option.some("all")), Yield.marks("land", Option.some("land")), Yield.marks("owed", Option.some("owed")), Yield.marks("land", Option.none())]).toEqual([true, true, false, false, false])
    expect([Yield.onClock(Option.some("owed")), Yield.onClock(Option.some("land")), Yield.onClock(Option.none())]).toEqual([true, false, true])
    expect(Yield.liveMarks([10, 11, 12], (pid) => pid !== 11)).toEqual([10, 12])
    expect([Yield.deepMayTake(true, []), Yield.deepMayTake(true, [10]), Yield.deepMayTake(false, [])]).toEqual([true, false, false])
    expect([Yield.deepMayStart([]), Yield.deepMayStart([1])]).toEqual([true, false])
  })
})
