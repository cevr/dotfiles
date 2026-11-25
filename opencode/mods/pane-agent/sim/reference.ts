// The spec-level reference model. It never imports machine.ts or model.ts: it reads only what a caller
// saw (tool calls and their replies) and decides which turns each worker accepted and what they are owed.
import { Option } from "effect"

export type TurnMode = "start" | "follow_up" | "steer" | "restart"

/** A turn the caller handed to a worker. `certain` is false when the call never answered (crash, hang). */
export interface RefTurn {
  readonly index: number
  readonly token: string
  readonly mode: TurnMode
  readonly acceptedAt: number
  readonly certain: boolean
}

export interface RefOptions {
  readonly skipPermissions: boolean
  readonly addDirs: ReadonlyArray<string>
  readonly cwd: string
}

export interface RefWorker {
  readonly key: string
  readonly id: string
  readonly turns: ReadonlyArray<RefTurn>
  readonly rejected: ReadonlyArray<string>
  readonly stoppedAt: Option.Option<number>
  /** Accepted commands that supersede the open turn (stop, steer, restart): when they were issued and answered. */
  readonly supersedes: ReadonlyArray<{ readonly issuedAt: number; readonly at: number }>
  readonly options: RefOptions
}

/** The slice of a tool call the reference reads: a command, its token, when it was issued and answered, and how. */
export interface RefCall {
  readonly command: string
  readonly worker: string
  readonly token: Option.Option<string>
  readonly issuedAt: number
  readonly at: number
  readonly outcome: string
  readonly workerId: Option.Option<string>
  readonly skipPermissions: boolean
}

export interface Reference {
  readonly workers: ReadonlyMap<string, RefWorker>
  readonly rejected: ReadonlySet<string>
  readonly maybe: ReadonlySet<string>
}

const modeOf = (command: string): TurnMode => {
  if (command === "start") return "start"
  if (command === "steer") return "steer"
  if (command === "restart") return "restart"
  return "follow_up"
}

const TURN_COMMANDS = new Set(["start", "follow_up", "steer", "restart"])

const addTurn = (worker: RefWorker, call: RefCall, token: string, certain: boolean): RefWorker => ({
  ...worker,
  turns: [...worker.turns, { index: worker.turns.length + 1, token, mode: modeOf(call.command), acceptedAt: call.at, certain }],
})

const started = (call: RefCall, id: string, token: string): RefWorker => ({
  key: call.worker,
  id,
  turns: [{ index: 1, token, mode: "start", acceptedAt: call.at, certain: true }],
  rejected: [],
  stoppedAt: Option.none(),
  supersedes: [],
  options: { skipPermissions: call.skipPermissions, addDirs: ["/sim/extra"], cwd: "/sim/repo" },
})

const answered = (outcome: string): boolean => outcome === "success"
const unanswered = (outcome: string): boolean => outcome === "killed" || outcome === "hang" || outcome === "defect"

const SUPERSEDING = new Set(["stop", "stop_close", "steer", "restart"])
const STOPS = new Set(["stop", "stop_close"])

interface Fold {
  readonly workers: Map<string, RefWorker>
  readonly rejected: Set<string>
  readonly maybe: Set<string>
}

const superseding = (fold: Fold, call: RefCall): void => {
  const found = Option.fromUndefinedOr(fold.workers.get(call.worker))
  if (Option.isNone(found) || !SUPERSEDING.has(call.command) || !answered(call.outcome)) return
  const worker = found.value
  const stoppedAt = Option.orElse(Option.some(call.at).pipe(Option.filter(() => STOPS.has(call.command))), () => worker.stoppedAt)
  fold.workers.set(call.worker, { ...worker, stoppedAt, supersedes: [...worker.supersedes, { issuedAt: call.issuedAt, at: call.at }] })
}

const turnCall = (fold: Fold, call: RefCall, token: string): void => {
  if (call.outcome === "failure" || call.outcome === "skipped") fold.rejected.add(token)
  if (unanswered(call.outcome)) fold.maybe.add(token)
  const existing = Option.fromUndefinedOr(fold.workers.get(call.worker))
  if (Option.isNone(existing)) return
  if (answered(call.outcome)) fold.workers.set(call.worker, addTurn(existing.value, call, token, true))
  if (unanswered(call.outcome)) fold.workers.set(call.worker, addTurn(existing.value, call, token, false))
}

const step = (fold: Fold, call: RefCall): void => {
  if (call.command === "start" && answered(call.outcome) && Option.isSome(call.workerId) && Option.isSome(call.token)) {
    fold.workers.set(call.worker, started(call, call.workerId.value, call.token.value))
    return
  }
  superseding(fold, call)
  if (call.command === "start" || !TURN_COMMANDS.has(call.command) || Option.isNone(call.token)) return
  turnCall(fold, call, call.token.value)
}

/** Folds the caller's view of every call, in order, into accepted turns per worker. */
export const referenceOf = (calls: ReadonlyArray<RefCall>): Reference => {
  const fold: Fold = { workers: new Map(), rejected: new Set(), maybe: new Set() }
  for (const call of calls) step(fold, call)
  return fold
}

/** The turn the worker was last handed at a moment, if any. */
export const latestTurnAt = (worker: RefWorker, at: number): Option.Option<RefTurn> =>
  Option.fromUndefinedOr(worker.turns.filter((turn) => turn.acceptedAt <= at).at(-1))

/** Whether every turn up to `index` was surely accepted, so the model's turn numbers are known. */
export const numberingKnown = (worker: RefWorker, index: number): boolean =>
  worker.turns.slice(0, index).every((turn) => turn.certain)
