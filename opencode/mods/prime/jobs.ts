// A session's jobs (the wake mod's long commands, run outside the server) as
// Prime shows them, plain values. The dock's job item while any runs
// (`2 jobs`, gone once none runs, as the shells' count drops an ended shell),
// and the composer panel's Jobs tab (tui/jobs.tsx): one row per job, running
// first, the selected one's log tail under the rows, the detail Enter shows,
// and what an empty tab says. The reading comes from the wake mod's `jobs`
// RPC (opencode/jobs.ts), its kill from `kill`.
import { duration } from "@dotfiles/opencode-subagents/line"
import { Option } from "effect"
import { plural } from "./chrome.ts"

/** One job as the wake server's board shows it (the wake mod's `JobShown`). */
export type JobEntry = {
  readonly id: string
  readonly note: string
  readonly command: string
  readonly cwd: string
  /** Epoch ms. */
  readonly setAt: number
  readonly state: "starting" | "running" | "exited" | "killed" | "timed out" | "lost"
  /** An exited job's code. */
  readonly exitCode: Option.Option<number>
  readonly startedAt: Option.Option<number>
  readonly endedAt: Option.Option<number>
  /** The end of its log. */
  readonly logTail: string
}

/** What Prime reads of a session's jobs: the wake server's clock when it answered, and the jobs, running first. */
export type Jobs = { readonly now: number; readonly jobs: ReadonlyArray<JobEntry> }

/** What the Jobs tab says with no job. */
export const NO_JOBS = "No jobs"

/** How many lines of the selected job's log the tab shows under its rows. */
export const TAIL_LINES = 4

/** The jobs a reading lists; none before the first. */
export const jobsOf = (reading: Option.Option<Jobs>): ReadonlyArray<JobEntry> => Option.match(reading, { onNone: () => [], onSome: (jobs) => jobs.jobs })

/** Whether the job still runs: starting or running. */
export const runs = (job: Pick<JobEntry, "state">) => job.state === "starting" || job.state === "running"

/** How many of the jobs run. */
export const runningJobs = (jobs: ReadonlyArray<Pick<JobEntry, "state">>): number => jobs.filter(runs).length

/** The dock's job item: `1 job`, `2 jobs`; none while no job runs. */
export const jobItem = (running: number): Option.Option<string> => Option.liftPredicate(running, (count) => count > 0).pipe(Option.map((count) => plural(count, "job")))

/** Its state in the words `job({ action: "list" })` uses: `running`, `exited 2`, `killed`, `timed out`. */
export function jobState(job: Pick<JobEntry, "state" | "exitCode">): string {
  if (job.state !== "exited") return job.state
  return `exited ${Option.getOrElse(Option.map(job.exitCode, String), () => "?")}`
}

/** How long it has run, or ran: from its start (else when it was set) to its end (else `now`). */
export const jobElapsed = (job: Pick<JobEntry, "setAt" | "startedAt" | "endedAt">, now: number): string =>
  duration(Option.getOrElse(job.endedAt, () => now) - Option.getOrElse(job.startedAt, () => job.setAt))

/** The last `count` lines of its log with text in them. */
export const logLines = (logTail: string, count = TAIL_LINES): ReadonlyArray<string> =>
  logTail
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-count)

/** What Enter shows for a job: a title and the whole of it. */
export function jobDetail(job: JobEntry, now: number) {
  const log = Option.liftPredicate(job.logTail.trimEnd(), (text) => text.trim() !== "")
  return {
    title: `Job ${job.id}`,
    message: [
      `Command: ${job.command}`,
      `In: ${job.cwd}`,
      `State: ${jobState(job)} · ${jobElapsed(job, now)}`,
      "",
      `Note: ${job.note}`,
      "",
      Option.getOrElse(log, () => "(no output yet)"),
    ].join("\n"),
  }
}
