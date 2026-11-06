// Jobs: a long command a session starts outside the OpenCode server, so it
// outlives a restart, and whose end wakes the session. The wakes keep the job
// as an entry of its own kind (`Job` in wake.ts) and fire a letter when it
// ends, from the server's poll, from the runner's own call when the command
// exits (the wakes' `due`, through the OS backstop's script), or at the next
// start when it ended while no server ran. This file is what the runner keeps
// beside a job and what it reads back: the spec it runs, how the process
// ended, and how a job's run reads at a time. It imports nothing of wake.ts.
import { Schema } from "effect"

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
})
export type JobExit = typeof JobExit.Type

/**
 * A job's run at one time:
 * - `starting`: launched, its runner not yet up.
 * - `running`: its runner is alive.
 * - `ended`: its runner recorded the exit.
 * - `lost`: no exit was recorded and no runner is alive (the machine restarted, or the runner was killed), or it never started.
 */
export type Run =
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly startedAt: number }
  | { readonly state: "ended"; readonly exit: JobExit }
  | { readonly state: "lost"; readonly startedAt?: number; readonly why: string }

/** What the runner reads of one job: its spec, its run, and where its log and progress file are. */
export interface JobRecord {
  readonly spec: JobSpec
  readonly run: Run
  readonly log: string
  readonly drip: string
  /** The systemd unit it runs in, on Linux. */
  readonly unit?: string | undefined
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
/** A launched job whose runner is not up this long after it was set never started. */
export const START_GRACE_MS = 30_000
/** How often a server looks at a running job: its end, and its progress. The runner's own call is the fast path. */
export const JOB_POLL_MS = 10_000
/** Progress lines reach the session at most this often; the rest wait for the next, or the end letter. */
export const DRIP_MS = 60_000
/** A wait looks this often. */
export const WAIT_POLL_MS = 1_000
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

/** The run as the wakes read it at `now`: a job still starting past its grace never started. */
export const settledRun = (run: Run | undefined, setAt: number, now: number): Run => {
  if (run === undefined) return now - setAt > START_GRACE_MS ? { state: "lost", why: "it never started: the runner left no record" } : { state: "starting" }
  if (run.state === "starting" && now - setAt > START_GRACE_MS) return { state: "lost", why: "it never started: its runner did not come up" }
  return run
}

export const over = (run: Run): run is Extract<Run, { readonly state: "ended" | "lost" }> => run.state === "ended" || run.state === "lost"

/** The last `max` lines of progress text. */
export const lastLines = (text: string, max = DRIP_LINES): string => {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  return lines.slice(-max).join("\n")
}
