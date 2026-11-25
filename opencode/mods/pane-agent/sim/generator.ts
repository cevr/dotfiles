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
  startOpts,
  status,
  steer,
  stop,
  wait,
  waitScreen,
} from "./scenarios.ts"
import { DEFAULT_WORLD, type FileMode, type ScreenKind } from "./world.ts"

/** The short trace whose every effect index is an await point for command injection: start, turn 1, a follow_up, turn 2. */
export const CORE: ReadonlyArray<Step> = [start("w1", "TK-w1-1"), waitScreen("w1", "done"), wait(60), followUp("w1", "TK-w1-2"), waitScreen("w1", "done"), wait(60)]

/** The commands injected at every await point, from the first server and from a second one on the same store. */
export const INJECTED: ReadonlyArray<{ readonly name: string; readonly commands: (n: number) => ReadonlyArray<Command> }> = [
  { name: "follow_up", commands: (n) => [followUp("w1", `TK-w1-${100 + n}`)] },
  { name: "steer", commands: (n) => [steer("w1", `TK-w1-${100 + n}`)] },
  { name: "status", commands: () => [status("w1")] },
  { name: "stop", commands: () => [stop("w1", false)] },
  { name: "stop_close", commands: () => [stop("w1", true)] },
  { name: "restart", commands: (n) => [restart("w1", `TK-w1-${100 + n}`)] },
  { name: "reattach", commands: () => [reattach()] },
  { name: "second:follow_up", commands: (n) => [spawn(2), followUp("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:steer", commands: (n) => [spawn(2), steer("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:status", commands: () => [spawn(2), status("w1", 2)] },
  { name: "second:stop", commands: () => [spawn(2), stop("w1", false, 2)] },
  { name: "second:stop_close", commands: () => [spawn(2), stop("w1", true, 2)] },
  { name: "second:restart", commands: (n) => [spawn(2), restart("w1", `TK-w1-${100 + n}`, 2)] },
  { name: "second:reattach", commands: () => [spawn(2), reattach(2)] },
]

/** The script every (boundary, fault) pair run uses: it reaches every boundary, a crash and a restart included. */
export const PAIR_SCRIPT: ReadonlyArray<Step> = [
  start("w1", "TK-w1-1"),
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
  stop("w1", true),
]

/** Boundaries the pair script reaches only once or twice: their pair fault goes on the first call. */
const RARE: ReadonlyArray<string> = ["process.start", "timer.sleep"]

/** One run per (boundary, fault) pair: the fault planned at the pair's boundary on its second call (rare ones: the first). */
export const pairConfigs = (): ReadonlyArray<SimConfig> =>
  BOUNDARIES.flatMap((boundary) =>
    faultsAt(boundary)
      .filter((fault) => fault !== "ok")
      .map((fault) => ({ ...defaultConfig(`pair:${boundary}:${fault}`, 0), faults: [{ boundary, nth: Number(!RARE.includes(boundary)), fault }] })),
  )

const pick = <A>(prng: Prng, items: ReadonlyArray<A>, fallback: A) => Effect.map(prng.int(items.length), (i) => items[i] ?? fallback)

const FILE_MODES: ReadonlyArray<FileMode> = ["final", "final", "partial", "none", "stale"]
const START_SCREENS: ReadonlyArray<ScreenKind> = ["ready", "ready", "ready", "trust"]

const ACTIONS = ["follow_up", "follow_up", "steer", "status", "stop", "stop_close", "restart", "reattach", "crash", "wait", "wait", "clear", "human", "exits", "second", "prompt"] as const

const actionStep = Effect.fn("Sim.actionStep")(function* (prng: Prng, n: number, proc: number) {
  const action = yield* pick(prng, ACTIONS, "wait")
  const token = `TK-w1-${n}`
  if (action === "follow_up") return [followUp("w1", token, proc, yield* prng.chance(0.3))]
  if (action === "steer") return [steer("w1", token, proc)]
  if (action === "status") return [status("w1", proc)]
  if (action === "stop") return [stop("w1", false, proc)]
  if (action === "stop_close") return [stop("w1", true, proc)]
  if (action === "restart") return [restart("w1", token, proc)]
  if (action === "reattach") return [reattach(proc)]
  if (action === "crash") return [crash(proc)]
  if (action === "clear") return [clearPrompt]
  if (action === "human") return [humanTypes("owner says hello")]
  if (action === "exits") return [paneExits]
  if (action === "second") return [spawn(2), status("w1", 2)]
  if (action === "prompt") return [otherPrompt]
  return [wait(20 + (yield* prng.int(120)))]
})

const either = <A>(flag: boolean, whenTrue: A, whenFalse: A): A => {
  if (flag) return whenTrue
  return whenFalse
}

/** A seeded random script: a world, a start, then a run of commands, owner actions, crashes and a second server. */
export const randomConfig = Effect.fn("Sim.randomConfig")(function* (seed: number) {
  const prng = yield* makePrng(seed * 7919 + 13)
  const fileModes: Array<FileMode> = []
  for (let i = 0; i < 8; i++) fileModes.push(yield* pick(prng, FILE_MODES, "final"))
  const splitScreens: ReadonlyArray<ScreenKind> = [yield* pick(prng, START_SCREENS, "ready"), "ready", "ready"]
  const permissionRuns = either(yield* prng.chance(0.2), [2], [])
  const twoProcs = yield* prng.chance(0.25)
  const steps: Array<Step> = [either(yield* prng.chance(0.2), startOpts("w1", "TK-w1-1", false), start("w1", "TK-w1-1"))]
  const count = 4 + (yield* prng.int(6))
  if (twoProcs) steps.push(spawn(2))
  for (let n = 2; n < count + 2; n++) {
    const proc = either(twoProcs && (yield* prng.chance(0.4)), 2, 1)
    steps.push(...(yield* actionStep(prng, n, proc)), wait(yield* prng.int(80)))
  }
  const allow: ReadonlyArray<Fault> = FAULTS.filter((fault) => fault !== "ok")
  const config: SimConfig = {
    ...defaultConfig(`seed:${seed}`, seed),
    world: { ...DEFAULT_WORLD, fileModes, splitScreens, permissionRuns },
    random: Option.some({ seed, rate: 0.06, allow }),
  }
  return { config, steps }
})
