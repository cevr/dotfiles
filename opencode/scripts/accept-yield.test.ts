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

  test("a stopped file stays owed, the land takes the lock, and the resumed run records every verdict", () => {
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
      const transitions: Array<Yield.State> = []
      for (const action of script) {
        const next = Option.getOrThrow(Yield.step(state, action, FILES))
        expect(problems(state, action, next), describeAction(action)).toEqual([])
        transitions.push(next)
        state = next
      }
      return { state, transitions }
    }
    const played = playActions(actions)
    const withoutStop = playActions(actions.slice(0, 5))
    const withoutLand = playActions(actions.slice(0, 7))
    const withoutResume = playActions(actions.slice(0, 9))
    const withoutDeath = playActions(actions.filter((action) => action.kind !== "dies"))
    const stopped = (run: typeof played) => (run.transitions.at(5) ?? run.state).report.get("a")
    assertWitness("interrupted file stays owed", "owed", stopped(played), stopped(withoutStop))
    const phase = (at: number, who: Yield.Who) => played.transitions[at].phase.get(who)
    const holds = (at: number) => played.transitions[at].holder
    assertWitness("deep run starts waiting", "waiting", phase(0, "deep"), Yield.initial().phase.get("deep"))
    assertWitness("deep run takes the lock", Option.some<Yield.Who>("deep"), holds(1), holds(0))
    assertWitness("file starts with the lock held", Option.some("a"), played.transitions[2].running, played.transitions[1].running)
    assertWitness("waiting land leaves a mark", true, played.transitions[4].wanted.has("l1"), played.transitions[3].wanted.has("l1"))
    assertWitness("deep run yields the lock", Option.none(), holds(6), holds(5))
    const landTook = (run: typeof played) => (run.transitions.at(7) ?? run.state).holder
    assertWitness("land holds the lock", Option.some<Yield.Who>("l1"), landTook(played), landTook(withoutLand))
    assertWitness("land ends and releases the lock", "done", phase(8, "l1"), phase(7, "l1"))
    assertWitness("deep run retakes the lock after land", Option.some<Yield.Who>("deep"), holds(9), holds(8))
    const end = (run: typeof played) => ({ over: Yield.over(run.state), report: [...run.state.report] })
    const want = { over: true, report: [["a", "failed"], ["b", "passed"], ["c", "passed"]] }
    assertWitness("resumed run records the failed and passed files", want, end(played), end(withoutResume))
    assertWitness("play finishes only once the other run has died", want, end(played), end(withoutDeath))
    assertWitness("deep run ends after settling all files", "done", played.state.phase.get("deep"), phase(15, "deep"))
  })

  test("the rules the runner follows: who marks, whose wait is on the clock, when the deep run may take or start", () => {
    expect([Yield.marks("land", Option.some("owed")), Yield.marks("land", Option.some("all")), Yield.marks("land", Option.some("land")), Yield.marks("owed", Option.some("owed")), Yield.marks("land", Option.none())]).toEqual([true, true, false, false, false])
    expect([Yield.onClock(Option.some("owed")), Yield.onClock(Option.some("land")), Yield.onClock(Option.none())]).toEqual([true, false, true])
    expect(Yield.liveMarks([10, 11, 12], (pid) => pid !== 11)).toEqual([10, 12])
    expect([Yield.deepMayTake(true, []), Yield.deepMayTake(true, [10]), Yield.deepMayTake(false, [])]).toEqual([true, false, false])
    expect([Yield.deepMayStart([]), Yield.deepMayStart([1])]).toEqual([true, false])
  })
})
