import { Effect, Option } from "effect"
import { type Command, defaultConfig, type SimConfig, type Step } from "./driver.ts"
import { BOUNDARIES, type Fault, faultsAt, FAULTS, makePrng, type Prng } from "./faults.ts"
import {
  clearPrompt,
  crash,
  followUp,
  humanTypes,
  otherPrompt,
  paneExits,
  reattach,
  restart,
  spawn,
  start,
  startNamed,
  startOpts,
  status,
  steer,
  stop,
  wait,
  waitScreen,
} from "./scenarios.ts"
import { DEFAULT_WORLD, type FileMode, type ScreenKind } from "./world.ts"

/**
 * The short trace whose every effect index is an await point for command injection: two workers on one
 * sign-in and one store (SPEC v2 ruling 6) start, w1 finishes turn 1, takes a follow_up and finishes turn 2.
 */
export const CORE: ReadonlyArray<Step> = [
  start("w1", "TK-w1-1"),
  start("w2", "TK-w2-1"),
  waitScreen("w1", "done"),
  wait(60),
  followUp("w1", "TK-w1-2"),
  waitScreen("w1", "done"),
  wait(60),
]

/** The commands injected at every await point, from the first server and from a second one on the same store; start brings a third worker. */
export const INJECTED: ReadonlyArray<{ readonly name: string; readonly commands: (n: number) => ReadonlyArray<Command> }> = [
  { name: "start", commands: (n) => [start("w3", `TK-w3-${100 + n}`)] },
  { name: "follow_up", commands: (n) => [followUp("w1", `TK-w1-${100 + n}`)] },
  { name: "steer", commands: (n) => [steer("w1", `TK-w1-${100 + n}`)] },
  { name: "status", commands: () => [status("w1")] },
  { name: "stop", commands: () => [stop("w1", false)] },
  { name: "stop_close", commands: () => [stop("w1", true)] },
  { name: "restart", commands: (n) => [restart("w1", `TK-w1-${100 + n}`)] },
  { name: "reattach", commands: () => [reattach()] },
  { name: "second:start", commands: (n) => [spawn(2), start("w3", `TK-w3-${100 + n}`, 2)] },
  { name: "second:follow_up", commands: (n) => [spawn(2), followUp("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:steer", commands: (n) => [spawn(2), steer("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:status", commands: () => [spawn(2), status("w1", 2)] },
  { name: "second:stop", commands: () => [spawn(2), stop("w1", false, 2)] },
  { name: "second:stop_close", commands: () => [spawn(2), stop("w1", true, 2)] },
  { name: "second:restart", commands: (n) => [spawn(2), restart("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:reattach", commands: () => [spawn(2), reattach(2)] },
]

/** The script every (boundary, fault) pair run uses: two workers; it reaches every boundary, a crash and a restart included. */
export const PAIR_SCRIPT: ReadonlyArray<Step> = [
  start("w1", "TK-w1-1"),
  start("w2", "TK-w2-1"),
  waitScreen("w1", "done"),
  wait(40),
  followUp("w1", "TK-w1-2"),
  status("w1"),
  waitScreen("w1", "done"),
  wait(40),
  paneExits,
  status("w1"),
  wait(60),
  restart("w1", "TK-w1-3"),
  waitScreen("w1", "done"),
  wait(40),
  crash(1),
  wait(80),
  status("w1"),
  status("w2"),
  stop("w1", true),
]

/** Which call of its boundary a pair's fault goes on: the first, the second and the third are each enumerated. */
export const PAIR_CALLS: ReadonlyArray<number> = [0, 1, 2]

/** One run per (boundary, fault, call): the fault planned at that boundary on its first, second or third call. */
export const pairConfigs = (): ReadonlyArray<SimConfig> =>
  BOUNDARIES.flatMap((boundary) =>
    faultsAt(boundary)
      .filter((fault) => fault !== "ok")
      .flatMap((fault) => PAIR_CALLS.map((nth) => ({ ...defaultConfig(`pair:${boundary}:${fault}#${nth}`, 0), faults: [{ boundary, nth, fault }] }))),
  )

const pick = <A>(prng: Prng, items: ReadonlyArray<A>, fallback: A) => Effect.map(prng.int(items.length), (i) => items[i] ?? fallback)

const FILE_MODES: ReadonlyArray<FileMode> = ["final", "final", "partial", "none", "stale"]
const START_SCREENS: ReadonlyArray<ScreenKind> = ["ready", "ready", "ready", "trust"]

const ACTIONS = ["follow_up", "follow_up", "steer", "status", "stop", "stop_close", "restart", "reattach", "crash", "wait", "wait", "clear", "human", "exits", "second", "prompt"] as const

const actionStep = Effect.fn("Sim.actionStep")(function* (prng: Prng, n: number, proc: number, workers: ReadonlyArray<string>) {
  const action = yield* pick(prng, ACTIONS, "wait")
  const worker = yield* pick(prng, workers, "w1")
  const token = `TK-${worker}-${n}`
  if (action === "follow_up") return [followUp(worker, token, proc, yield* prng.chance(0.3))]
  if (action === "steer") return [steer(worker, token, proc)]
  if (action === "status") return [status(worker, proc)]
  if (action === "stop") return [stop(worker, false, proc)]
  if (action === "stop_close") return [stop(worker, true, proc)]
  if (action === "restart") return [restart(worker, token, proc)]
  if (action === "reattach") return [reattach(proc)]
  if (action === "crash") return [crash(proc)]
  if (action === "clear") return [clearPrompt]
  if (action === "human") return [humanTypes("owner says hello")]
  if (action === "exits") return [paneExits]
  if (action === "second") return [spawn(2), status(worker, 2)]
  if (action === "prompt") return [otherPrompt]
  return [wait(20 + (yield* prng.int(120)))]
})

const either = <A>(flag: boolean, whenTrue: A, whenFalse: A): A => {
  if (flag) return whenTrue
  return whenFalse
}

/** The workers a random script starts: w1 always, a sibling w2 on the same sign-in often, a start in a pane the caller named sometimes. */
const startsOf = Effect.fn("Sim.startsOf")(function* (prng: Prng) {
  const steps: Array<Step> = [either(yield* prng.chance(0.2), startOpts("w1", "TK-w1-1", false), start("w1", "TK-w1-1"))]
  const workers: Array<string> = ["w1"]
  if (yield* prng.chance(0.6)) {
    steps.push(start("w2", "TK-w2-1"))
    workers.push("w2")
  }
  if (yield* prng.chance(0.15)) {
    steps.push(startNamed("named1", "TK-named1-1"))
    workers.push("named1")
  }
  return { steps, workers }
})

/** A seeded random script: a world, the starts, then a run of commands, owner actions, crashes and a second server. */
export const randomConfig = Effect.fn("Sim.randomConfig")(function* (seed: number) {
  const prng = yield* makePrng(seed * 7919 + 13)
  const fileModes: Array<FileMode> = []
  for (let i = 0; i < 8; i++) fileModes.push(yield* pick(prng, FILE_MODES, "final"))
  const splitScreens: ReadonlyArray<ScreenKind> = [yield* pick(prng, START_SCREENS, "ready"), "ready", "ready"]
  const permissionRuns = either(yield* prng.chance(0.2), [2], [])
  const limitRuns = either(yield* prng.chance(0.1), [3], [])
  const twoProcs = yield* prng.chance(0.25)
  const { steps, workers } = yield* startsOf(prng)
  const count = 4 + (yield* prng.int(6))
  if (twoProcs) steps.push(spawn(2))
  for (let n = 2; n < count + 2; n++) {
    const proc = either(twoProcs && (yield* prng.chance(0.4)), 2, 1)
    steps.push(...(yield* actionStep(prng, n, proc, workers)), wait(yield* prng.int(80)))
  }
  const allow: ReadonlyArray<Fault> = FAULTS.filter((fault) => fault !== "ok")
  const config: SimConfig = {
    ...defaultConfig(`seed:${seed}`, seed),
    world: { ...DEFAULT_WORLD, fileModes, splitScreens, permissionRuns, limitRuns },
    random: Option.some({ seed, rate: 0.06, allow }),
  }
  return { config, steps }
})
