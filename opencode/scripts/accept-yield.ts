// The machine's accept lock between a deep run and land runs (notes/accept-lock.qnt): the rules
// scripts/accept.ts follows, and the same rules as a pure step function over the model's state,
// which scripts/accept-yield.test.ts drives.
//
// One lock, an flock that ends with its holder. A land run that finds a run of another mode
// holding it sets a wanted mark carrying its own pid (`<lock>.wanted/<pid>`), cleared when it
// takes the lock or exits; a mark whose pid is dead counts as unset. The deep run (`owed`, `all`)
// starts no file while a live mark is set, stops the files it runs, gives the lock up, and takes it
// again only when it is free and no live mark is set. A file stopped by a yield or a death stays
// owed: it never passes and never fails.
import { Array as Arr, Option } from "effect"
import type { Mode } from "./accept-ledger.ts"

/** How often a deep run looks for a live mark, and a land run for the free lock. */
export const POLL_MS = 250
/** How long a deep run may take from a live mark to the lock given up. */
export const YIELD_MS = 5000
/** How long a stopped file's processes get after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 3000

/** Whether a run of `mode` gives the lock up to a land run: the deep runs do, a land run never. */
export const yields = (mode: Mode): boolean => mode !== "land"

/** Whether a run of `mode` that finds `holder` holding the lock sets a wanted mark: a land run behind a yielding run. */
export const marks = (mode: Mode, holder: Option.Option<Mode>): boolean => mode === "land" && Option.exists(holder, yields)

/** Whether the time a run waits behind `holder` counts on its own clock: all of it, except behind another land run (that one ends inside its own 60 s). */
export const onClock = (holder: Option.Option<Mode>): boolean => !Option.exists(holder, (mode) => mode === "land")

/** The marks whose setter still lives; a dead setter's mark counts as unset. */
export const liveMarks = (pids: ReadonlyArray<number>, alive: (pid: number) => boolean): ReadonlyArray<number> => pids.filter(alive)

/** Whether a deep run may take the free lock: only with no live mark set. */
export const deepMayTake = (free: boolean, live: ReadonlyArray<number>): boolean => free && live.length === 0

/** Whether a deep run holding the lock may start a file: only with no live mark set. */
export const deepMayStart = (live: ReadonlyArray<number>): boolean => live.length === 0

// ---- The model: the rules above as a step function over notes/accept-lock.qnt's state.

/** A run in the model: the deep run, or one of two land runs. */
export type Who = "deep" | "l1" | "l2"
export const LANDS: ReadonlyArray<Who> = ["l1", "l2"]
export const RUNS: ReadonlyArray<Who> = ["deep", "l1", "l2"]

export type Phase = "idle" | "waiting" | "holding" | "done" | "dead"

/** How a file ended in the deep run, last word first: a stopped file is owed. */
export type Status = "passed" | "failed" | "owed"

export interface State {
  readonly holder: Option.Option<Who>
  readonly phase: ReadonlyMap<Who, Phase>
  /** The land runs whose wanted mark is set (alive or not). */
  readonly wanted: ReadonlySet<Who>
  readonly running: Option.Option<string>
  /** The files with a pass in the ledger. */
  readonly passed: ReadonlySet<string>
  /** The files that ended red: no pass, never run again in this deep run. */
  readonly failed: ReadonlySet<string>
  /** Files whose run was stopped (a yield or a death) in their current attempt. */
  readonly stopped: ReadonlySet<string>
  /** Files that ended green in an attempt that was not stopped. */
  readonly finished: ReadonlySet<string>
  /** Each file's last outcome in the deep run's report. */
  readonly report: ReadonlyMap<string, Status>
  /** Steps the deep run took holding the lock with a live mark set. */
  readonly heldWhileWanted: number
}

export const YIELD_BOUND = 2

export type Action =
  | { readonly kind: "start"; readonly who: Who }
  | { readonly kind: "mark"; readonly who: Who }
  | { readonly kind: "landTakes"; readonly who: Who }
  | { readonly kind: "landEnds"; readonly who: Who }
  | { readonly kind: "deepTakes" }
  | { readonly kind: "deepStartsFile"; readonly file: string }
  | { readonly kind: "deepFileEnds"; readonly green: boolean }
  | { readonly kind: "deepStops" }
  | { readonly kind: "deepYields" }
  | { readonly kind: "deepEnds" }
  | { readonly kind: "dies"; readonly who: Who }

const IDLE: Phase = "idle"

export const initial = (): State => ({
  holder: Option.none(),
  phase: new Map(RUNS.map((who) => [who, IDLE])),
  wanted: new Set(),
  running: Option.none(),
  passed: new Set(),
  failed: new Set(),
  stopped: new Set(),
  finished: new Set(),
  report: new Map(),
  heldWhileWanted: 0,
})

const phaseOf = (state: State, who: Who): Phase => Option.getOrElse(Option.fromUndefinedOr(state.phase.get(who)), (): Phase => "dead")
const alive = (state: State) => (who: Who) => phaseOf(state, who) !== "dead"
const withPhase = (state: State, who: Who, phase: Phase) => new Map([...state.phase, [who, phase]])
const isLand = (who: Who) => LANDS.includes(who)
const holds = (state: State, who: Who) => Option.exists(state.holder, (each) => each === who)
const free = (state: State) => Option.isNone(state.holder)

/** The pids of the marks: a land run's name stands for its pid in the model. */
export const liveWanted = (state: State): ReadonlyArray<Who> => [...state.wanted].filter(alive(state))

/** What the holder runs, as the runner reads it from the owner file: the deep run is `owed`, a land run `land`. */
const holderMode = (state: State): Option.Option<Mode> => Option.map(state.holder, (who): Mode => (isLand(who) && "land") || "owed")

/** The files the deep run has not settled yet: neither passed nor failed. */
export const unsettled = (state: State, files: ReadonlyArray<string>): ReadonlyArray<string> => files.filter((file) => !state.passed.has(file) && !state.failed.has(file))

const without = <A>(set: ReadonlySet<A>, item: A) => new Set([...set].filter((each) => each !== item))
const withItem = <A>(set: ReadonlySet<A>, item: A) => new Set([...set, item])
const reported = (state: State, file: string, status: Status) => new Map([...state.report, [file, status]])
const live = (state: State) => liveWanted(state).map((who) => RUNS.indexOf(who))

/** The deep run's step count while it holds the lock with a live mark set. */
const counted = (state: State) => state.heldWhileWanted + Number(live(state).length > 0)

/** The file the deep run runs, stopped: owed in the report, with its stop recorded. */
const cut = (state: State, file: string): State => ({ ...state, running: Option.none(), stopped: withItem(state.stopped, file), report: reported(state, file, "owed") })

/** One action of the model, when it is enabled. */
export const step = (state: State, action: Action, files: ReadonlyArray<string>): Option.Option<State> => {
  switch (action.kind) {
    case "start":
      return Option.liftPredicate({ ...state, phase: withPhase(state, action.who, "waiting") }, () => phaseOf(state, action.who) === "idle")
    case "mark":
      return Option.liftPredicate(
        { ...state, wanted: withItem(state.wanted, action.who) },
        () => isLand(action.who) && phaseOf(state, action.who) === "waiting" && marks("land", holderMode(state)) && !state.wanted.has(action.who),
      )
    case "landTakes":
      return Option.liftPredicate(
        { ...state, holder: Option.some(action.who), phase: withPhase(state, action.who, "holding"), wanted: without(state.wanted, action.who) },
        () => isLand(action.who) && phaseOf(state, action.who) === "waiting" && free(state),
      )
    case "landEnds":
      return Option.liftPredicate({ ...state, holder: Option.none(), phase: withPhase(state, action.who, "done") }, () => isLand(action.who) && holds(state, action.who))
    case "deepTakes":
      return Option.liftPredicate(
        { ...state, holder: Option.some<Who>("deep"), phase: withPhase(state, "deep", "holding"), heldWhileWanted: 0 },
        () => phaseOf(state, "deep") === "waiting" && deepMayTake(free(state), live(state)),
      )
    case "deepStartsFile":
      return Option.liftPredicate(
        { ...state, running: Option.some(action.file), stopped: without(state.stopped, action.file) },
        () => holds(state, "deep") && Option.isNone(state.running) && deepMayStart(live(state)) && unsettled(state, files).includes(action.file),
      )
    case "deepFileEnds":
      return Option.flatMap(Option.filter(state.running, () => holds(state, "deep")), (file): Option.Option<State> => {
        const ended: State = { ...state, running: Option.none(), heldWhileWanted: counted(state) }
        if (action.green) return Option.some({ ...ended, passed: withItem(state.passed, file), finished: withItem(state.finished, file), report: reported(state, file, "passed") })
        return Option.some({ ...ended, failed: withItem(state.failed, file), report: reported(state, file, "failed") })
      })
    case "deepStops":
      return Option.map(
        Option.filter(state.running, () => holds(state, "deep") && live(state).length > 0),
        (file) => ({ ...cut(state, file), heldWhileWanted: state.heldWhileWanted + 1 }),
      )
    case "deepYields":
      return Option.liftPredicate(
        { ...state, holder: Option.none(), phase: withPhase(state, "deep", "waiting"), heldWhileWanted: 0 },
        () => holds(state, "deep") && Option.isNone(state.running) && live(state).length > 0,
      )
    case "deepEnds":
      return Option.liftPredicate(
        { ...state, holder: Option.none(), phase: withPhase(state, "deep", "done"), heldWhileWanted: 0 },
        () => holds(state, "deep") && Option.isNone(state.running) && unsettled(state, files).length === 0,
      )
    case "dies":
      return Option.liftPredicate(dead(state, action.who), () => phaseOf(state, action.who) !== "dead" && phaseOf(state, action.who) !== "done")
  }
}

/** A run dies: the kernel frees its lock; the deep run's file is cut and owed; a land run's mark is dead with it. */
const dead = (state: State, who: Who): State => {
  const gone = { ...state, phase: withPhase(state, who, "dead"), holder: Option.filter(state.holder, (each) => each !== who) }
  if (who !== "deep") return gone
  return Option.match(state.running, { onNone: () => ({ ...gone, heldWhileWanted: 0 }), onSome: (file) => ({ ...cut(gone, file), heldWhileWanted: 0 }) })
}

/** Every action the model offers, over `files`; `step` says which are enabled. */
export const actions = (files: ReadonlyArray<string>): ReadonlyArray<Action> => [
  ...RUNS.flatMap((who): ReadonlyArray<Action> => [
    { kind: "start", who },
    { kind: "mark", who },
    { kind: "landTakes", who },
    { kind: "landEnds", who },
    { kind: "dies", who },
  ]),
  { kind: "deepTakes" },
  ...files.map((file): Action => ({ kind: "deepStartsFile", file })),
  { kind: "deepFileEnds", green: true },
  { kind: "deepFileEnds", green: false },
  { kind: "deepStops" },
  { kind: "deepYields" },
  { kind: "deepEnds" },
]

/** The model's invariants (notes/accept-lock.qnt's `safe`), each with its name when broken. */
export const broken = (state: State): ReadonlyArray<string> => {
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["oneHolder", RUNS.every((who) => (phaseOf(state, who) === "holding") === holds(state, who)) && Option.match(state.holder, { onNone: () => true, onSome: alive(state) })],
    ["runsUnderLock", Option.isNone(state.running) || holds(state, "deep")],
    ["passesAreFinished", [...state.passed].every((file) => state.finished.has(file))],
    ["runningNotStopped", !Option.exists(state.running, (file) => state.stopped.has(file))],
    ["yieldsSoon", state.heldWhileWanted <= YIELD_BOUND],
  ]
  return Arr.filter(checks, ([, kept]) => !kept).map(([name]) => name)
}

/** Whether every run has ended or died. */
export const over = (state: State): boolean => RUNS.every((who) => ["done", "dead"].includes(phaseOf(state, who)))
