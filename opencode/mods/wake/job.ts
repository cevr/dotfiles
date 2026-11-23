// Jobs: a long command a session starts outside the OpenCode server, so it
// outlives a restart, and whose end wakes the session. The wakes keep the job
// as an entry of its own kind (`Job` in wake.ts) and fire a letter when it
// ends: on the runner's own call once it recorded the exit (the wakes' `due`,
// through the OS backstop's script), at the next start when it ended while no
// server ran or the call was lost, or at the wakes' one recovery sweep, which
// also finds a runner gone without an exit. Nothing looks at a running job on
// a timer of its own. This file is what the runner keeps beside a job and what
// it reads back: the spec it runs, how the process ended, and how a job's run
// reads at a time. It imports nothing of wake.ts.
import { Option, Schema } from "effect"
import { Disposition, type Slot } from "./job-event.ts"

/** What the runner runs and keeps beside the job, so a check reads it after the entry went. */
export const JobSpec = Schema.Struct({
  /** `j` and six base-36 characters. */
  id: Schema.String,
  /** The session that started it: the one its letter wakes. */
  sessionID: Schema.String,
  /** The directory whose server arms its entry. */
  directory: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  note: Schema.String,
  /** Run at a lower CPU priority (`nice -n 10`). */
  heavy: Schema.Boolean,
  /** Past this the runner stops the command. */
  timeoutSeconds: Schema.Number,
  /** Epoch ms. */
  setAt: Schema.Number,
  /** Which run of the job this is (job-event.ts); absent in an older build's spec, which reads as legacy. */
  generation: Schema.optional(Schema.Number),
})
export type JobSpec = typeof JobSpec.Type

/** How the command ended, as its runner recorded it. */
export const JobExit = Schema.Struct({
  /** The exit code; null when a signal ended it. */
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.optional(Schema.String),
  /** Epoch ms. */
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  /** It ran past its timeout and the runner stopped it. */
  timedOut: Schema.Boolean,
  /** `job({ action: "kill" })` (or another signal to its runner) stopped it. */
  killed: Schema.Boolean,
  /** The end's kind, as this build's runner records it (job-event.ts); an older runner's exit has none and reads off the fields above. */
  disposition: Schema.optional(Disposition),
  generation: Schema.optional(Schema.Number),
  /** The end's place among the job's events: one past the progress bytes written when it was recorded. */
  sequence: Schema.optional(Schema.Number),
})
export type JobExit = typeof JobExit.Type

/**
 * A job's run at one time:
 * - `starting`: launched, its runner not yet up.
 * - `running`: its runner is alive.
 * - `ended`: its runner recorded the exit.
 * - `lost`: no exit was recorded and the runner that claimed it is gone (`runner-gone`: the machine restarted, or it
 *   was killed; the command may have run, and is never run again), or the wakes retired it before any runner claimed it
 *   (`never-started`: its launch slot holds the retirement, so no runner runs it after).
 */
export type Run =
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly startedAt: number }
  | { readonly state: "ended"; readonly exit: JobExit }
  | { readonly state: "lost"; readonly startedAt?: number; readonly why: string; readonly cause?: "runner-gone" | "never-started" }

/** What the runner reads of one job: its spec, its run, and where its log and progress file are. */
export interface JobRecord {
  readonly spec: JobSpec
  readonly run: Run
  readonly log: string
  readonly drip: string
  /** The systemd unit it runs in, on Linux. */
  readonly unit?: string | undefined
  /** Its delivery record's newest slot; none before its end was claimed. */
  readonly delivery?: Slot | undefined
}

/** How a launch went: where its log and progress file are, and what it runs under. */
export interface Launched {
  readonly log: string
  readonly drip: string
  /** `systemd`: a transient user unit; `detached`: its own session and process group. */
  readonly how: "systemd" | "detached"
  readonly unit?: string | undefined
  /** Why it is detached where a unit was wanted. */
  readonly warning?: string | undefined
}

// ── Limits ──

export const DEFAULT_JOB_TIMEOUT_SECONDS = 24 * 60 * 60
export const MAX_JOB_TIMEOUT_SECONDS = 7 * 24 * 60 * 60
/** A launched job whose runner is not up this long after it was set is retired, unless a runner claimed it first. */
export const START_GRACE_MS = 30_000
/**
 * How often the wakes' one recovery sweep looks at the jobs of its directory while any runs: a runner gone without
 * an exit, a launch that never came up, an end whose runner's call was lost, and progress to drip. An end whose call
 * arrives goes at once; this bounds the rest.
 */
export const RECOVER_MS = 60_000
/** Progress lines reach the session at most this often; the rest wait for the next, or the end letter. */
export const DRIP_MS = 60_000
export const DEFAULT_WAIT_MS = 10 * 60 * 1000
export const MAX_WAIT_MS = 60 * 60 * 1000
/** How long a kill waits for the runner to record the end. */
export const KILL_WAIT_MS = 15_000
/** The runner stops the command with SIGTERM, then SIGKILL after this long. */
export const KILL_GRACE_MS = 10_000
/** The most of a job's log a letter or a check carries. */
export const LOG_TAIL = 3000
/** The most progress lines a letter or a check carries. */
export const DRIP_LINES = 20

/** The systemd unit a job runs in on Linux. */
export const unitOf = (id: string): string => `opencode-job-${id}`

/** A job the wakes retired before any runner claimed it: it never started, and never will. */
export const NEVER_STARTED: Run = { state: "lost", why: "it never started: no runner claimed it before the wakes retired it", cause: "never-started" }

/** The run as the wakes read it: one with no record yet is starting. Only the launch slot says a job never started (its retirement won it). */
export const runOrStarting = (run: Run | undefined): Run => run ?? { state: "starting" }

/** Whether a starting job is past its grace at `now`, so the wakes try to retire it; the launch slot decides whether they did. */
export const overdue = (run: Run, setAt: number, now: number): boolean => run.state === "starting" && now - setAt > START_GRACE_MS

export const over = (run: Run): run is Extract<Run, { readonly state: "ended" | "lost" }> => run.state === "ended" || run.state === "lost"

// ── What the TUI shows ──

/** How long an ended job stays on the TUI's board after its end. */
export const ENDED_SHOWN_MS = 30 * 60 * 1000
/** The most ended jobs a session's board keeps; the running ones always show. */
export const ENDED_SHOWN = 10
/** How much of each job's log the board carries: the end. */
export const BOARD_TAIL = 2000

/**
 * One job as the TUI's dock and Jobs tab read it: what it runs, and how it
 * stands in a word (`starting`, `running`, `exited` with its code, `killed`,
 * `timed out`, `lost`), with its times and its log's tail.
 */
export const JobShown = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  note: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  /** Epoch ms. */
  setAt: Schema.Number,
  state: Schema.Literals(["starting", "running", "exited", "killed", "timed out", "lost"]),
  /** An exited job's code. */
  exitCode: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  logTail: Schema.String,
})
export type JobShown = typeof JobShown.Type

type ShownRun = Pick<JobShown, "state" | "exitCode" | "startedAt" | "endedAt">

/** How an ended run reads: timed out, killed (by a kill, or a signal), or exited with its code. */
const endedRun = (exit: JobExit): ShownRun => {
  const times = { startedAt: exit.startedAt, endedAt: exit.endedAt }
  if (exit.timedOut) return { state: "timed out", ...times }
  return Option.fromNullishOr(exit.exitCode).pipe(
    Option.filter(() => !exit.killed),
    Option.match({ onNone: (): ShownRun => ({ state: "killed", ...times }), onSome: (exitCode): ShownRun => ({ state: "exited", exitCode, ...times }) }),
  )
}

/** The board's word for a run, with the times it knows. */
const shownRun = (run: Run): ShownRun => {
  switch (run.state) {
    case "starting":
      return { state: "starting" }
    case "running":
      return { state: "running", startedAt: run.startedAt }
    case "lost":
      return { state: "lost", startedAt: run.startedAt }
    case "ended":
      return endedRun(run.exit)
  }
}

/** How a job that runs no more ended, as a clause: `it exited 2`, `it was killed`, `it timed out`, `it was lost`. */
export const endWords = (shown: Pick<JobShown, "state" | "exitCode">): string => {
  switch (shown.state) {
    case "exited":
      return `it exited ${shown.exitCode}`
    case "timed out":
      return "it timed out"
    case "lost":
      return "it was lost"
    case "killed":
      return "it was killed"
    case "starting":
    case "running":
      return `it is ${shown.state}`
  }
}

/** A job as the board shows it: its spec, its run as the wakes read it now, its log's tail. */
export const jobShownOf = (spec: JobSpec, run: Run, logTail: string): JobShown => ({
  id: spec.id,
  sessionID: spec.sessionID,
  note: spec.note,
  command: spec.command,
  cwd: spec.cwd,
  setAt: spec.setAt,
  ...shownRun(run),
  logTail,
})

/** The last `max` lines of progress text. */
export const lastLines = (text: string, max = DRIP_LINES): string => {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  return lines.slice(-max).join("\n")
}
