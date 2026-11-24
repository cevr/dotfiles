// A model-based test of the accept lock's protocol (scripts/accept-yield.ts, the model in
// notes/accept-lock.qnt): a seeded generator draws, among the actions the step function enables,
// one deep run's and two land runs' moves, deaths at any moment included, and files that end red;
// after every command the model's five invariants hold, a file stopped by a yield or a death gains no
// pass and is reported owed, and once every run has ended or died each file is passed, failed or
// owed, exactly one. A failure names the seed and the command.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { assertWitness } from "../sim/witnesses.ts"
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

  test("W: a stopped file stays owed, the land takes the lock, and the resumed run records every verdict", () => {
    const actions: ReadonlyArray<Yield.Action> = [
      { kind: "start", who: "deep" }, { kind: "deepTakes" }, { kind: "deepStartsFile", file: "a" },
      { kind: "start", who: "l1" }, { kind: "mark", who: "l1" }, { kind: "deepStops" }, { kind: "deepYields" },
      { kind: "landTakes", who: "l1" }, { kind: "landEnds", who: "l1" }, { kind: "deepTakes" },
      { kind: "deepStartsFile", file: "a" }, { kind: "deepFileEnds", green: false },
      { kind: "deepStartsFile", file: "b" }, { kind: "deepFileEnds", green: true },
      { kind: "deepStartsFile", file: "c" }, { kind: "deepFileEnds", green: true },
      { kind: "dies", who: "l2" }, { kind: "deepEnds" },
    ]
    const playActions = (script: ReadonlyArray<Yield.Action>) => {
      let state = Yield.initial()
      for (const action of script) {
        const next = Option.getOrThrow(Yield.step(state, action, FILES))
        expect(problems(state, action, next), describeAction(action)).toEqual([])
        state = next
      }
      return state
    }
    const phase = (who: Yield.Who) => (state: Yield.State) => state.phase.get(who)
    const holds = (state: Yield.State) => state.holder
    const end = (state: Yield.State) => ({ over: Yield.over(state), report: [...state.report] })
    const want = { over: true, report: [["a", "failed"], ["b", "passed"], ["c", "passed"]] }
    const before = <A>(name: string, at: number, expected: A, observe: (state: Yield.State) => A) =>
      ({ name, expected, run: (cause: boolean) => observe(playActions(actions.slice(0, at + Number(cause)))) })
    const cases = [
      before("interrupted file stays owed", 5, "owed", (state) => state.report.get("a")),
      before("deep run starts waiting", 0, "waiting", phase("deep")),
      before("deep run takes the lock", 1, Option.some<Yield.Who>("deep"), holds),
      before("file starts with the lock held", 2, Option.some("a"), (state) => state.running),
      before("waiting land leaves a mark", 4, true, (state) => state.wanted.has("l1")),
      before("deep run yields the lock", 6, Option.none(), holds),
      before("land holds the lock", 7, Option.some<Yield.Who>("l1"), holds),
      before("land ends and releases the lock", 8, "done", phase("l1")),
      before("deep run retakes the lock after land", 9, Option.some<Yield.Who>("deep"), holds),
      { name: "resumed run records the failed and passed files", expected: want, run: (cause: boolean) => {
        if (cause) return end(playActions(actions))
        return end(playActions(actions.slice(0, 9)))
      } },
      { name: "play finishes only once the other run has died", expected: want, run: (cause: boolean) => end(playActions(actions.filter((action) => cause || action.kind !== "dies"))) },
      { name: "deep run ends after settling all files", expected: "done", run: (cause: boolean) => phase("deep")(playActions(actions.filter((action) => cause || action.kind !== "deepEnds"))) },
    ]
    const ran: Array<string> = []
    for (const each of cases) ran.push(assertWitness(each.name, each.expected, each.run))
    expect(ran.toSorted()).toEqual(cases.map((each) => each.name).toSorted())
  })

  test("the rules the runner follows: who marks, whose wait is on the clock, when the deep run may take or start", () => {
    expect([Yield.marks("land", Option.some("owed")), Yield.marks("land", Option.some("all")), Yield.marks("land", Option.some("land")), Yield.marks("owed", Option.some("owed")), Yield.marks("land", Option.none())]).toEqual([true, true, false, false, false])
    expect([Yield.onClock(Option.some("owed")), Yield.onClock(Option.some("land")), Yield.onClock(Option.none())]).toEqual([true, false, true])
    expect(Yield.liveMarks([10, 11, 12], (pid) => pid !== 11)).toEqual([10, 12])
    expect([Yield.deepMayTake(true, []), Yield.deepMayTake(true, [10]), Yield.deepMayTake(false, [])]).toEqual([true, false, false])
    expect([Yield.deepMayStart([]), Yield.deepMayStart([1])]).toEqual([true, false])
  })
})
