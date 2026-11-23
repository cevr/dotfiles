// A job's end as a typed event: what the runner recorded, read back as one
// value with a stable identity, so whoever delivers it (the wakes' letter, an
// owner's `wait`, `park` or `kill`) hands over the same thing once.
//
// - Identity: the job's id and its generation (one run of its spec: a job is
//   never run again, so a job started by this build is generation 1; a spec
//   from an older build has none and reads as legacy). `sequence` orders a
//   job's events: progress at its spool offset, the end after every byte of
//   progress the runner had written when it recorded the exit.
// - Disposition: the end's kind, each distinct: `succeeded` (exit 0),
//   `failed` (another exit code), `spawn-failed` (the command never started),
//   `signalled` (a signal nobody here sent), `timed-out`, `cancelled` (a kill),
//   `lost` (its runner is gone with no exit recorded: it may have run, and is
//   never run again) and `never-started` (no runner ever claimed it).
// - Log: an opaque handle (`job-log:<id>/<generation>`) the owner's session
//   reads through `job({ action: "check" })`; it names no path.
//
// The runner's claim (runner.json) is here too: who runs the job, by an
// identity a reused pid does not match. The runner writes it once, exclusively,
// before it starts the command, so a second runner for the same job finds it
// and runs nothing.
import { Match, Option, Schema } from "effect"
import type { JobExit, JobSpec, Run } from "./job.ts"

export const JOB_EVENT_VERSION = 1

export const Disposition = Schema.Literals(["succeeded", "failed", "spawn-failed", "signalled", "timed-out", "cancelled", "lost", "never-started"])
export type Disposition = typeof Disposition.Type

/** A job's end, as its letter's metadata and an owner's answer carry it. */
export const JobEvent = Schema.Struct({
  version: Schema.Literal(JOB_EVENT_VERSION),
  job: Schema.String,
  generation: Schema.Number,
  sequence: Schema.Number,
  disposition: Disposition,
  /** Epoch ms: when it ended, or when its loss was seen. */
  at: Schema.Number,
  /** The exit code; null for a signal, a loss or a command that never started. */
  exitCode: Schema.NullOr(Schema.Number),
  /** The opaque log handle. */
  log: Schema.String,
})
export type JobEvent = typeof JobEvent.Type

const JOB_ID = /^j[0-9a-z]{6}$/

/** Whether `id` is a job id: `j` and six base-36 characters, nothing a path could be made of. */
export const isJobID = (id: string): boolean => JOB_ID.test(id)

/** A job's log handle. */
export const logRef = (id: string, generation: number): string => `job-log:${id}/${generation}`

/** The job and generation a log handle names; none for anything else (a path, another scheme, a traversal). */
export const logRefOf = (ref: string): Option.Option<{ readonly id: string; readonly generation: number }> =>
  Option.fromNullishOr(/^job-log:(j[0-9a-z]{6})\/([1-9][0-9]{0,6})$/.exec(ref)).pipe(Option.map((found) => ({ id: found[1] ?? "", generation: Number(found[2]) })))

/** A spec as the event reads it: its id, and its generation when it has one. */
type Generated = Pick<JobSpec, "id" | "generation">

/** The generation a spec's job runs as: an older build's spec has none, and reads as the first. */
export const generationOf = (spec: Pick<JobSpec, "generation">): number => spec.generation ?? 1

/** The disposition an exit record says, its own when it carries one, else read off its fields (an older runner's). */
export const dispositionOfExit = (exit: JobExit): Disposition =>
  Option.getOrElse(Option.fromNullishOr(exit.disposition), () =>
    Match.value(exit).pipe(
      Match.when({ timedOut: true }, (): Disposition => "timed-out"),
      Match.when({ killed: true }, (): Disposition => "cancelled"),
      Match.when({ exitCode: 0 }, (): Disposition => "succeeded"),
      Match.when({ exitCode: Match.number }, (): Disposition => "failed"),
      Match.orElse((): Disposition => "signalled"),
    ),
  )

/** The end a run is, or none while it is starting or running. */
export const dispositionOf = (run: Run): Option.Option<Disposition> =>
  Match.value(run).pipe(
    Match.discriminatorsExhaustive("state")({
      ended: (ended) => Option.some(dispositionOfExit(ended.exit)),
      lost: (lost): Option.Option<Disposition> => Option.some(Match.value(lost.cause).pipe(Match.when("never-started", (): Disposition => "never-started"), Match.orElse((): Disposition => "lost"))),
      starting: () => Option.none(),
      running: () => Option.none(),
    }),
  )

/** The exit a run recorded, when it ended. */
const exitOf = (run: Run): Option.Option<JobExit> =>
  Match.value(run).pipe(
    Match.discriminatorsExhaustive("state")({
      ended: (ended) => Option.some(ended.exit),
      lost: () => Option.none(),
      starting: () => Option.none(),
      running: () => Option.none(),
    }),
  )

/** The end event of a run that is over, at `seen` for a loss; none while it runs. */
export const terminalOf = (spec: Generated, run: Run, seen: number): Option.Option<JobEvent> =>
  Option.map(dispositionOf(run), (disposition) => {
    const generation = generationOf(spec)
    const exit = exitOf(run)
    return {
      version: JOB_EVENT_VERSION,
      job: spec.id,
      generation,
      sequence: Option.getOrElse(Option.flatMapNullishOr(exit, (value) => value.sequence), () => Number.MAX_SAFE_INTEGER),
      disposition,
      at: Option.match(exit, { onNone: () => seen, onSome: (value) => value.endedAt }),
      exitCode: Option.match(exit, { onNone: () => Option.none<number>(), onSome: (value) => Option.fromNullishOr(value.exitCode) }).pipe(Option.getOrNull),
      log: logRef(spec.id, generation),
    }
  })

/** Who runs a job: the runner's pid, when it came up, and its process's start as `ps` reads it (absent from an older runner, or when `ps` could not say). */
export const RunnerClaim = Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.Number,
  /** The process's start time as `ps -o lstart=` prints it: a pid reused by another process starts at another time. */
  start: Schema.optional(Schema.String),
})
export type RunnerClaim = typeof RunnerClaim.Type
