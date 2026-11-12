import { Data, Duration, Option, Schema } from "effect"
import { buildOf, goodOf, type Record, stagedOf } from "./record.ts"
import type { Target } from "./target.ts"

/**
 * A target this host failed on, kept in the update's own directory (`rejected.json`): the step that
 * failed (`advance`, `build`, `health`) and why. The host never builds or restarts onto it again;
 * a target with other commits clears it.
 */
export const Rejected = Schema.Struct({ dotfiles: Schema.String, fork: Schema.String, step: Schema.String, cause: Schema.String })
export interface Rejected extends Schema.Schema.Type<typeof Rejected> {}

/** Two builds or targets name the same commits. */
export const sameCommits = (a: { readonly dotfiles: string; readonly fork: string }, b: { readonly dotfiles: string; readonly fork: string }): boolean =>
  a.dotfiles === b.dotfiles && a.fork === b.fork

/** The rejection of `target`, when the one kept names its commits. */
export const rejectionOf = (target: Target, rejected: Option.Option<Rejected>): Option.Option<Rejected> =>
  Option.filter(rejected, (each) => sameCommits(each, target))

/**
 * The mark of a running handoff, `handoff.json` in the update's own directory: its process and
 * when it began (epoch ms). The handoff holds it from before it names the staged build installed
 * until it ends, so no check restarts the service under it.
 */
export const Running = Schema.Struct({ pid: Schema.Number, at: Schema.Number })
export interface Running extends Schema.Schema.Type<typeof Running> {}

/**
 * The longest a handoff runs: three restarts with their health reads (`HEALTH_DEADLINE` each), a
 * reinstall and a rollback's install. A mark older than this is stale, whatever its pid.
 */
export const HANDOFF_LIMIT = Duration.minutes(20)

/**
 * The handoff that runs, from its mark: one whose process lives and which began within
 * `HANDOFF_LIMIT`. A mark whose process is gone (a killed handoff, a reboot) or which is too old
 * (a reused pid) holds nothing.
 */
export const runningOf = (mark: Option.Option<Running>, alive: boolean, now: number): Option.Option<Running> =>
  Option.filter(mark, (each) => alive && now - each.at < Duration.toMillis(HANDOFF_LIMIT))

/** What one update run does. */
export type Plan = Data.TaggedEnum<{
  /** A handoff runs: no check builds or restarts until it ends. */
  HandingOff: { readonly running: Running }
  /** The origin names no verified target yet. */
  NoTarget: {}
  /** The installed build is the target's, and its health check proved it. */
  Current: { readonly target: Target }
  /** The host failed on this target before: nothing runs until another target comes. */
  Rejected: { readonly target: Target; readonly rejected: Rejected }
  /** The target's build is staged, or installed without its proof: restart onto it, through the health check. */
  Restart: { readonly target: Target }
  /** Build the target and restart onto it. */
  Update: { readonly target: Target }
}>
export const Plan = Data.taggedEnum<Plan>()

/**
 * The run's plan: the target against the installed record and the rejected target. A handoff
 * that runs holds every run. A build is current only once proven: installed and good. A host with
 * no record installs.
 */
export const plan = (target: Option.Option<Target>, record: Option.Option<Record>, rejected: Option.Option<Rejected>, running: Option.Option<Running>): Plan => {
  if (Option.isSome(running)) return Plan.HandingOff({ running: running.value })
  if (Option.isNone(target)) return Plan.NoTarget()
  const wanted = target.value
  const failed = rejectionOf(wanted, rejected)
  if (Option.isSome(failed)) return Plan.Rejected({ target: wanted, rejected: failed.value })
  const on = (build: Option.Option<{ readonly dotfiles: string; readonly fork: string }>) => Option.exists(build, (each) => sameCommits(each, wanted))
  const installed = Option.flatMap(record, buildOf)
  if (on(installed) && on(Option.flatMap(record, goodOf))) return Plan.Current({ target: wanted })
  if (on(installed) || on(Option.flatMap(record, stagedOf))) return Plan.Restart({ target: wanted })
  return Plan.Update({ target: wanted })
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
