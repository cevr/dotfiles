import { Data, Option } from "effect"
import { type Record } from "./record.ts"
import { onTarget, type Target } from "./target.ts"

/** What one update run does. */
export type Plan = Data.TaggedEnum<{
  /** The origin names no verified target yet. */
  NoTarget: {}
  /** The installed build is the target's. */
  Current: { readonly target: Target }
  /** Build the target and restart onto it. */
  Update: { readonly target: Target }
}>
export const Plan = Data.taggedEnum<Plan>()

/** The run's plan: the target against the installed record. A host with no record installs. */
export const plan = (target: Option.Option<Target>, record: Option.Option<Record>): Plan => {
  if (Option.isNone(target)) return Plan.NoTarget()
  const installed = { dotfiles: Option.flatMapNullishOr(record, (each) => each.dotfiles), fork: Option.flatMapNullishOr(record, (each) => each.fork) }
  if (onTarget(installed, target.value)) return Plan.Current({ target: target.value })
  return Plan.Update({ target: target.value })
}

/**
 * Runs, coalesced: one at a time, and a request while one runs asks for one more run after it,
 * however many came. The next run reads the newest target, so every target in between collapses
 * into it.
 */
export interface Runs {
  readonly running: boolean
  readonly again: boolean
}

export const IDLE: Runs = { running: false, again: false }

/** A request: start a run now, or mark one more after the running one. */
export const ask = (runs: Runs): readonly [start: boolean, next: Runs] => {
  if (runs.running) return [false, { running: true, again: true }]
  return [true, { running: true, again: false }]
}

/** A run ended: run again when a request came meanwhile. */
export const ended = (runs: Runs): readonly [again: boolean, next: Runs] => {
  if (runs.again) return [true, { running: true, again: false }]
  return [false, IDLE]
}

/**
 * While a built target waits for the gate, a newer target supersedes it: the run ends, and the
 * next one builds the newer target ahead of the restart.
 */
export const superseded = (waiting: Target, latest: Option.Option<Target>): boolean =>
  Option.exists(latest, (target) => target.dotfiles !== waiting.dotfiles || target.fork !== waiting.fork)
